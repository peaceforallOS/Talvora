/**
 * Port Access — makes the server's ports reachable from the internet when it sits behind a router
 *
 * If the server has no public IPv4 of its own (home/office network), it asks the router via UPnP
 * (Internet Gateway Device) to forward each required port to this machine, renews the forwards
 * while running and removes them on shutdown. It also learns the router's public IP that way.
 * When the router cannot do it, the status says exactly which ports to forward by hand.
 */

const dgram = require('dgram');
const http = require('http');
const os = require('os');
const net = require('net');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const DISCOVERY_MS = 3000;
const LEASE_SECONDS = 3600;
const RENEW_MS = 20 * 60 * 1000;
const WAN_SERVICES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1'
];

function isPrivateIPv4(ip) {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function isPublicIPv4(ip) {
  if (!net.isIPv4(ip) || isPrivateIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return !(a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224);
}

function localIPv4s() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(c => c.family === 'IPv4' && !c.internal)
    .map(c => c.address);
}

function httpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, timeout: timeoutMs }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('router did not answer')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function xmlValue(xml, tag) {
  const match = new RegExp(`<(?:\\w+:)?${tag}>([^<]*)</(?:\\w+:)?${tag}>`, 'i').exec(xml);
  return match ? match[1].trim() : null;
}

/**
 * Minimal UPnP Internet Gateway Device client
 */
class UpnpGateway {
  constructor({ controlUrl, serviceType, name, localAddress }) {
    this.controlUrl = controlUrl;
    this.serviceType = serviceType;
    this.name = name;
    this.localAddress = localAddress; // this machine's address on the router's network
  }

  // Find the router: SSDP search, then read its description for the WAN connection service
  static async discover({ timeoutMs = DISCOVERY_MS } = {}) {
    const locations = await new Promise(resolve => {
      const found = new Set(); // description URLs of the routers that answered
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const search = Buffer.from([
        'M-SEARCH * HTTP/1.1',
        `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
        'MAN: "ssdp:discover"',
        'MX: 2',
        'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
        '', ''
      ].join('\r\n'));
      socket.on('message', message => {
        const location = /^location:\s*(\S+)/im.exec(message.toString());
        if (location) found.add(location[1]);
      });
      socket.on('error', () => resolve(found));
      socket.bind(() => socket.send(search, SSDP_PORT, SSDP_ADDRESS));
      setTimeout(() => {
        socket.close();
        resolve(found);
      }, timeoutMs);
    });

    for (const location of locations) {
      try {
        const { body } = await httpRequest(location);
        const services = [...body.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map(m => ({
          serviceType: xmlValue(m[1], 'serviceType'),
          controlURL: xmlValue(m[1], 'controlURL')
        }));
        const service = WAN_SERVICES.map(type => services.find(s => s.serviceType === type)).find(Boolean);
        if (!service) continue;
        const base = new URL(location);
        const name = [xmlValue(body, 'manufacturer'), xmlValue(body, 'modelName')].filter(Boolean).join(' ') || base.hostname;
        // The local address that reaches the router is the one forwards must point to
        const localAddress = localIPv4s().find(ip => sameSubnet24(ip, base.hostname)) || localIPv4s()[0];
        return new UpnpGateway({ controlUrl: new URL(service.controlURL, base).href, serviceType: service.serviceType, name, localAddress });
      } catch (e) {
        // try the next answer
      }
    }
    return null;
  }

  async soap(action, args = {}) {
    const params = Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
    const body = '<?xml version="1.0"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      `<s:Body><u:${action} xmlns:u="${this.serviceType}">${params}</u:${action}></s:Body></s:Envelope>`;
    const res = await httpRequest(this.controlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${this.serviceType}#${action}"` },
      body
    });
    if (res.status !== 200) {
      const code = xmlValue(res.body, 'errorCode');
      const err = new Error(xmlValue(res.body, 'errorDescription') || `router answered ${res.status}`);
      err.code = code ? Number(code) : res.status;
      throw err;
    }
    return res.body;
  }

  async externalIp() {
    return xmlValue(await this.soap('GetExternalIPAddress'), 'NewExternalIPAddress');
  }

  async addPortMapping(protocol, port, lease) {
    const args = {
      NewRemoteHost: '',
      NewExternalPort: port,
      NewProtocol: protocol,
      NewInternalPort: port,
      NewInternalClient: this.localAddress,
      NewEnabled: 1,
      NewPortMappingDescription: `Talvora ${protocol} ${port}`,
      NewLeaseDuration: lease
    };
    try {
      await this.soap('AddPortMapping', args);
    } catch (err) {
      // 725: this router only supports permanent forwards
      if (err.code !== 725 || lease === 0) throw err;
      await this.soap('AddPortMapping', { ...args, NewLeaseDuration: 0 });
    }
  }

  deletePortMapping(protocol, port) {
    return this.soap('DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: protocol });
  }
}

function sameSubnet24(a, b) {
  return net.isIPv4(a) && net.isIPv4(b) && a.split('.').slice(0, 3).join('.') === b.split('.').slice(0, 3).join('.');
}

/**
 * Keeps the required ports forwarded and reports what is reachable
 */
class PortAccess {
  /**
   * @param {object} opts
   * @param {{protocol: 'TCP'|'UDP', port: number, purpose: string}[]} opts.ports  needed right away
   * @param {{protocol: 'UDP', from: number, to: number, purpose: string}[]} [opts.ranges]  forwarded in the background
   */
  constructor({ ports, ranges = [], enabled = true, discover = UpnpGateway.discover, log = console.log }) {
    this.ports = ports;
    this.ranges = ranges;
    this.enabled = enabled;
    this.discoverGateway = discover;
    this.log = log;
    this.gateway = null;
    this.forwarded = new Set(); // "TCP:443"
    this.failed = new Map(); // "TCP:443" -> reason
    this.status = { behindRouter: false, method: 'none', router: null, publicIp: null, localIp: localIPv4s()[0] || null };
    this.timer = null;
  }

  allPorts() {
    const expanded = this.ranges.flatMap(r =>
      Array.from({ length: r.to - r.from + 1 }, (_, i) => ({ protocol: r.protocol, port: r.from + i, purpose: r.purpose })));
    return [...this.ports, ...expanded];
  }

  /**
   * Called before the server starts listening: forwards the main ports and learns the public IP.
   * The media relay range is forwarded afterwards in the background.
   */
  async start() {
    const ownPublic = localIPv4s().find(isPublicIPv4);
    if (ownPublic) {
      // Directly on the internet (e.g. a VPS): only the host/cloud firewall matters
      this.status = { ...this.status, behindRouter: false, method: 'direct', publicIp: ownPublic };
      return this.status;
    }
    this.status.behindRouter = true;
    if (!this.enabled) {
      this.status.method = 'disabled';
      return this.status;
    }

    try {
      this.gateway = await this.discoverGateway();
    } catch (e) {
      this.gateway = null;
    }
    if (!this.gateway) {
      this.status.method = 'manual';
      this.log(`Ports: no router with UPnP found. To reach this server from the internet, forward these ports to ${this.status.localIp}: ${this.describeNeeded()}`);
      return this.status;
    }

    this.status.method = 'upnp';
    this.status.router = this.gateway.name;
    this.status.localIp = this.gateway.localAddress;
    try {
      const ip = await this.gateway.externalIp();
      this.status.publicIp = isPublicIPv4(ip) ? ip : null;
      if (ip && !isPublicIPv4(ip)) {
        this.log(`Ports: the router's own internet address (${ip}) is not public (carrier-grade NAT): ` +
          'people outside your network cannot reach this server directly. A VPS or a domain with a tunnel is needed for that.');
      }
    } catch (e) {
      // keep going: forwards may still work
    }

    await this.forward(this.ports);
    this.log(`Ports: router ${this.gateway.name} forwards ${this.forwarded.size}/${this.ports.length} main ports to ${this.gateway.localAddress}` +
      (this.status.publicIp ? ` (public address ${this.status.publicIp})` : ''));
    this.forwardRangesInBackground();
    this.timer = setInterval(() => this.renew(), RENEW_MS);
    this.timer.unref();
    return this.status;
  }

  async forward(list) {
    for (const { protocol, port } of list) {
      const key = `${protocol}:${port}`;
      try {
        await this.gateway.addPortMapping(protocol, port, LEASE_SECONDS);
        this.forwarded.add(key);
        this.failed.delete(key);
      } catch (err) {
        this.forwarded.delete(key);
        this.failed.set(key, err.code === 718 ? 'already forwarded to another device' : err.message);
      }
    }
  }

  forwardRangesInBackground() {
    const relayPorts = this.allPorts().slice(this.ports.length);
    if (!relayPorts.length) return;
    this.forward(relayPorts).then(() => {
      const ok = relayPorts.filter(p => this.forwarded.has(`${p.protocol}:${p.port}`)).length;
      this.log(`Ports: media relay ports forwarded: ${ok}/${relayPorts.length}`);
    });
  }

  async renew() {
    if (this.gateway) await this.forward(this.allPorts());
  }

  // Remove our forwards from the router (on shutdown)
  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (!this.gateway) return;
    const keys = [...this.forwarded];
    this.forwarded.clear();
    await Promise.all(keys.map(key => {
      const [protocol, port] = key.split(':');
      return this.gateway.deletePortMapping(protocol, Number(port)).catch(() => {});
    }));
  }

  describeNeeded() {
    const parts = this.ports.map(p => `${p.port}/${p.protocol.toLowerCase()}`);
    for (const r of this.ranges) parts.push(`${r.from}-${r.to}/${r.protocol.toLowerCase()}`);
    return parts.join(', ');
  }

  // Summary for the admin panel and connection-info.json
  report() {
    const items = [...this.ports.map(p => ({ ...p, label: `${p.port}/${p.protocol.toLowerCase()}` })),
      ...this.ranges.map(r => ({ ...r, label: `${r.from}-${r.to}/${r.protocol.toLowerCase()}` }))];
    return {
      ...this.status,
      ports: items.map(item => {
        const keys = item.from ? Array.from({ length: item.to - item.from + 1 }, (_, i) => `${item.protocol}:${item.from + i}`) : [`${item.protocol}:${item.port}`];
        const forwarded = keys.filter(k => this.forwarded.has(k)).length;
        const firstFailure = keys.map(k => this.failed.get(k)).find(Boolean) || null;
        let state;
        if (!this.status.behindRouter) state = 'direct';
        else if (this.status.method === 'disabled') state = 'disabled';
        else if (this.status.method !== 'upnp') state = 'manual';
        else if (forwarded === keys.length) state = 'forwarded';
        else if (forwarded > 0 || (!firstFailure && item.from)) state = 'partial';
        else state = 'failed';
        return { label: item.label, purpose: item.purpose, state, error: state === 'failed' || state === 'partial' ? firstFailure : null };
      })
    };
  }
}

PortAccess.UpnpGateway = UpnpGateway;
PortAccess.isPublicIPv4 = isPublicIPv4;
module.exports = PortAccess;
