# Signaling Server Load Test Report

## Summary

- Max users handled cleanly: **1,000** (see the follow-up run below; the default run stops at 500). 0 join failures, 0 errors, 0 disconnects at every stage.
- Breaking point: **~1,500 users** in the follow-up run (CPU-bound). In the default run it was **not reached**. Neither stop condition (join failure rate > 5%, p95 chat latency > 2000 ms) triggered. At 500 users p95 chat round-trip was 20 ms and server CPU was about 40% of one core (RSS 101 MB).
- Caveat: the load generator ran on the same 4-core machine as the server (one Node process simulating all clients), so results are conservative for the server and the generator may have become a bottleneck before the server at higher counts.

## Follow-up: finding the breaking point

Command: `node scripts/load-test.js --stages 750,1000,1500,2000 --duration 20` (fresh server, users cumulative).

| Users | New joins ok/fail | Join p50 / p95 / max (ms) | Chat RTT p50 / p95 / max (ms) | Msgs recv/s | Server CPU % | Server RSS (MB) | Errors | Disconnects |
|---:|---:|---|---|---:|---:|---:|---:|---:|
| 750 | 750 / 0 | 32 / 64 / 89 | 8 / 27 / 47 | 74,643 | 55.8 | 108.8 | 0 | 0 |
| 1000 | 250 / 0 | 47 / 81 / 101 | 10 / 33 / 172 | 133,675 | 67.8 | 114.1 | 0 | 0 |
| 1500 | 295 / 205 | 70 / 365 / 2295 | 28,994 / 55,097 / 60,381 | 178,505 | 100.0 | 156.5 | 0 | 0 |

- **Handled cleanly: 1,000 simultaneous users** in one room (p95 chat latency 33 ms).
- **Breaking point: ~1,500 users.** The single Node.js process reaches 100% of one CPU core; 41% of new joins time out and chat latency jumps to ~30-55 s. Nothing crashes and no one is disconnected, the server just falls behind.
- The limit is the O(n²) broadcast fan-out (178,000 messages/s at 1,300 users). The earlier extrapolation of 700-900 users was too pessimistic.

## Context: what the server limits actually mean

Audio/video is peer-to-peer WebRTC (or relayed by TURN); it does not pass through this server. The server only handles signaling, chat, media-state and room broadcasts. Its load is dominated by fan-out: every room broadcast (join/leave, media state, public chat, room state) is sent to all n participants, so total messages grow roughly O(n^2) as n users each broadcast to n. That is what the table's msg/s column shows.

Practical per-room video limit is set by clients, not the server: in a full mesh each client uploads its video to every other peer, so upload bandwidth and encoding CPU scale with n-1. Expect roughly 6-10 video participants per room before client quality degrades, regardless of server capacity. Larger rooms need audio-only, an SFU, or listener-only participants.

## Method

`scripts/load-test.js` spawns its own server (free port, `HOST=127.0.0.1`), reads the existing `server/data/server-config.json` read-only for `serverSecret`/`roomId`, and mints user invite tokens with `generateToken`. Each stage adds users until the target count is connected (10 users per 100 ms), waits 2 s, then measures for `--duration` seconds (30 s here). Each client sends public chat about every 10 s, a `signal` to a random peer about every 5 s, a `media_state_change` about every 30 s (all with random initial offset), and a burst of signals to up to 5 peers on join. Users are cumulative across stages.

## Results

Command: `node scripts/load-test.js` (stages 10,25,50,100,200,300,500; 30 s per stage)

Join columns cover only the users added in that stage. Chat RTT is the time from a client sending a public chat to receiving its own broadcast, measured in the stage window. Msg/s is total messages received across all clients. CPU is server process CPU as a percent of one core over the window; RSS is server resident memory at end of window.

| Users | New joins ok/fail | Join p50 / p95 / max (ms) | Chat RTT p50 / p95 / max (ms) | Chat samples | Msgs recv/s | Server CPU % | Server RSS (MB) | Errors | Disconnects |
|---:|---:|---|---|---:|---:|---:|---:|---:|---:|
| 10 | 10 / 0 | 3 / 4 / 4 | 1 / 2 / 2 | 30 | 15 | 0.3 | 64.9 | 0 | 0 |
| 25 | 15 / 0 | 5 / 10 / 10 | 1 / 2 / 2 | 75 | 88 | 0.5 | 65.9 | 0 | 0 |
| 50 | 25 / 0 | 6 / 11 / 11 | 1 / 2 / 4 | 150 | 343 | 1.5 | 67.4 | 0 | 0 |
| 100 | 50 / 0 | 8 / 13 / 15 | 2 / 3 / 4 | 300 | 1,353 | 3.2 | 69.7 | 0 | 0 |
| 200 | 100 / 0 | 17 / 36 / 40 | 3 / 7 / 10 | 600 | 5,373 | 10.3 | 75.9 | 0 | 0 |
| 300 | 100 / 0 | 30 / 62 / 64 | 5 / 11 / 18 | 900 | 12,057 | 19.0 | 84.3 | 0 | 0 |
| 500 | 200 / 0 | 31 / 50 / 61 | 7 / 20 / 51 | 1,500 | 33,434 | 39.5 | 101.0 | 0 | 0 |

Msgs/s grows about quadratically (100 to 500 users, 5x users, about 25x messages), matching the O(n^2) fan-out. Server CPU is the likely first limit: extrapolating from 39.5% of a single core at 500 users, a single-threaded Node server would saturate at very roughly 700-900 users with this traffic mix (extrapolation, not measured).

## Machine

- CPU: 11th Gen Intel(R) Core(TM) i3-1115G4 @ 3.00GHz, 4 logical cores
- RAM: 19,639,688 kB (about 18.7 GiB) total
- OS: Linux 7.3.0-9-generic, Node v24.22.1
- Client and server on the same host over loopback (no network latency or bandwidth limits)

## How to rerun

```
node scripts/load-test.js [--stages 10,50,100] [--duration 30] [--port 18080]
```

Defaults: stages `10,25,50,100,200,300,500`, duration 30 s, random free port. Ramping stops at the first stage with join failure rate > 5% or p95 chat latency > 2000 ms and reports it as the breaking point. Total default runtime is about 4 minutes. Exits 0 after closing all sockets and killing the server child. To probe beyond 500, e.g. `--stages 500,750,1000,1500 --duration 20`.
