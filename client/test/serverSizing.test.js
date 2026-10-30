/**
 * Server Calculator Tests — recommendations follow the measured load and the mesh limits: small
 * calls fit the smallest server, relayed video and music raise bandwidth and memory, oversized
 * calls are reported as not workable instead of getting a huge server
 */

const assert = require('assert');
const { estimateServer, SIZING } = require('../src/serverSizing');

console.log('--- Starting Server Calculator Tests ---');

const base = { participants: 8, cameras: 4, screenShares: 0, videoQuality: 'standard', network: 'home', music: 'none', musicFileMb: 8, hoursPerMonth: 40 };
const run = changes => estimateServer({ ...base, ...changes });

// 1. A typical small call fits the smallest server
const small = run({});
assert.ok(small.fits);
assert.deepStrictEqual([small.recommendation.vcpu, small.recommendation.ramGb, small.recommendation.linkMbps], [1, 1, 100]);
assert.ok(small.load.corePct < 10, `Small call uses ${small.load.corePct}% of a core`);
console.log('✓ Test 1 Passed: Small calls fit the smallest server');

// 2. Signaling load follows the measured load test
assert.ok(Math.abs(run({ participants: 1000, cameras: 0, network: 'lan' }).load.signalingCorePct - 67.8) < 0.01);
assert.ok(Math.abs(run({ participants: 500, cameras: 0, network: 'lan' }).load.signalingCorePct - 39.5) < 0.01);
console.log('✓ Test 2 Passed: Signaling load matches the load test');

// 3. More relaying (stricter networks, more cameras, higher quality) means more server traffic; LAN none
const relay = changes => run(changes).load.relayMbps;
assert.strictEqual(relay({ network: 'lan' }), 0);
assert.ok(relay({ network: 'home' }) < relay({ network: 'mixed' }) && relay({ network: 'mixed' }) < relay({ network: 'strict' }));
assert.ok(relay({ cameras: 2 }) < relay({ cameras: 6 }));
assert.ok(relay({ videoQuality: 'low' }) < relay({ videoQuality: 'high' }));
assert.ok(run({ hoursPerMonth: 100 }).recommendation.monthlyTrafficGb > run({ hoursPerMonth: 10 }).recommendation.monthlyTrafficGb);
console.log('✓ Test 3 Passed: Relayed media drives bandwidth and traffic');

// 4. Never more than 2 vCPU: the server is single-threaded
for (const participants of [2, 10, 20, 26]) {
  assert.ok(run({ participants, cameras: Math.min(8, participants), network: 'strict', videoQuality: 'high' }).recommendation.vcpu <= 2);
}
console.log('✓ Test 4 Passed: CPU advice reflects the single-threaded server');

// 5. Music: songs go to everyone through the server, buffered per participant
const withMusic = run({ participants: 20, cameras: 0, music: 'often', musicFileMb: 18 });
const noMusic = run({ participants: 20, cameras: 0 });
assert.ok(withMusic.load.processMemoryMb > noMusic.load.processMemoryMb + 18 * 20);
assert.ok(withMusic.recommendation.ramGb >= noMusic.recommendation.ramGb);
assert.ok(withMusic.recommendation.linkMbps > noMusic.recommendation.linkMbps, 'Songs need a faster port');
console.log('✓ Test 5 Passed: Music raises memory and network needs');

// 6. Oversized calls are reported as not workable, with the reason
const webinar = run({ participants: 300, cameras: 1 });
assert.strictEqual(webinar.fits, false);
assert.ok(webinar.warnings.some(w => w.level === 'bad' && /connects directly to everyone/.test(w.text)));
const manyCams = run({ participants: 12, cameras: 12 });
assert.strictEqual(manyCams.fits, false);
assert.ok(manyCams.warnings.some(w => w.level === 'bad' && /too many/.test(w.text)));
assert.ok(run({ participants: SIZING.meshPeersMax + 1, cameras: 2 }).fits, 'Largest workable call still gets a recommendation');
console.log('✓ Test 6 Passed: Calls beyond the mesh limits are flagged, not sized');

// 7. Bad input is clamped, never NaN
const odd = estimateServer({ participants: 'abc', cameras: -5, hoursPerMonth: 'x', videoQuality: 'ultra', network: '?', music: '?' });
assert.ok(Number.isFinite(odd.load.corePct) && Number.isFinite(odd.recommendation.monthlyTrafficGb));
assert.strictEqual(run({ cameras: 50 }).perParticipant.cameraUploadMbps, run({ cameras: 8 }).perParticipant.cameraUploadMbps,
  'Cameras are capped at the number of people');
console.log('✓ Test 7 Passed: Invalid input handled');

// 8. The app's calculator asks only for the number of people: a busy typical call is assumed
const { estimateForUsers, TYPICAL_CALL } = require('../src/serverSizing');
const eight = estimateForUsers(8);
assert.deepStrictEqual(eight, estimateServer({
  participants: 8, cameras: TYPICAL_CALL.maxCameras, screenShares: 1, videoQuality: 'standard',
  network: 'mixed', music: 'sometimes', musicFileMb: 8, hoursPerMonth: 0
}), 'Only the number of people may vary');
assert.ok(eight.fits && eight.recommendation.trafficGbPerHour > 0);
assert.strictEqual(estimateForUsers(3).load.relayMbps < estimateForUsers(20).load.relayMbps, true, 'More people, more traffic');
assert.strictEqual(estimateForUsers(1).warnings.some(w => w.level === 'bad'), false, 'One person is fine');
assert.strictEqual(estimateForUsers(100).fits, false, 'Too many people for one call are still flagged');
assert.ok(estimateForUsers(26).fits, 'The largest workable call gets a recommendation');
console.log('✓ Test 8 Passed: Calculator by number of people only');

console.log('\n========================================');
console.log(' ALL SERVER CALCULATOR TESTS PASSED!    ');
console.log('========================================\n');
