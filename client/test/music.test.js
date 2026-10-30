/**
 * Section 6 Integration Tests — Synchronized Music & Concurrency Lock
 */

process.env.PORT = '8095';
const assert = require('assert');
const { WebSocket } = require('../../server/node_modules/ws');
global.WebSocket = WebSocket;

const ClientCore = require('../src/clientCore');
const { server, authService } = require('../../server/src/index');

const serverUrl = 'http://localhost:8095';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runMusicTests() {
  console.log('--- Starting Section 6: Music Player & Exclusive Lock Tests ---');

  const adminInvite = authService.getAdminCredentials(serverUrl);
  const user1Invite = authService.generateInviteLink({ baseUrl: serverUrl, targetUsername: 'Musician1' });
  const user2Invite = authService.generateInviteLink({ baseUrl: serverUrl, targetUsername: 'Musician2' });

  let musicErrors = [];
  const coreAdmin = new ClientCore();
  const coreUser1 = new ClientCore({ onMusicError: err => musicErrors.push(err) });
  const coreUser2 = new ClientCore({ onMusicError: err => musicErrors.push(err) });

  coreAdmin.connect({ username: 'Admin', linkOrToken: adminInvite.adminLink, serverUrl });
  coreUser1.connect({ username: 'Musician1', linkOrToken: user1Invite.joinLink, serverUrl });
  coreUser2.connect({ username: 'Musician2', linkOrToken: user2Invite.joinLink, serverUrl });

  await sleep(600);
  console.log('✓ All 3 clients connected.');

  // 1. Musician1 starts playback
  coreUser1.sendMusicAction({
    action: 'play',
    trackInfo: { title: 'Symphony No. 5', artist: 'Beethoven' }
  });

  await sleep(300);
  assert.ok(coreUser1.roomState.musicState.isPlaying === true, 'Musician1 music state not active');
  assert.ok(coreUser2.roomState.musicState.isPlaying === true, 'Musician2 did not receive synchronized music state');
  assert.ok(coreUser2.roomState.musicState.playedBy.username === 'Musician1', 'Active DJ username mismatch');
  console.log('✓ Test 1 Passed: Musician1 acquired exclusive playback lock and synchronized across room');

  // 2. Musician2 attempts to start playback concurrently -> MUST BE REJECTED
  coreUser2.sendMusicAction({
    action: 'play',
    trackInfo: { title: 'Jazz Improvisation' }
  });

  await sleep(300);
  assert.ok(musicErrors.some(e => e.includes('Only one person can play music at a time')), 'Concurrency lock error missing');
  assert.ok(coreUser1.roomState.musicState.playedBy.username === 'Musician1', 'Playback lock was incorrectly replaced');
  console.log('✓ Test 2 Passed: Musician2 blocked from playing music while Musician1 is playing');

  // 3. Musician2 attempts to stop Musician1's music -> MUST BE REJECTED
  coreUser2.sendMusicAction({ action: 'stop' });
  await sleep(300);
  assert.ok(coreUser1.roomState.musicState.isPlaying === true, 'Unauthorized user should not be able to stop music');
  console.log('✓ Test 3 Passed: Non-admin user blocked from stopping another user\'s music');

  // 4. Admin Override: Admin stops playback -> MUST SUCCEED
  coreAdmin.sendMusicAction({ action: 'stop' });
  await sleep(300);
  assert.ok(coreUser1.roomState.musicState.isPlaying === false, 'Admin stop failed');
  assert.ok(coreUser2.roomState.musicState.isPlaying === false, 'Admin stop sync failed');
  console.log('✓ Test 4 Passed: Admin exercised override authority and successfully stopped music');

  // 5. Musician2 can now start music because the room is idle
  coreUser2.sendMusicAction({
    action: 'play',
    trackInfo: { title: 'New Track by Musician2' }
  });

  await sleep(300);
  assert.ok(coreUser2.roomState.musicState.isPlaying === true, 'Musician2 should now be able to play');
  assert.ok(coreUser2.roomState.musicState.playedBy.username === 'Musician2', 'Musician2 should now be active DJ');
  console.log('✓ Test 5 Passed: Next user successfully started music after previous track stopped');

  // 6. The server announces what it supports; the DJ replaces their track with a real (large) song
  assert.ok(coreUser1.supportsFeature('music-resume') && coreUser1.supportsFeature('music-light'), 'Server features missing');
  const song = `data:audio/mpeg;base64,${'A'.repeat(300000)}`;
  const sizes = []; // sizes of music updates received by a current client
  coreUser1.ws.addEventListener('message', e => {
    if (String(e.data).includes('"music_state"')) sizes.push(String(e.data).length);
  });
  // A client from before these changes: announces no capabilities
  const oldInvite = authService.generateInviteLink({ baseUrl: serverUrl, targetUsername: 'OldClient' });
  const oldClient = new WebSocket('ws://localhost:8095');
  const oldSizes = [];
  await new Promise(r => oldClient.on('open', r));
  oldClient.send(JSON.stringify({ type: 'auth', username: 'OldClient', token: oldInvite.token }));
  oldClient.on('message', raw => {
    if (String(raw).includes('"music_state"')) oldSizes.push(String(raw).length);
  });
  await sleep(300);

  coreUser2.sendMusicAction({ action: 'play', trackInfo: { title: 'Big Song', audioDataUrl: song } });
  await sleep(400);
  const firstTrackId = coreUser1.roomState.musicState.trackId;
  assert.ok(firstTrackId, 'Track id missing');
  assert.strictEqual(coreUser1.roomState.musicState.trackInfo.audioDataUrl, song, 'New track must carry its audio');
  assert.ok(sizes.pop() > 300000, 'A new track is sent with its audio');
  console.log('✓ Test 6 Passed: New track sent with its audio and a track id');

  // 7. Pause, seek and resume by the DJ: a few bytes for current clients, audio kept locally
  coreUser2.sendMusicAction({ action: 'pause' });
  await sleep(300);
  assert.strictEqual(coreUser1.roomState.musicState.isPlaying, false, 'Pause not synchronized');
  assert.strictEqual(coreUser1.roomState.musicState.trackInfo.audioDataUrl, song, 'Client lost the audio on pause');
  coreUser2.sendMusicAction({ action: 'seek', time: 42 });
  await sleep(300);
  assert.ok(Math.abs(coreUser1.roomState.musicState.position - 42) < 0.5, 'Seek not synchronized');
  assert.strictEqual(coreUser1.roomState.musicState.isPlaying, false, 'Seeking while paused must stay paused');
  coreUser2.sendMusicAction({ action: 'resume' });
  await sleep(300);
  const resumed = coreUser1.roomState.musicState;
  assert.strictEqual(resumed.isPlaying, true, 'Resume not synchronized');
  assert.ok(resumed.position >= 42 && resumed.position < 43.5, `Resume must continue from 42 s, got ${resumed.position}`);
  assert.strictEqual(resumed.trackId, firstTrackId, 'Same track after resume');
  assert.ok(sizes.length >= 3 && sizes.slice(-3).every(s => s < 2000), `Control updates must not resend the song (${sizes.slice(-3)})`);
  console.log('✓ Test 7 Passed: Pause, seek and resume synchronized without resending the song');

  // 8. Older clients still get the full state on every update (they expect the audio each time)
  assert.ok(oldSizes.slice(-3).every(s => s > 300000), `Old clients must keep getting the audio (${oldSizes.slice(-3)})`);
  console.log('✓ Test 8 Passed: Older clients keep working with the full music state');

  // 9. Only the DJ and the admin control playback
  musicErrors = [];
  coreUser1.sendMusicAction({ action: 'pause' });
  coreUser1.sendMusicAction({ action: 'seek', time: 1 });
  await sleep(300);
  assert.strictEqual(coreUser2.roomState.musicState.isPlaying, true, 'A listener paused the DJ');
  assert.ok(Math.abs(coreUser2.roomState.musicState.position - 1) > 5, 'A listener moved the DJ');
  assert.strictEqual(musicErrors.length, 2, 'Listeners must be told they cannot control playback');
  coreAdmin.sendMusicAction({ action: 'pause' });
  await sleep(300);
  assert.strictEqual(coreUser2.roomState.musicState.isPlaying, false, 'Admin could not pause');
  coreAdmin.sendMusicAction({ action: 'resume' });
  await sleep(300);
  assert.strictEqual(coreUser2.roomState.musicState.isPlaying, true, 'Admin could not resume');
  console.log('✓ Test 9 Passed: Only the DJ and the admin control playback');

  // 10. Someone joining mid-song gets the audio
  const lateInvite = authService.generateInviteLink({ baseUrl: serverUrl, targetUsername: 'Latecomer' });
  const late = new ClientCore();
  late.connect({ username: 'Latecomer', linkOrToken: lateInvite.joinLink, serverUrl });
  await sleep(400);
  assert.strictEqual(late.roomState.musicState.trackInfo.audioDataUrl, song, 'Latecomer must receive the song');
  late.disconnect();
  oldClient.close();
  console.log('✓ Test 10 Passed: People joining mid-song receive the audio');

  // Clean up
  coreAdmin.disconnect();
  coreUser1.disconnect();
  coreUser2.disconnect();
  server.close();

  console.log('\n=============================================');
  console.log(' ALL SECTION 6 MUSIC TESTS PASSED!          ');
  console.log('=============================================\n');
  process.exit(0);
}

runMusicTests().catch(err => {
  console.error('Section 6 test failure:', err);
  process.exit(1);
});
