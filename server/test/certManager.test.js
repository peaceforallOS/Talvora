/**
 * Test HTTPS certificate selection, the server's own CA, renewal and ACME challenge answers
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const CertManager = require('../src/certManager');

async function runCertManagerTests() {
  console.log('--- Starting HTTPS Certificate Tests ---');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'videocall-tls-'));
  const quiet = () => {};

  try {
    // 1. Mode selection
    assert.strictEqual(new CertManager({ dir, domain: 'Call.Example.com', log: quiet }).mode, 'domain');
    const ipManager = new CertManager({ dir, publicIp: '203.0.113.7', log: quiet });
    assert.strictEqual(ipManager.mode, 'ip');
    assert.strictEqual(ipManager.profile, 'shortlived', "Let's Encrypt IP certificates need the short-lived profile");
    assert.ok(!CertManager.isPublicIPv4('192.168.1.10') && !CertManager.isPublicIPv4('10.0.0.1') && !CertManager.isPublicIPv4('100.64.0.1'));
    assert.ok(CertManager.isPublicIPv4('203.0.113.7'));
    console.log('✓ Test 1 Passed: Domain, public IP and local modes chosen correctly');

    // 2. Own CA: certificate signed by the CA, valid for the server's addresses, files private
    const local = new CertManager({ dir, log: quiet });
    local.mode = 'local';
    assert.strictEqual(await local.ensure(), true);
    const [leafPem, caPem] = local.current.cert.split(/(?<=-----END CERTIFICATE-----\r?\n)/);
    const leaf = new crypto.X509Certificate(leafPem);
    const ca = new crypto.X509Certificate(caPem);
    assert.ok(ca.ca && leaf.verify(ca.publicKey), 'Certificate must be signed by the CA');
    assert.ok(leaf.checkIP('127.0.0.1') && leaf.checkHost('localhost'), 'Certificate must cover local addresses');
    assert.strictEqual(local.pinnedFingerprint(), CertManager.fingerprintOf(caPem));
    for (const file of ['ca.key', 'key.pem', 'cert.pem']) {
      assert.strictEqual(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600, `${file} must be private`);
    }
    console.log('✓ Test 2 Passed: Own-CA certificate issued, signed and stored privately');

    // 3. Renewal: nothing before a third of the lifetime is left, then a new certificate from the same CA
    const reloaded = new CertManager({ dir, log: quiet });
    reloaded.mode = 'local';
    assert.strictEqual(await reloaded.ensure(), false, 'A fresh certificate must be reused');
    const oldNotAfter = reloaded.current.notAfter;
    assert.strictEqual(await reloaded.ensure(oldNotAfter - 5 * 24 * 3600 * 1000), true, 'Must renew when close to expiry');
    assert.ok(reloaded.current.notAfter >= oldNotAfter - 1000);
    assert.strictEqual(reloaded.pinnedFingerprint(), local.pinnedFingerprint(), 'Renewal must keep the same CA (links keep working)');
    console.log('✓ Test 3 Passed: Certificates renewed automatically with a stable CA');

    // 4. ACME failure keeps HTTPS working with the own CA and backs off
    const failing = new CertManager({ dir: path.join(dir, 'ip'), publicIp: '203.0.113.7', directoryUrl: 'http://127.0.0.1:9/dir', log: quiet });
    assert.strictEqual(await failing.ensure(), true);
    assert.strictEqual(failing.current.issuedBy, 'local', 'Must fall back to the own CA');
    assert.ok(failing.nextAcmeAttempt > Date.now(), "Must wait before asking Let's Encrypt again");
    assert.ok(failing.pinnedFingerprint(), 'Fallback certificate must be pinnable from invite links');
    console.log("✓ Test 4 Passed: Let's Encrypt failure falls back to the own CA and retries later");

    // 5. http-01 challenge answers
    failing.challenges.set('tok_en-1', 'tok_en-1.thumbprint');
    assert.strictEqual(failing.challengeResponse('/.well-known/acme-challenge/tok_en-1'), 'tok_en-1.thumbprint');
    assert.strictEqual(failing.challengeResponse('/.well-known/acme-challenge/../../etc'), null);
    assert.strictEqual(failing.challengeResponse('/.well-known/acme-challenge/unknown'), null);
    console.log("✓ Test 5 Passed: Let's Encrypt challenge answers served only for pending tokens");

    // 6. The retry schedule survives a restart (no burst of failing orders in a crash loop)
    const restarted = new CertManager({ dir: path.join(dir, 'ip'), publicIp: '203.0.113.7', directoryUrl: 'http://127.0.0.1:9/dir', log: quiet });
    assert.strictEqual(restarted.nextAcmeAttempt, failing.nextAcmeAttempt, 'Retry time must persist');
    console.log('✓ Test 6 Passed: Retry schedule persisted across restarts');

    // 7. A key and certificate that do not belong together (crash mid-write) are replaced, not served
    const otherKey = new CertManager({ dir: path.join(dir, 'other'), log: quiet });
    otherKey.mode = 'local';
    await otherKey.ensure();
    fs.copyFileSync(path.join(dir, 'other', 'key.pem'), path.join(dir, 'key.pem'));
    assert.strictEqual(new CertManager({ dir, log: quiet }).load(), null, 'Mismatched key and certificate must be rejected');
    console.log('✓ Test 7 Passed: Mismatched key/certificate pair detected');

    // 8. Overlapping checks share one run; without port 80 Let's Encrypt is never tried
    const guarded = new CertManager({ dir: path.join(dir, 'guard'), publicIp: '203.0.113.7', allowAcme: false, log: quiet });
    assert.strictEqual(guarded.mode, 'local', "Without port 80 the server must not ask Let's Encrypt");
    assert.strictEqual(guarded.host, '203.0.113.7', 'The public address is still used as the server name');
    const first = guarded.ensure();
    assert.strictEqual(guarded.ensure(), first, 'A second check while one runs must reuse it');
    assert.strictEqual(await first, true);
    console.log("✓ Test 8 Passed: Overlapping renewals prevented; Let's Encrypt skipped without port 80");

    // 9. Renewals reuse the registered account instead of registering again (which the CA rejects
    //    as an empty account update when no email was given)
    const accountDir = path.join(dir, 'account');
    const registered = new CertManager({ dir: accountDir, domain: 'call.example.com', directoryUrl: 'https://ca.test/dir', log: quiet });
    await registered.accountKey();
    fs.writeFileSync(path.join(accountDir, 'account.json'),
      JSON.stringify({ directoryUrl: 'https://ca.test/dir', accountUrl: 'https://ca.test/acct/42' }));
    const client = await registered.acmeClient(); // must not contact the CA
    assert.strictEqual(client.getAccountUrl(), 'https://ca.test/acct/42', 'Saved account must be reused');
    console.log('✓ Test 9 Passed: Renewals reuse the registered certificate account');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n=============================================');
  console.log(' ALL HTTPS CERTIFICATE TESTS PASSED!        ');
  console.log('=============================================\n');
}

runCertManagerTests().catch(err => {
  console.error('HTTPS certificate test failure:', err);
  process.exit(1);
});
