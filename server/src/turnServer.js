/**
 * Embedded TURN Relay — lets peers exchange audio/video when they cannot reach each other
 * directly (different networks, strict NAT, firewalls, unresolvable mDNS addresses).
 *
 * Built on node-turn, with fixes for its gaps: allocation refreshes, relay socket cleanup,
 * per-participant credentials, a per-participant allocation quota and a peer address filter.
 */

const crypto = require('crypto');
const net = require('net');
const os = require('os');
const Turn = require('node-turn');
const SendMethod = require('node-turn/lib/methods/send');
const ChannelBindMethod = require('node-turn/lib/methods/channelBind');
const Allocation = require('node-turn/lib/allocation');
const ChannelMessage = require('node-turn/lib/channelMessage');
const Transport = require('node-turn/lib/transport');
const Address = require('node-turn/lib/address');
const TURN_CONSTANTS = require('node-turn/lib/constants');

const TURN_PORT = process.env.TURN_PORT === undefined ? 3478 : parseInt(process.env.TURN_PORT, 10);
const MIN_RELAY_PORT = parseInt(process.env.TURN_MIN_PORT, 10) || 49152;
const MAX_RELAY_PORT = parseInt(process.env.TURN_MAX_PORT, 10) || 49452;
const DEFAULT_LIFETIME = 600; // seconds, RFC 5766 default
const MAX_LIFETIME = 3600;
const MAX_ALLOCATIONS_PER_USER = 40; // a full-mesh call needs about one per peer, plus ICE restarts

// Never relay to unspecified, link-local or multicast addresses
function isForbiddenPeer(address) {
  if (!net.isIP(address)) return true;
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return isForbiddenPeer(lower.slice(7));
  if (net.isIPv4(lower)) {
    const [a, b] = lower.split('.').map(Number);
    return a === 0 || (a === 169 && b === 254) || a >= 224;
  }
  return lower === '::' || lower.startsWith('fe80:') || lower.startsWith('ff');
}

// Addresses of this machine (refreshed periodically: Send indications arrive per media packet)
let ownAddresses = new Set();
let ownAddressesAt = 0;
function isOwnAddress(address) {
  const lower = String(address).toLowerCase().replace(/^::ffff:/, '');
  if (lower === '::1' || lower.startsWith('127.')) return true;
  if (Date.now() - ownAddressesAt > 30000) {
    ownAddresses = new Set(Object.values(os.networkInterfaces()).flat().map(c => c.address.toLowerCase()));
    ownAddressesAt = Date.now();
  }
  return ownAddresses.has(lower);
}

class TurnRelay {
  constructor() {
    this.enabled = TURN_PORT > 0;
    this.port = TURN_PORT;
    this.minPort = MIN_RELAY_PORT;
    this.maxPort = MAX_RELAY_PORT;
    this.server = null;
    this.credentials = new Map(); // participant id -> { username, password }
  }

  start() {
    if (!this.enabled) return;
    const relay = this;
    const turn = new Turn({
      listeningPort: this.port,
      minPort: this.minPort,
      maxPort: this.maxPort,
      authMech: 'long-term',
      realm: 'videocall',
      // Public address to advertise when the server sits behind NAT with forwarded ports
      externalIps: process.env.TURN_EXTERNAL_IP || null,
      debugLevel: process.env.TURN_DEBUG_LEVEL || 'FATAL',
      log: msg => console.warn(`TURN relay: ${msg}`)
    });

    // node-turn's Refresh handler reads these two settings but never defines them, which
    // made every refresh expire the allocation and cut relayed calls after ~10 minutes
    turn.defaultLifetime = DEFAULT_LIFETIME;
    turn.maxAllocateTimeout = MAX_LIFETIME;

    // node-turn forgets expired allocations without closing their relay sockets, which would
    // exhaust the relay port range; close them whenever an allocation is dropped
    turn.allocations = new Proxy({}, {
      deleteProperty(target, key) {
        const allocation = target[key];
        if (allocation) {
          clearTimeout(allocation.timer);
          for (const socket of allocation.sockets) {
            try { socket.close(); } catch (e) { /* already closed */ }
          }
        }
        return delete target[key];
      }
    });

    turn.allocate.checkQuota = username =>
      Object.values(turn.allocations).filter(a => a.user?.username === username).length < MAX_ALLOCATIONS_PER_USER;

    this.server = turn;
    this.server.start();
    // node-turn only parses STUN messages, so ChannelData sent by clients (which browsers use
    // for all media once a channel is bound) would be dropped; forward it ourselves
    for (const socket of turn.network.sockets) {
      socket.on('message', (data, rinfo) => this.forwardChannelData(socket, data, rinfo));
    }

    // Only once per process: node-turn shares these prototypes between instances
    if (!Allocation.prototype.permitUnfiltered) {
      Allocation.prototype.permitUnfiltered = Allocation.prototype.permit;
      Allocation.prototype.permit = function (address) {
        if (!isForbiddenPeer(address)) this.permitUnfiltered(address);
      };

      // node-turn answers ChannelBind without MESSAGE-INTEGRITY, so browsers reject the answer,
      // retry for ~40 s and then tear the relayed path down: every relayed call froze at 40 s
      ChannelBindMethod.prototype.channelBindUnsigned = ChannelBindMethod.prototype.channelBind;
      ChannelBindMethod.prototype.channelBind = function (msg, reply) {
        const resolve = reply.resolve;
        reply.resolve = function () {
          this.addAttribute('message-integrity');
          return resolve.apply(this, arguments);
        };
        return this.channelBindUnsigned(msg, reply);
      };

      // This machine is a valid peer only on relay ports (calls where both sides use the
      // relay); anything else would expose the server's own services, e.g. a local DNS stub
      SendMethod.prototype.sendUnfiltered = SendMethod.prototype.send;
      SendMethod.prototype.send = function (msg, reply) {
        const peer = msg.getAttribute('xor-peer-address');
        if (peer && isOwnAddress(peer.address) && (peer.port < relay.minPort || peer.port > relay.maxPort)) {
          return reply.discard();
        }
        return this.sendUnfiltered(msg, reply);
      };
    }
  }

  forwardChannelData(socket, data, rinfo) {
    if (data.length < 4 || (data[0] & 0xc0) !== 0x40) return; // not ChannelData
    const channel = new ChannelMessage();
    if (!channel.read(data)) return;

    const local = socket.address();
    const transport = new Transport(
      TURN_CONSTANTS.TRANSPORT.PROTOCOL.UDP,
      new Address(rinfo.address, rinfo.port),
      new Address(local.address, local.port),
      socket
    );
    const allocation = this.server?.allocations[transport.get5Tuple()];
    const peer = allocation?.channelBindings[channel.channelNumber];
    if (!peer || !(allocation.permissions[peer.address] > Date.now())) return;
    if (isOwnAddress(peer.address) && (peer.port < this.minPort || peer.port > this.maxPort)) return;
    allocation.sockets[0].send(channel.data, peer.port, peer.address);
  }

  stop() {
    if (!this.server) return;
    for (const key of Object.keys(this.server.allocations)) {
      delete this.server.allocations[key];
    }
    this.server.stop();
    this.server = null;
  }

  // Each participant gets their own credentials, revoked as soon as they leave or are removed
  issueCredentials(participantId) {
    if (!this.server) return null;
    let creds = this.credentials.get(participantId);
    if (!creds) {
      creds = { username: `u-${crypto.randomBytes(8).toString('hex')}`, password: crypto.randomBytes(16).toString('hex') };
      this.credentials.set(participantId, creds);
      this.server.addUser(creds.username, creds.password);
    }
    return creds;
  }

  revokeCredentials(participantId) {
    const creds = this.credentials.get(participantId);
    if (!creds) return;
    this.credentials.delete(participantId);
    if (!this.server) return;
    this.server.removeUser(creds.username);
    for (const [key, allocation] of Object.entries(this.server.allocations)) {
      if (allocation.user?.username === creds.username) delete this.server.allocations[key];
    }
  }

  /**
   * ICE servers for a participant that reached this server at `host` (from its Host header):
   * that address is known to be reachable from the client, so the relay uses it too.
   */
  getIceServers(host, participantId) {
    const iceServers = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
    ];
    let hostname = null;
    try {
      hostname = process.env.TURN_HOST || new URL(`http://${host}`).hostname;
    } catch (e) {
      // malformed Host header: offer public STUN only
    }
    const creds = hostname ? this.issueCredentials(participantId) : null;
    if (!creds) return iceServers;

    iceServers.unshift(
      { urls: `stun:${hostname}:${this.port}` },
      { urls: `turn:${hostname}:${this.port}?transport=udp`, username: creds.username, credential: creds.password }
    );
    return iceServers;
  }
}

module.exports = TurnRelay;
