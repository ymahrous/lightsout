// The connection to the game server: one WebSocket that puts itself back together.
//
// The server holds every room, so a dropped connection loses nothing. This module
// reconnects with backoff and re-sends the join, and the server replies with the
// current state. See docs/ARCHITECTURE.md for the message format.

const URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
const PING_MS = 20000, SILENCE_MS = 45000;

export function createNet({ onJoined, onState, onError, onStatus }) {
  let ws = null, want = null, tries = 0, timer = null, lastSeen = 0, status = 'idle';
  const setStatus = s => { if (s !== status) { status = s; onStatus(s); } };

  function connect() {
    clearTimeout(timer);
    if (!want) return;
    setStatus(tries ? 'retrying' : 'connecting');
    let sock;
    try { sock = ws = new WebSocket(URL); } catch (e) { return retry(); }
    sock.onopen = () => {
      if (ws !== sock) return;
      lastSeen = Date.now(); setStatus('open');
      const { code, token, prev, name, tint } = want;
      sock.send(JSON.stringify(code ? { t: 'join', code, token, prev, name, tint } : { t: 'create', token, name, tint }));
    };
    sock.onmessage = ev => {
      if (ws !== sock) return;
      lastSeen = Date.now(); tries = 0;
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'joined') { want.code = m.code; onJoined(m); }
      else if (m.t === 'state') onState(m);
      else if (m.t === 'err') onError(m.e, m);
      // 'bye' means the server is restarting; the close that follows triggers a reconnect to another one.
    };
    sock.onclose = () => { if (ws === sock) { ws = null; retry(); } };
    sock.onerror = () => {};
  }

  function retry() {
    if (!want) return setStatus('idle');
    setStatus('retrying');
    // Exponential backoff with jitter, so a restarted server is not hit by everyone at once.
    const wait = Math.min(8000, 300 * 2 ** tries) * (0.5 + Math.random() * 0.5);
    tries++;
    timer = setTimeout(connect, wait);
  }

  function hangUp() { const s = ws; ws = null; if (s) { try { s.close(1000); } catch (e) {} } }

  setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    if (Date.now() - lastSeen > SILENCE_MS) { hangUp(); return retry(); }   // the line went quiet: assume it is dead
    ws.send('{"t":"ping"}');
  }, PING_MS);
  // Phones suspend sockets in the background; check the line as soon as the page is visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && want && (!ws || ws.readyState > 1)) { clearTimeout(timer); tries = 0; connect(); }
  });

  return {
    get status() { return status; },
    create(profile) { hangUp(); want = { ...profile, code: null }; tries = 0; connect(); },
    join(code, profile) { hangUp(); want = { ...profile, code }; tries = 0; connect(); },
    /** Update what a future reconnect will send (a new name, an adopted token). */
    setProfile(patch) { if (want) Object.assign(want, patch); },
    /** Send a player action. False when the line is down. */
    act(a, v) { if (!ws || ws.readyState !== 1) return false; ws.send(JSON.stringify({ t: 'act', a, v })); return true; },
    /** Stop for good. With `tell`, give up the seat first. */
    leave(tell) {
      clearTimeout(timer); want = null;
      if (tell && ws && ws.readyState === 1) { try { ws.send('{"t":"leave"}'); } catch (e) {} }
      hangUp(); setStatus('idle');
    }
  };
}
