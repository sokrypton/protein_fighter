// Remote play: two devices, one fight. The host runs the whole game and streams the
// state; the guest sends its key presses and draws what it is sent. The link between
// them is a WebRTC data channel set up through PeerJS's public signaling server, and
// the guest gets in by scanning a QR code of the host's join link (or opening it).
(function () {
  let peer = null, conn = null, timer = 0;
  let outbox = [], outboxFor = null;   // what this guest still has to say, and to whom
  let player = null, rtt = 0, pinger = 0;
  const watchers = new Set();

  // Where the two browsers find a route to each other. STUN from Google and from
  // Cloudflare (two providers, so one blocked somewhere still leaves the other), and a
  // TURN relay for the pairs with no direct route (a phone on cellular, a Wi-Fi that
  // isolates its clients, a strict NAT): Cloudflare's, with short-lived credentials
  // minted by the worker in worker/ (PeerJS's own default relays, eu-0 and
  // us-0.turn.peerjs.com, no longer resolve; checked September 2026). A TURN of your
  // own instead: ?turn=turn:host:port&tu=user&tp=password on the host's page, which the
  // join link then carries to the guest; ?relay=1 uses only the relay.
  const parseUrls = u => Array.isArray(u) ? u : u.includes(',') ? u.split(',').map(s => s.trim()) : [u];
  const params = new URLSearchParams(location.search);
  const manualTurn = params.get('turn') ? { urls: parseUrls(params.get('turn')), username: params.get('tu') || '', credential: params.get('tp') || '' } : null;
  const STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] };
  // The config every RTCPeerConnection is made with (PeerJS reads it at each
  // negotiation, so a relay that arrives later still serves the next connection).
  const ICE = { iceServers: manualTurn ? [STUN, manualTurn] : [STUN] };
  if (params.get('relay')) ICE.iceTransportPolicy = 'relay';
  let relay = manualTurn;   // the TURN in use, if any
  const turnQuery = () => manualTurn ? `&turn=${encodeURIComponent(manualTurn.urls.join(','))}&tu=${encodeURIComponent(manualTurn.username)}&tp=${encodeURIComponent(manualTurn.credential)}` : '';
  // The relay's credentials, fetched when a connection is about to be made (not at
  // page load: a solo player never needs them, and the fetch would race the page's
  // own boot). Waited on for up to TURN_WAIT, then the connection goes ahead without,
  // and the credentials still land in the config for later if they arrive. A failed
  // fetch is tried again next time. 🔴 The wait is measured from when the fetch is
  // made, never from page load: a 2 s race from load lost to the game's own start-up
  // on a slow device, and the host then had no relay at all.
  const TURN_ENDPOINT = 'https://protein-fighter-turn.sokrypton.workers.dev/';
  const TURN_WAIT = 5000;
  let turnFetch = null;
  function fetchTurn() {
    if (manualTurn) return Promise.resolve();
    if (!turnFetch) turnFetch = fetch(TURN_ENDPOINT).then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))).then(data => {
      const servers = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
      const turn = servers.find(s => s && s.username && s.credential);
      if (!turn) throw new Error('no TURN in the answer');
      relay = turn; ICE.iceServers = [STUN, ...servers];
    }).catch(e => { console.warn('TURN credentials', e); turnFetch = null; });
    return turnFetch;
  }
  const turnReady = () => Promise.race([fetchTurn(), new Promise(r => setTimeout(r, TURN_WAIT))]);
  // A connection is begun after the relay's credentials are in (or given up on); a
  // stop() in the meantime makes that beginning a no-op.
  let activeSession = 0;

  // The channel keeps at most this much unsent: when the link can't keep up, packets are
  // dropped rather than queued, so the guest sees a late frame instead of an ever later one.
  const MAX_QUEUED = 48 * 1024;
  const OUTBOX_MAX = 8;   // what a guest may be holding to say when its channel comes back
  // Who this guest is, across its own reconnects and no further: a page that is reloaded
  // is a new challenger, which is what a reload is for.
  let myToken = null;
  const whoAmI = () => (myToken || (myToken = 'g' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)));
  // What went wrong, from the connection itself, for the message on screen.
  const why = c => {
    const pc = c && c.peerConnection;
    if (!pc) return 'no connection was attempted';
    return `ICE ${pc.iceConnectionState}, connection ${pc.connectionState}, signaling ${pc.signalingState}`;
  };
  // The link as it stands, for the status line: the connection's state and how much is
  // waiting to go out.
  const status = () => {
    if (!conn) return null;
    const pc = conn.peerConnection, dc = conn.dataChannel;
    return { open: !!conn.open, ice: pc ? pc.iceConnectionState : '-', queued: dc ? dc.bufferedAmount : 0, signal: !!(peer && peer.open), relay: !!relay };
  };
  const OPEN_TIMEOUT = 20000;   // ms for the data channel to open before giving up
  // 🔴 PEERJS'S CLOSE EVENT IS NOT RELIABLE FOR AN ABRUPT DROP. A guest whose browser
  // died, whose network went, or whose phone slept never closes its channel cleanly, and
  // the host keeps its connection marked open for good - so it refused every newcomer as
  // a second challenger while the newcomer sat on "waiting for the host". Measured: a
  // killed guest, a fresh one on the same link, 35 s of nothing. So both ends keep their
  // own clock: the player pings every second and the host streams fifteen times a second,
  // and a side that has heard nothing for this long treats the link as gone.
  const SILENCE = 6000, WATCH_EVERY = 1000;
  let watchdog = 0;
  // 🔴 THE SIGNALING LINK IS NOT THE GAME LINK. PeerJS keeps a WebSocket to its server
  // with a heartbeat every five seconds; a phone that sleeps, a tab put in the
  // background, a Wi-Fi handoff or the server's own hiccup closes it, and PeerJS then
  // emits an error of type 'network' ("Lost connection to server.") and a 'disconnected'
  // event - while every open data channel carries on untouched (lib/peer.ts: disconnect()
  // closes the socket only). This code used to treat any error as fatal and tear the
  // whole game down, live channel included; so a match died at the first blip of the
  // server. Now: errors that are about the server link are ridden out, the peer is
  // reconnected under the same id (peer.reconnect() reuses it, so the join link stays
  // good) with a backoff, and only what cannot be recovered is reported.
  const FATAL = new Set(['browser-incompatible', 'invalid-id', 'invalid-key', 'ssl-unavailable']);
  const newPeer = () => new Peer({ config: ICE });
  const ID_TIMEOUT = 15000;   // ms for the signaling server to hand out an id
  let reconnectTimer = 0, backoff = 1000;
  const clearReconnect = () => { clearTimeout(reconnectTimer); reconnectTimer = 0; backoff = 1000; };
  // Ride out a signaling drop: reconnect with the same id, 1 s, 2 s, 4 s … 15 s apart.
  // 'unavailable-id' on the way back means the server still holds the old session (it
  // lets one go after a minute of silence): tried again like any other drop.
  function keepSignaling(p, onFatal) {
    const again = () => {
      if (p !== peer || p.destroyed || !p.disconnected) return;
      if (!navigator.onLine) { reconnectTimer = setTimeout(again, 2000); return; }
      try { p.reconnect(); } catch (e) { console.warn('reconnect', e); }
    };
    const schedule = () => { if (p !== peer || p.destroyed || reconnectTimer) return; reconnectTimer = setTimeout(() => { reconnectTimer = 0; again(); }, backoff); backoff = Math.min(15000, backoff * 2); };
    p.on('disconnected', () => { if (p !== peer || p.destroyed) return; schedule(); });
    p.on('open', () => { clearReconnect(); });
    p.on('error', e => {
      const type = e && e.type || String(e);
      if (FATAL.has(type)) { onFatal(type, e); return; }
      if (type === 'unavailable-id') { schedule(); return; }   // coming back: the old session is not gone yet
      if (type === 'server-error' && !p._lastServerId && !p.open) { onFatal(type, e); return; }   // never got an id at all
      // 'network', 'socket-error', 'socket-closed', 'disconnected', 'server-error' later,
      // 'webrtc', 'peer-unavailable' on the host: the server link, not the game; ridden out
      console.warn('PeerJS', type, e && e.message || '');
      if (p.disconnected) schedule();
    });
    // Back from sleep or back on line: no need to wait out the backoff.
    const wake = () => { if (p === peer && !p.destroyed && p.disconnected) { clearReconnect(); again(); } };
    window.addEventListener('online', wake); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  }
  const fatalText = type => type === 'browser-incompatible' ? 'This browser has no WebRTC.' : type === 'ssl-unavailable' ? 'The signaling server has no SSL.' : `Signaling failed (${type}).`;

  const joinId = () => new URLSearchParams(location.search).get('join');
  const joinLink = id => `${location.origin}${location.pathname}?join=${encodeURIComponent(id)}${turnQuery()}`;

  // Draw the join link as a QR code into `el` (qrcode-generator, if it loaded).
  function showQR(el, link) {
    el.innerHTML = '';
    if (typeof qrcode === 'undefined') return false;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(link); qr.make();
      el.innerHTML = qr.createImgTag(5, 8);
      return true;
    } catch (e) { console.warn('QR code failed', e); return false; }
  }

  function stop() {
    activeSession++;
    clearReconnect();
    clearInterval(pinger); pinger = 0;
    clearInterval(watchdog); watchdog = 0;
    for (const w of watchers) { try { w.close(); } catch {} } watchers.clear(); player = null;
    try { conn && conn.close(); } catch {}
    try { peer && peer.destroy(); } catch {}
    clearTimeout(timer); timer = 0;
    conn = peer = null;
  }

  // Host: get an id from the signaling server, hand back the join link, and take
  // connections: one player (the guest), any number of watchers. Each says which it is
  // in a hello. A player that drops can come back on the same link; the host's id lives
  // on. Messages from the player arrive on onInput; the returned send() streams state to
  // everyone. Pings from the player are answered here and its round trip reported.
  function host({ onLink, onGuest, onWatcher, onInput, onClose, onError, onPing }) {
    stop();
    if (typeof Peer === 'undefined') { onError('The connection library did not load. Is the network up?'); return null; }
    const session = activeSession;
    const start = () => {
      if (session !== activeSession) return;
      peer = newPeer();
      let linked = false;   // the link is handed over once; a reconnect under the same id changes nothing
      // No id in time: the signaling server (0.peerjs.com) is not answering, or something
      // between here and it blocks WebSockets. Said so, rather than "Getting a code…" for good.
      timer = setTimeout(() => { if (!linked) onError('The signaling server did not answer. Is the network up, or does it block WebSockets?'); }, ID_TIMEOUT);
      peer.on('open', id => { if (!linked) { linked = true; clearTimeout(timer); onLink(joinLink(id)); } });
      keepSignaling(peer, type => onError(fatalText(type)));
      // The player has gone quiet: let it go, as if it had closed, so the seat is free.
      const dropPlayer = () => { const old = player; player = conn = null; try { old && old.close(); } catch {} onClose(); };
      watchdog = setInterval(() => { if (player && performance.now() - player.heard > SILENCE) dropPlayer(); }, WATCH_EVERY);
      peer.on('connection', c => {
        let role = null;
        c.heard = performance.now();
        const t = setTimeout(() => { if (!c.open) { try { c.close(); } catch {} } }, OPEN_TIMEOUT);
        c.on('open', () => clearTimeout(t));
        c.on('data', m => {
          if (!m) return;
          c.heard = performance.now();
          if (m.t === 'hello') {
            if (m.role === 'watch') { role = 'watch'; watchers.add(c); onWatcher && onWatcher(watchers.size); return; }
            // 🔴 A CHALLENGER COMING BACK IS NOT A SECOND CHALLENGER. One seat, and a
            // newcomer waits while the one in it is still being heard from - which is
            // right for a stranger and wrong for the guest whose link just went, because
            // the host does not know it went. Its channel reads open for a few seconds
            // more, so the guest reconnecting three seconds later was turned away, tried
            // again, and took six to nine seconds to sit back down in a fight it had
            // never left. So a guest carries a token of its own, the same across its
            // reconnects and no one else's, and one that matches takes the seat at once.
            c.who = m.who || null;
            if (player && player !== c) {
              const resuming = c.who && player.who === c.who;
              if (!resuming && player.open && performance.now() - player.heard < SILENCE / 2) { try { c.close(); } catch {} return; }
              const old = player; player = null; try { old.close(); } catch {}
            }
            role = 'player'; player = conn = c; onGuest(); return;
          }
          if (m.t === 'ping') { if (role === 'player') { rtt = m.rtt || 0; onPing && onPing(rtt); } try { c.send({ t: 'pong', k: m.k }); } catch {} return; }
          if (role === 'player') onInput(m);
        });
        c.on('close', () => { if (role === 'watch') { watchers.delete(c); onWatcher && onWatcher(watchers.size); } else if (c === player) { player = conn = null; onClose(); } });
        c.on('iceStateChanged', st => { if (c === player && (st === 'failed' || st === 'closed' || st === 'disconnected')) c.heard = Math.min(c.heard, performance.now() - SILENCE / 2); });   // a failing link is heard from less
        c.on('error', e => onError(String(e)));
      });
    };
    turnReady().then(start);
    // 🔴 A PACKET CARRYING EVENTS IS NOT DROPPABLE. The gate is there so a slow link does
    // not grow a queue without bound, and a state packet may be dropped freely: another
    // is along in a fifteenth of a second and says everything this one did. The EVENTS
    // riding in it may not. They are one-off - a hit landing, a round resetting, a custom
    // fighter arriving - the sender clears them whether they went or not, and nothing
    // asks again. A guest joining while the channel was busy lost the host's custom
    // fighter that way and fell back to a built-in body, which is drawn flat: no
    // confidence colours, and nothing anywhere saying why.
    const droppable = m => !(m && m.h && m.h.ev && m.h.ev.length);
    // ...and send() says whether the player got it, so the caller can hold on to what it
    // could not deliver rather than clearing it regardless.
    const to = (c, m) => {
      if (!c || !c.open) return false;
      const dc = c.dataChannel;
      if (dc && dc.bufferedAmount > MAX_QUEUED && droppable(m)) return false;
      try { c.send(m); return true; } catch (e) { console.error('send failed', e); return false; }
    };
    return { send: m => { const went = to(player, m); for (const w of watchers) to(w, m); return went; } };
  }

  // Guest (or watcher): connect to the host's id and say which. State arrives on
  // onState; the returned send() carries key presses back. A ping a second measures
  // the round trip (Net.rtt()).
  function join(id, { onOpen, onState, onClose, onError, role = 'player' }) {
    stop();
    // ...and the outbox outlives the connection, because the reconnect is exactly when it
    // is needed: the guest drops, everything here is torn down and rebuilt three seconds
    // later, and what it was holding to say has to cross that gap. Only a new host
    // empties it - a different game is not owed the last one's words.
    if (outboxFor !== id) { outbox = []; outboxFor = id; }
    if (typeof Peer === 'undefined') { onError('The connection library did not load. Is the network up?'); return null; }
    const session = activeSession;
    const start = () => {
      if (session !== activeSession) return;
      peer = newPeer();
      peer.on('error', e => { if (e && e.type === 'peer-unavailable') { clearTimeout(timer); onError('The host is not there. Ask for a fresh link.'); } });
      keepSignaling(peer, type => onError(fatalText(type)));
      let connected = false;   // one connection per peer: a reconnect to the server opens the peer again
      timer = setTimeout(() => { if (!connected) onError('The signaling server did not answer. Is the network up, or does it block WebSockets?'); }, ID_TIMEOUT);
      peer.on('open', () => {
        if (connected) return; connected = true; clearTimeout(timer);
        conn = peer.connect(id, { reliable: true });
        // The link is reported gone once, whichever notices first: the close event or the watchdog.
        let gone = false;
        const lost = () => { if (gone) return; gone = true; clearInterval(pinger); clearInterval(watchdog); pinger = watchdog = 0; onClose(); };
        timer = setTimeout(() => { if (!conn || !conn.open) onError(`No route to the host (${why(conn)}). Wi-Fi at both ends usually works; cellular needs a TURN relay of your own (see the README).`); }, OPEN_TIMEOUT);
        conn.on('open', () => {
          clearTimeout(timer);
          try { conn.send({ t: 'hello', role, who: whoAmI() }); } catch {}
          for (const m of outbox.splice(0)) { try { conn.send(m); } catch (e) { console.error('outbox', e); } }
          pinger = setInterval(() => { if (conn && conn.open) try { conn.send({ t: 'ping', k: performance.now(), rtt }); } catch {} }, 1000);
          // The host streams fifteen times a second; silence means the link is gone, however
          // open the channel claims to be, and closing it here is what brings the reconnect.
          conn.heard = performance.now();
          watchdog = setInterval(() => { if (conn && performance.now() - conn.heard > SILENCE) { const c = conn; conn = null; try { c.close(); } catch {} lost(); } }, WATCH_EVERY);
          onOpen();
        });
        conn.on('data', m => { if (conn) conn.heard = performance.now(); if (m && m.t === 'pong') rtt = Math.round(performance.now() - m.k); else onState(m); });
        conn.on('close', lost);
        conn.on('error', e => onError(String(e)));
      });
    };
    turnReady().then(start);
    // 🔴 WHAT THE GUEST COULD NOT SAY WAITS IN AN OUTBOX. The guest speaks rarely and
    // every word counts: which protein it picked, which fighter it loaded, a pause. There
    // is no stream to carry them again, so a message sent while the channel was between
    // connections - and the guest reconnects on its own after a silence - simply never
    // happened, and it would sit in a fight holding a fighter the host had never heard
    // of. Held here and said again when the channel opens. Keys are not kept: they are
    // pressed now or not at all, and a stale one would move a fighter by itself.
    return {
      send: m => {
        if (conn && conn.open) { try { conn.send(m); return true; } catch (e) { console.error('send failed', e); } }
        if (m && m.t !== 'in' && m.t !== 'ping') {
          const slot = outbox.findIndex(o => o.t === m.t);   // the newest of each kind stands
          if (slot >= 0) outbox[slot] = m; else if (outbox.length < OUTBOX_MAX) outbox.push(m);
        }
        return false;
      },
    };
  }

  const watching = () => !!new URLSearchParams(location.search).get('watch');
  window.Net = { joinId, watching, host, join, stop, showQR, status, rtt: () => rtt, peer: () => peer, ice: () => ICE };   // peer: for the tests, which drop its signaling socket
})();
