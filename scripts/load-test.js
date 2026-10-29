#!/usr/bin/env node
/**
 * Signaling server load test.
 * Usage: node scripts/load-test.js [--stages 10,25,50] [--duration 30] [--port 18080]
 */

const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'server/node_modules/ws'));
const { generateToken, Role } = require(path.join(ROOT, 'shared/protocol'));

const MAX_JOIN_FAILURE_RATE = 0.05;
const MAX_P95_CHAT_MS = 2000;
const JOIN_TIMEOUT_MS = 10000;
const JOIN_BATCH = 10;
const JOIN_BATCH_GAP_MS = 100;
const CHAT_INTERVAL_MS = 10000;
const SIGNAL_INTERVAL_MS = 5000;
const MEDIA_INTERVAL_MS = 30000;
const CLK_TCK = 100;

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const stages = (args.stages || '10,25,50,100,200,300,500').split(',').map(Number).filter(n => n > 0);
const durationSec = Number(args.duration) || 30;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function pct(arr, p) {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function readCpuTicks(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(f[11]) + Number(f[12]); // utime + stime
}

function readRssMb(pid) {
  const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/);
  return m ? Number(m[1]) / 1024 : null;
}

function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health' }, res => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('Server did not start'));
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

let stage = null; // metrics bucket for the stage currently running
const clients = [];
let nextClientIndex = 0;

function newStage(target) {
  return {
    target,
    joinOk: 0,
    joinFail: 0,
    joinLatencies: [],
    chatLatencies: [],
    received: 0,
    errors: 0,
    disconnects: 0
  };
}

function startTraffic(client) {
  const timers = client.timers;
  const peers = () => clients.filter(c => c !== client && c.authed);
  const sendSignal = () => {
    const list = peers();
    if (!list.length) return;
    const target = list[Math.floor(Math.random() * list.length)];
    client.send({
      type: 'signal',
      targetPeerId: target.id,
      signal: { candidate: { candidate: 'fake', sdpMid: '0', sdpMLineIndex: 0 } }
    });
  };
  // Join-time signaling burst: offer/answer/ICE exchange with a few peers
  const burst = Math.min(5, peers().length);
  for (let i = 0; i < burst * 3; i++) setTimeout(sendSignal, 50 * i);

  const every = (fn, ms) => {
    setTimeout(() => {
      if (!client.open) return;
      fn();
      timers.push(setInterval(fn, ms));
    }, Math.random() * ms);
  };
  every(() => {
    client.pending.set(`lt${client.index}:${++client.seq}`, Date.now());
    client.send({
      type: 'chat_send',
      mode: 'public',
      recipients: [],
      text: `lt${client.index}:${client.seq}`
    });
  }, CHAT_INTERVAL_MS);
  every(sendSignal, SIGNAL_INTERVAL_MS);
  every(() => client.send({
    type: 'media_state_change',
    mediaState: { audio: Math.random() > 0.5, video: true }
  }), MEDIA_INTERVAL_MS);
}

function connectClient(url, roomId, secret) {
  const index = nextClientIndex++;
  const username = `loaduser${index}`;
  const token = generateToken({ roomId, username, role: Role.USER, secret });
  const client = {
    index,
    username,
    id: null,
    ws: null,
    authed: false,
    open: false,
    seq: 0,
    pending: new Map(),
    timers: [],
    closing: false,
    send(obj) {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    }
  };
  clients.push(client);

  return new Promise(resolve => {
    const st = stage;
    let sentAt = 0;
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (ok) {
        st.joinOk++;
        st.joinLatencies.push(Date.now() - sentAt);
      } else {
        st.joinFail++;
      }
      resolve(ok);
    };
    const timeout = setTimeout(() => finish(false), JOIN_TIMEOUT_MS);

    const ws = new WebSocket(url);
    client.ws = ws;
    ws.on('open', () => {
      client.open = true;
      sentAt = Date.now();
      client.send({ type: 'auth', username, token, roomId });
    });
    ws.on('message', raw => {
      stage.received++;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }
      if (msg.type === 'auth_success') {
        client.authed = true;
        client.id = msg.user && msg.user.id;
        finish(true);
        startTraffic(client);
      } else if (msg.type === 'auth_error') {
        finish(false);
      } else if (msg.type === 'chat_deliver' && msg.message.senderUsername === username) {
        const t0 = client.pending.get(msg.message.text);
        if (t0) {
          client.pending.delete(msg.message.text);
          stage.chatLatencies.push(Date.now() - t0);
        }
      } else if (msg.type === 'error' || msg.type === 'kicked') {
        stage.errors++;
      }
    });
    ws.on('error', () => {
      if (!settled) finish(false);
      else stage.errors++;
    });
    ws.on('close', () => {
      client.open = false;
      client.timers.forEach(t => { clearInterval(t); clearTimeout(t); });
      if (!settled) finish(false);
      else if (client.authed && !client.closing) stage.disconnects++;
      client.authed = false;
    });
  });
}

async function runStage(target, url, roomId, secret, pid) {
  stage = newStage(target);
  const need = target - clients.filter(c => c.authed).length;
  for (let i = 0; i < need; i += JOIN_BATCH) {
    const batch = [];
    for (let j = 0; j < Math.min(JOIN_BATCH, need - i); j++) {
      batch.push(connectClient(url, roomId, secret));
    }
    await Promise.all(batch);
    await sleep(JOIN_BATCH_GAP_MS);
  }

  // Measurement window starts once the joins have settled
  await sleep(2000);
  stage.received = 0;
  stage.chatLatencies = [];
  const cpu0 = readCpuTicks(pid);
  const t0 = Date.now();
  await sleep(durationSec * 1000);
  const elapsed = (Date.now() - t0) / 1000;
  const cpuPct = ((readCpuTicks(pid) - cpu0) / CLK_TCK / elapsed) * 100;

  const s = stage;
  const attempted = s.joinOk + s.joinFail;
  return {
    target,
    connected: clients.filter(c => c.authed).length,
    joinOk: s.joinOk,
    joinFail: s.joinFail,
    joinFailRate: attempted ? s.joinFail / attempted : 0,
    joinP50: pct(s.joinLatencies, 0.5),
    joinP95: pct(s.joinLatencies, 0.95),
    joinMax: pct(s.joinLatencies, 1),
    chatSamples: s.chatLatencies.length,
    chatP50: pct(s.chatLatencies, 0.5),
    chatP95: pct(s.chatLatencies, 0.95),
    chatMax: pct(s.chatLatencies, 1),
    msgPerSec: s.received / elapsed,
    cpuPct,
    rssMb: readRssMb(pid),
    errors: s.errors,
    disconnects: s.disconnects
  };
}

async function main() {
  const port = Number(args.port) || await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server/src/index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore'
  });
  let exiting = false;
  child.on('exit', code => {
    if (!exiting) {
      console.error(`Server exited unexpectedly (code ${code})`);
      process.exit(1);
    }
  });

  const results = [];
  let breaking = null;
  try {
    await waitForHealth(port, 15000);
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/data/server-config.json'), 'utf8'));
    const url = `ws://127.0.0.1:${port}`;
    console.log(`Server pid ${child.pid} on port ${port}; stages ${stages.join(',')}, ${durationSec}s each`);

    for (const target of stages) {
      const r = await runStage(target, url, config.roomId, config.serverSecret, child.pid);
      results.push(r);
      console.log(JSON.stringify(r));
      if (r.joinFailRate > MAX_JOIN_FAILURE_RATE) {
        breaking = { target, reason: `join failure rate ${(r.joinFailRate * 100).toFixed(1)}% > 5%` };
        break;
      }
      if (r.chatP95 !== null && r.chatP95 > MAX_P95_CHAT_MS) {
        breaking = { target, reason: `p95 chat latency ${r.chatP95}ms > ${MAX_P95_CHAT_MS}ms` };
        break;
      }
    }
  } finally {
    exiting = true;
    clients.forEach(c => {
      c.closing = true;
      c.timers.forEach(t => { clearInterval(t); clearTimeout(t); });
      try { c.ws.terminate(); } catch (e) { /* already closed */ }
    });
    child.kill('SIGTERM');
    await sleep(300);
  }

  console.log('\nRESULT ' + JSON.stringify({ results, breaking }));
  if (breaking) console.log(`Breaking point at ${breaking.target} users: ${breaking.reason}`);
  else console.log('No breaking point reached in the configured stages.');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
