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
