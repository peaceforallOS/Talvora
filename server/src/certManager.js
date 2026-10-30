/**
 * HTTPS Certificate Manager — obtains and automatically renews the server's TLS certificate
 *
 *  - domain:  the admin has a domain name -> Let's Encrypt certificate (90 days)
 *  - ip:      no domain, but a public IP  -> Let's Encrypt IP certificate ("shortlived", ~6 days)
 *  - local:   neither (LAN / behind NAT)  -> certificate from the server's own CA (30 days);
 *             invite links carry the CA fingerprint and the app trusts only that CA
 *
 * Certificates are renewed when a third of their lifetime remains; until a public certificate can
 * be obtained, the local CA keeps HTTPS working.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const acme = require('acme-client');
const forge = require('node-forge');

const LETS_ENCRYPT = acme.directory.letsencrypt.production;
const LOCAL_CA_YEARS = 10;
const LOCAL_CERT_DAYS = 30;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const MAX_RETRY_MS = 24 * 60 * 60 * 1000;
const ACME_TIMEOUT_MS = 3 * 60 * 1000; // never let a stalled CA keep the server from starting

function isPublicIPv4(ip) {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
}

function localIPv4s() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(c => c.family === 'IPv4' && !c.internal)
    .map(c => c.address);
}

// SHA-256 of a certificate (hex), as carried in invite links
function fingerprintOf(certPem) {
  return new crypto.X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase();
}

class CertManager {
  constructor({
    dir,
    domain = null,
    publicIp = null,
    email = null,
    directoryUrl = LETS_ENCRYPT,
    profile = null,
    allowAcme = true, // false when Let's Encrypt cannot reach this server (port 80 not available)
    log = console.log
  }) {
    this.dir = dir;
    this.domain = domain ? domain.trim().toLowerCase() : null;
    this.publicIp = publicIp || localIPv4s().find(isPublicIPv4) || null;
    this.email = email;
    this.directoryUrl = directoryUrl;
    this.log = log;
    this.mode = !allowAcme ? 'local' : this.domain ? 'domain' : this.publicIp ? 'ip' : 'local';
    // Let's Encrypt only issues IP certificates under the short-lived profile
    this.profile = profile || (this.mode === 'ip' ? 'shortlived' : null);
    this.challenges = new Map(); // http-01 token -> key authorization
    this.current = null; // { key, cert, notBefore, notAfter, issuedBy: 'acme' | 'local' }
    this.retryDelay = CHECK_INTERVAL_MS;
    this.nextAcmeAttempt = 0;
    this.timer = null;
    this.running = null; // the ensure() in progress, so checks never overlap
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    // Let's Encrypt retry schedule survives restarts (avoids hitting its rate limits)
    try {
      const state = JSON.parse(fs.readFileSync(this.file('acme-state.json'), 'utf8'));
      this.nextAcmeAttempt = Number(state.nextAcmeAttempt) || 0;
      this.retryDelay = Number(state.retryDelay) || CHECK_INTERVAL_MS;
    } catch (e) {
      // first start
    }
  }

  // Host name clients use: the domain, the public IP, or this machine's LAN address
  get host() {
    return this.domain || this.publicIp || localIPv4s()[0] || 'localhost';
  }

  file(name) {
    return path.join(this.dir, name);
  }

  writeSecret(name, data) {
    const target = this.file(name);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, target);
  }

  load() {
    try {
      const cert = fs.readFileSync(this.file('cert.pem'), 'utf8');
      const key = fs.readFileSync(this.file('key.pem'), 'utf8');
      const meta = JSON.parse(fs.readFileSync(this.file('cert.json'), 'utf8'));
      if (meta.host !== this.host) return null; // the server's name changed: issue a new one
      const x509 = new crypto.X509Certificate(cert);
      // A crash between writing the key and the certificate must not leave a pair that cannot start
      if (!x509.checkPrivateKey(crypto.createPrivateKey(key))) return null;
      return { key, cert, notBefore: Date.parse(x509.validFrom), notAfter: Date.parse(x509.validTo), issuedBy: meta.issuedBy };
    } catch (e) {
      return null;
    }
  }

  store(result) {
    this.writeSecret('key.pem', result.key);
    this.writeSecret('cert.pem', result.cert);
    this.writeSecret('cert.json', JSON.stringify({ host: this.host, issuedBy: result.issuedBy }, null, 2));
    this.current = result;
  }

  // Renew when a third of the lifetime is left (about 30 days for 90-day certificates, 2 days for 6-day ones)
  needsRenewal(cert = this.current, now = Date.now()) {
    if (!cert) return true;
    return now > cert.notAfter - (cert.notAfter - cert.notBefore) / 3;
  }

  wantsPublicCertificate() {
    return this.mode !== 'local' && this.current?.issuedBy !== 'acme';
  }

  /**
   * Make sure a valid certificate is available. Returns true when a new one was installed.
   */
  ensure(now = Date.now()) {
    if (!this.running) this.running = this.ensureNow(now).finally(() => { this.running = null; });
    return this.running;
  }

  saveAcmeState() {
    this.writeSecret('acme-state.json', JSON.stringify({ nextAcmeAttempt: this.nextAcmeAttempt, retryDelay: this.retryDelay }));
  }

  async ensureNow(now) {
    if (!this.current) this.current = this.load();
    const dueForAcme = this.mode !== 'local' && (this.needsRenewal(this.current, now) || this.wantsPublicCertificate()) &&
      now >= this.nextAcmeAttempt;

    if (dueForAcme) {
      try {
        let timer;
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('no answer from the certificate authority')), ACME_TIMEOUT_MS);
        });
        try {
          this.store(await Promise.race([this.obtainFromAcme(), deadline]));
        } finally {
          clearTimeout(timer);
        }
        this.retryDelay = CHECK_INTERVAL_MS;
        this.nextAcmeAttempt = 0;
        this.saveAcmeState();
        this.log(`HTTPS: Let's Encrypt certificate for ${this.host} valid until ${new Date(this.current.notAfter).toISOString()}`);
        return true;
      } catch (err) {
        this.nextAcmeAttempt = now + this.retryDelay;
        this.log(`HTTPS: could not get a Let's Encrypt certificate for ${this.host} (${err.message}). ` +
          `Retrying in ${Math.round(this.retryDelay / 60000)} min; using the server's own certificate meanwhile.`);
        this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
        this.saveAcmeState();
      }
    }

    if (!this.current || (this.needsRenewal(this.current, now) && this.current.issuedBy !== 'acme') || now >= this.current.notAfter) {
      this.store(this.issueFromLocalCa());
      this.log(`HTTPS: certificate from the server's own CA for ${this.host} valid until ${new Date(this.current.notAfter).toISOString()}`);
      return true;
    }
    return false;
  }

  // Check regularly and call onRenewed({ key, cert }) whenever a new certificate is installed
  startAutoRenew(onRenewed) {
    this.stopAutoRenew();
    this.timer = setInterval(async () => {
      try {
        if (await this.ensure()) onRenewed(this.current);
      } catch (err) {
        this.log(`HTTPS: certificate renewal failed: ${err.message}`);
      }
    }, CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  stopAutoRenew() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // --- Let's Encrypt (ACME, http-01 challenge on port 80) ---

  async accountKey() {
    try {
      return fs.readFileSync(this.file('account.key'), 'utf8');
    } catch (e) {
      const key = (await acme.crypto.createPrivateEcdsaKey()).toString();
      this.writeSecret('account.key', key);
      return key;
    }
  }

  // Answer for http://<host>/.well-known/acme-challenge/<token>, or null
  challengeResponse(urlPath) {
    const match = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(urlPath);
    return match ? this.challenges.get(match[1]) || null : null;
  }

  // Registers the ACME account once and remembers its URL. Registering again on every renewal would
  // turn into an account update, which the CA rejects when there is nothing (no email) to update.
  async acmeClient() {
    const accountKey = await this.accountKey();
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(this.file('account.json'), 'utf8'));
    } catch (e) {
      // not registered yet
    }
    if (saved && saved.directoryUrl === this.directoryUrl && saved.accountUrl) {
      return new acme.Client({ directoryUrl: this.directoryUrl, accountKey, accountUrl: saved.accountUrl });
    }
    const client = new acme.Client({ directoryUrl: this.directoryUrl, accountKey });
    await client.createAccount({ termsOfServiceAgreed: true, ...(this.email ? { contact: [`mailto:${this.email}`] } : {}) });
    this.writeSecret('account.json', JSON.stringify({ directoryUrl: this.directoryUrl, accountUrl: client.getAccountUrl() }));
    return client;
  }

  async obtainFromAcme() {
    const client = await this.acmeClient();

    const identifier = { type: net.isIP(this.host) ? 'ip' : 'dns', value: this.host };
    const order = await client.createOrder({ identifiers: [identifier], ...(this.profile ? { profile: this.profile } : {}) });
    const authorizations = await client.getAuthorizations(order);
    const tokens = [];
    try {
      for (const authz of authorizations) {
        if (authz.status === 'valid') continue;
        const challenge = authz.challenges.find(c => c.type === 'http-01');
        if (!challenge) throw new Error('the CA offered no http-01 challenge');
        this.challenges.set(challenge.token, await client.getChallengeKeyAuthorization(challenge));
        tokens.push(challenge.token);
        await client.completeChallenge(challenge);
        await client.waitForValidStatus(challenge);
      }
      const [key, csr] = await acme.crypto.createCsr({
        altNames: [this.host],
        ...(identifier.type === 'dns' ? { commonName: this.host } : {})
      }, await acme.crypto.createPrivateEcdsaKey());
      const finalized = await client.finalizeOrder(order, csr);
      const cert = await client.getCertificate(finalized);
      const x509 = new crypto.X509Certificate(cert);
      return { key: key.toString(), cert, notBefore: Date.parse(x509.validFrom), notAfter: Date.parse(x509.validTo), issuedBy: 'acme' };
    } finally {
      tokens.forEach(token => this.challenges.delete(token));
    }
  }

  // --- The server's own certificate authority ---

  localCa() {
    try {
      return {
        cert: fs.readFileSync(this.file('ca.pem'), 'utf8'),
        key: fs.readFileSync(this.file('ca.key'), 'utf8')
      };
    } catch (e) {
      if (fs.existsSync(this.file('ca.pem'))) {
        this.log('HTTPS: WARNING: the server CA key is missing; creating a new CA. Invite links issued before ' +
          'this point stop working in the app; send new links to your users.');
      }
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = `01${crypto.randomBytes(15).toString('hex')}`;
      cert.validity.notBefore = new Date(Date.now() - 60 * 60 * 1000);
      cert.validity.notAfter = new Date(Date.now() + LOCAL_CA_YEARS * 365 * 24 * 60 * 60 * 1000);
      const subject = [{ name: 'commonName', value: `Talvora Server CA (${os.hostname()})` }];
      cert.setSubject(subject);
      cert.setIssuer(subject);
      cert.setExtensions([
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
        { name: 'subjectKeyIdentifier' }
      ]);
      cert.sign(keys.privateKey, forge.md.sha256.create());
      const ca = { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
      this.writeSecret('ca.key', ca.key);
      this.writeSecret('ca.pem', ca.cert);
      return ca;
    }
  }

  // Fingerprint clients pin when the server uses its own CA (null when not needed)
  pinnedFingerprint() {
    return this.current?.issuedBy === 'local' ? fingerprintOf(this.localCa().cert) : null;
  }

  issueFromLocalCa() {
    const ca = this.localCa();
    const caCert = forge.pki.certificateFromPem(ca.cert);
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = `01${crypto.randomBytes(15).toString('hex')}`;
    cert.validity.notBefore = new Date(Date.now() - 60 * 60 * 1000);
    cert.validity.notAfter = new Date(Date.now() + LOCAL_CERT_DAYS * 24 * 60 * 60 * 1000);
    cert.setSubject([{ name: 'commonName', value: this.host }]);
    cert.setIssuer(caCert.subject.attributes);

    // Valid for every address the server may be reached at
    const names = new Set([this.host, os.hostname(), 'localhost', '127.0.0.1', ...localIPv4s()]);
    if (this.publicIp) names.add(this.publicIp);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [...names].map(n => (net.isIP(n) ? { type: 7, ip: n } : { type: 2, value: n })) },
      { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() }
    ]);
    cert.sign(forge.pki.privateKeyFromPem(ca.key), forge.md.sha256.create());

    const leafPem = forge.pki.certificateToPem(cert);
    return {
      key: forge.pki.privateKeyToPem(keys.privateKey),
      cert: leafPem + ca.cert, // full chain, so clients can check the signature against the pinned CA
      notBefore: cert.validity.notBefore.getTime(),
      notAfter: cert.validity.notAfter.getTime(),
      issuedBy: 'local'
    };
  }
}

CertManager.isPublicIPv4 = isPublicIPv4;
CertManager.fingerprintOf = fingerprintOf;
module.exports = CertManager;
