/**
 * Connection Check — can this computer reach a server's ports?
 *
 *  - web:   the server's HTTPS/HTTP port (app, sign-in, chat) — GET /api/health
 *  - media: the media relay port (UDP 3478) — a STUN request, which the relay answers without login
 */

const CHECK_TIMEOUT_MS = 6000;
const MEDIA_RELAY_PORT = 3478;

class ConnectionCheck {
  static async checkWeb(origin, fetchImpl = fetch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${origin}/api/health`, { cache: 'no-store', signal: controller.signal });
      return res.ok ? { ok: true } : { ok: false, reason: `server error ${res.status}` };
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'no answer' : 'connection refused or blocked' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sends a STUN request to the relay. Reachable when an address comes back (srflx candidate), or
   * when gathering finishes without the browser reporting the server as unreachable (on the same
   * network the returned address equals the local one and is not reported separately). A relay
   * that is up answers within a second; no answer in time means UDP to it is blocked.
   */
  static checkMedia(hostname, RTC = RTCPeerConnection, timeoutMs = CHECK_TIMEOUT_MS) {
    return new Promise(resolve => {
      const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
      let pc;
      let settled = false;
      let failed = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { pc.close(); } catch (e) { /* already closed */ }
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, reason: 'no answer on UDP' }), timeoutMs);
      try {
        pc = new RTC({ iceServers: [{ urls: `stun:${host}:${MEDIA_RELAY_PORT}` }] });
      } catch (e) {
        finish({ ok: null, reason: 'check not supported' });
        return;
      }
      pc.onicecandidate = event => {
        if (event.candidate && event.candidate.type === 'srflx') finish({ ok: true });
      };
      pc.onicecandidateerror = event => {
        // 701: the STUN server could not be reached
        if (event.errorCode === 701) failed = true;
      };
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') finish(failed ? { ok: false, reason: 'no answer on UDP' } : { ok: true });
      };
      pc.createDataChannel('check');
      pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(() => finish({ ok: null, reason: 'check failed' }));
    });
  }

  /**
   * Full check of one server, plus this computer's firewall (desktop app only).
   * @returns {Promise<{web, media, firewall}>}
   */
  static async run(origin, native = (typeof window !== 'undefined' ? window.videocallNative : null)) {
    const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    const [web, media, firewall] = await Promise.all([
      ConnectionCheck.checkWeb(origin),
      ConnectionCheck.checkMedia(hostname),
      native?.firewallStatus ? native.firewallStatus().catch(() => null) : Promise.resolve(null)
    ]);
    return { web, media, firewall };
  }

  /**
   * What to tell the user. `fixable` means this computer's firewall is the likely cause and the
   * app can ask for permission to allow VideoCall.
   */
  static explain(origin, { web, media, firewall }) {
    const url = new URL(origin);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const blockedHere = !!firewall?.blocking;
    const problems = [];
    if (!web.ok) problems.push(`port ${port}/tcp (app and sign-in): ${web.reason}`);
    if (media.ok === false) problems.push(`port ${MEDIA_RELAY_PORT}/udp (audio and video relay): ${media.reason}`);

    if (!problems.length && !blockedHere) return { ok: true, fixable: false, problems, advice: 'All ports are reachable.' };
    if (blockedHere && firewall.canFix) {
      return {
        ok: false,
        fixable: true,
        problems,
        advice: problems.length
          ? `${firewall.firewall} on this computer may be blocking VideoCall. Allow it? Your system will ask for administrator permission.`
          : `${firewall.firewall} on this computer does not allow VideoCall yet. Allowing it lets calls connect directly, ` +
            'which is faster and gives better quality. Your system will ask for administrator permission.'
      };
    }
    return {
      ok: false,
      fixable: false,
      problems,
      advice: !web.ok
        ? `The server at ${url.host} cannot be reached. It may be turned off, or port ${port} is not open on the server. ` +
          'Ask the server admin to check "Network & ports" in the management panel.'
        : 'This network (for example a company or school Wi-Fi) or the server blocks the audio/video port. ' +
          'Calls may fail to connect; try another network or ask the server admin to open UDP ports 3478 and 49152-49452.'
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ConnectionCheck;
}
