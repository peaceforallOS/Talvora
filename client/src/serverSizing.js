/**
 * Server Sizing — what server to rent for a given use, from how Talvora actually works:
 *
 *  - One server process (Node.js) runs signaling, chat, room state and the TURN media relay. It is
 *    single-threaded, so its load must fit on ONE CPU core: a fast core matters, more cores barely do.
 *    Signaling load is measured (docs/load-test-report.md: 1,000 users clean at 68% of one i3-1115G4
 *    core, breaking point ~1,500; messages grow with users squared).
 *  - Audio/video go directly between participants (full mesh). Only participants whose network blocks
 *    direct connections are relayed through the server (TURN): those connections cost server bandwidth
 *    and CPU. Everyone else costs the server almost nothing for media.
 *  - Music is sent through the server: each new song goes to every participant (and to anyone joining
 *    mid-song), buffered once per participant while it is sent. Pause, resume and seek cost a few bytes.
 *
 * Relay CPU and message sizes are estimates; the recommendation keeps headroom on top of them.
 */

const ServerSizing = (() => {
const SIZING = {
  // % of one reference core (i3-1115G4, ~3 GHz) for signaling at n users, from the load test
  signalingCpu: [[0, 0.3], [10, 0.3], [25, 0.5], [50, 1.5], [100, 3.2], [200, 10.3], [300, 19], [500, 39.5], [750, 55.8], [1000, 67.8], [1500, 100]],
  testedUsers: 1000,
  breakingUsers: 1500,
  messagesPerSecond: n => 0.134 * n * n, // measured traffic mix (chatty: everyone messages every ~10 s)
  messageBytes: 250,
  memoryBaseMb: 65,
  memoryPerUserMb: 0.05,
  osMemoryMb: 450,
  audioMbps: 0.05, // Opus voice incl. packet overhead
  audioPps: 50, // one voice packet every 20 ms
  screenMbps: 1.5,
  packetBytes: 1100, // typical video packet
  relayPpsPerCore: 60000, // estimate: packets per second the relay (JavaScript) forwards on one core
  musicDataUrlFactor: 1.37, // base64 inside the room state
  // Full mesh: every participant keeps a connection to every other one
  meshPeersWarn: 15,
  meshPeersMax: 25,
  meshCamerasWarn: 6,
  meshCamerasMax: 8,
  diskGb: 20
};

const VIDEO_QUALITY = {
  low: { label: 'Low (360p)', mbps: 0.5 },
  standard: { label: 'Standard (720p)', mbps: 1.5 },
  high: { label: 'High (720p, sharp)', mbps: 2.5 }
};

// Share of connections that cannot go direct and use the server's relay (TURN). WebRTC deployments
// commonly report 10-20% for the general public, more behind corporate firewalls.
const NETWORKS = {
  lan: { label: 'Same local network as the server', relay: 0 },
  home: { label: 'Mostly homes and mobile', relay: 0.1 },
  mixed: { label: 'Mixed homes and offices', relay: 0.2 },
  strict: { label: 'Mostly offices, schools, strict firewalls', relay: 0.4 }
};

const MUSIC_USE = {
  none: { label: 'No music', actionsPerHour: 0 },
  sometimes: { label: 'Sometimes (a few songs per hour)', actionsPerHour: 4 },
  often: { label: 'Often (music most of the time)', actionsPerHour: 15 }
};

const RAM_TIERS_GB = [1, 2, 4, 8, 16, 32];

function interpolate(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x0, y0] = points[i - 1];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  const [xa, ya] = points[points.length - 2];
  const [xb, yb] = points[points.length - 1];
  return yb + ((yb - ya) * (x - xb)) / (xb - xa);
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * @param {object} input
 *   participants      people in the call at the same time
 *   cameras           of them, with their camera on
 *   screenShares      people sharing their screen at the same time (0-2)
 *   videoQuality      key of VIDEO_QUALITY
 *   network           key of NETWORKS
 *   music             key of MUSIC_USE
 *   musicFileMb       typical song file size (MB)
 *   hoursPerMonth     hours of calls per month
 */
function estimateServer(input) {
  const n = clamp(Math.round(Number(input.participants) || 0), 1, 5000);
  const cameras = clamp(Math.round(Number(input.cameras) || 0), 0, n);
  const screens = clamp(Math.round(Number(input.screenShares) || 0), 0, Math.min(2, n));
  const quality = VIDEO_QUALITY[input.videoQuality] || VIDEO_QUALITY.standard;
  const network = NETWORKS[input.network] || NETWORKS.home;
  const music = MUSIC_USE[input.music] || MUSIC_USE.none;
  const musicFileMb = clamp(Number(input.musicFileMb) || 0, 0, 18);
  const hours = clamp(Number(input.hoursPerMonth) || 0, 0, 744);
  const peers = n - 1;

  // Media: every sender sends to every other participant; the relayed share passes through the server
  const relayedShare = network.relay;
  const mediaMbps = n * peers * SIZING.audioMbps + cameras * peers * quality.mbps + screens * peers * SIZING.screenMbps;
  const relayMbps = relayedShare * mediaMbps; // each way through the server
  const videoPps = mbps => (mbps * 1e6) / 8 / SIZING.packetBytes;
  const relayPps = relayedShare * (n * peers * SIZING.audioPps + cameras * peers * videoPps(quality.mbps) + screens * peers * videoPps(SIZING.screenMbps));

  // Signaling (measured) and music (each action sends the file to everyone)
  const signalingMbps = (SIZING.messagesPerSecond(n) * SIZING.messageBytes * 8) / 1e6;
  const musicMb = musicFileMb * SIZING.musicDataUrlFactor;
  const musicMbps = (music.actionsPerHour * n * musicMb * 8) / 3600;

  // CPU: everything shares one single-threaded process
  const signalingCorePct = interpolate(SIZING.signalingCpu, n);
  const relayCorePct = (relayPps / SIZING.relayPpsPerCore) * 100;
  const corePct = (signalingCorePct + relayCorePct) * 1.1; // + encryption (TLS) and housekeeping

  // Memory: the process, plus a song buffered once per participant while it is being sent
  const processMb = SIZING.memoryBaseMb + SIZING.memoryPerUserMb * n + (music.actionsPerHour ? musicMb * (1 + n) : 0);
  const neededMb = (processMb + SIZING.osMemoryMb) * 1.5;
  const ramGb = RAM_TIERS_GB.find(gb => gb * 1024 >= neededMb) || RAM_TIERS_GB[RAM_TIERS_GB.length - 1];

  const uploadMbps = relayMbps + signalingMbps + musicMbps;
  const downloadMbps = relayMbps + signalingMbps * 0.1;
  // Providers usually count outgoing traffic; incoming is about the relay share again
  const monthlyTrafficGb = (uploadMbps * 3600 * hours) / 8 / 1000;
  // A song should reach everyone within ~15 s; never recommend less than 100 Mbit/s
  const musicBurstMbps = music.actionsPerHour ? (n * musicMb * 8) / 15 : 0;
  const linkMbps = [100, 200, 500, 1000, 2500, 10000].find(speed => speed >= Math.max(uploadMbps * 1.5, musicBurstMbps)) || 10000;

  // One process: one core does the work; a second keeps the system, network and encryption off it
  const vcpu = corePct <= 30 ? 1 : 2;

  // What each participant's own connection needs (full mesh: one stream to and from every peer)
  const senderUploadMbps = peers * (SIZING.audioMbps + (cameras ? quality.mbps : 0)) + (screens ? peers * SIZING.screenMbps : 0);
  const downloadPerPersonMbps = peers * SIZING.audioMbps + Math.min(cameras, peers) * quality.mbps + Math.min(screens, peers) * SIZING.screenMbps;
  const meshOk = peers <= SIZING.meshPeersMax && cameras <= SIZING.meshCamerasMax;
  const fits = meshOk && corePct <= 85 && n <= SIZING.testedUsers;

  const warnings = [];
  if (peers > SIZING.meshPeersMax) {
    warnings.push({ level: 'bad', text: `${n} people in one call is not workable: everyone connects directly to everyone (${peers} connections per computer). Above about ${SIZING.meshPeersMax + 1} people the participants' computers and connections give out, whatever the server. (The server alone handles up to ${SIZING.testedUsers.toLocaleString('en')} people for chat and signaling.)` });
  } else if (peers > SIZING.meshPeersWarn) {
    warnings.push({ level: 'warn', text: `With ${n} people every computer keeps ${peers} connections open. That works on good computers and connections; older laptops and phones may struggle.` });
  }
  if (cameras > SIZING.meshCamerasMax) {
    warnings.push({ level: 'bad', text: `${cameras} cameras is too many for a direct (mesh) call: every camera is sent separately to every participant. Above about ${SIZING.meshCamerasMax} cameras the participants' own computers and connections become the limit, not the server. Turn some cameras off or lower the video quality.` });
  } else if (cameras > SIZING.meshCamerasWarn) {
    warnings.push({ level: 'warn', text: `${cameras} cameras is near the limit of a direct (mesh) call; Low quality helps everyone's connection.` });
  }
  if (meshOk && senderUploadMbps > 10) {
    warnings.push({ level: 'warn', text: `Each person with a camera on (or sharing their screen) needs about ${round(senderUploadMbps)} Mbit/s upload. Many home connections have less; lower the video quality or the number of cameras.` });
  }
  if (meshOk && n > SIZING.testedUsers) {
    warnings.push({ level: 'bad', text: `More than ${SIZING.testedUsers.toLocaleString('en')} people is beyond what one server was tested with.` });
  } else if (meshOk && corePct > 85) {
    warnings.push({ level: 'bad', text: 'Too much relayed traffic for one server process, whatever its size: the server is single-threaded. Lower the video quality or the number of cameras.' });
  } else if (meshOk && corePct > 60) {
    warnings.push({ level: 'warn', text: 'Close to the limit of one server process. Choose a CPU with high single-core speed (3 GHz or more); extra cores do not help.' });
  }
  if (music.actionsPerHour && n * musicMb > 2048) {
    warnings.push({ level: 'warn', text: `Each song is sent to all ${n} people through the server (about ${round((n * musicMb) / 1024)} GB per song). Prefer smaller files or fewer participants when playing music.` });
  }
  if (network.relay === 0) {
    warnings.push({ level: 'info', text: 'On the same local network, audio and video never pass through the server, so it needs very little.' });
  }
  warnings.push({ level: 'info', text: 'A server runs one call (room) at a time. For several calls at the same time, use one server per call.' });

  return {
    fits,
    recommendation: {
      vcpu,
      ramGb,
      diskGb: SIZING.diskGb,
      linkMbps,
      monthlyTrafficGb: round(monthlyTrafficGb, 0),
      cpuNote: vcpu === 1 ? 'any current CPU' : 'high single-core speed (3 GHz or more)'
    },
    load: {
      corePct: round(corePct),
      signalingCorePct: round(signalingCorePct),
      relayCorePct: round(relayCorePct),
      processMemoryMb: round(processMb, 0),
      relayMbps: round(relayMbps),
      uploadMbps: round(uploadMbps),
      downloadMbps: round(downloadMbps),
      musicBurstMbps: round(musicBurstMbps, 0),
      relayedShare: round(relayedShare * 100, 0)
    },
    perParticipant: {
      cameraUploadMbps: round(senderUploadMbps),
      downloadMbps: round(downloadPerPersonMbps)
    },
    warnings
  };
}

return { SIZING, VIDEO_QUALITY, NETWORKS, MUSIC_USE, estimateServer };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ServerSizing;
}
