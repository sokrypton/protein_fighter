// Plays the game headless and checks it holds together: serves the folder, opens it in
// headless Chrome over the DevTools protocol, starts a one-player fight against the CPU
// on hard, and drives P1 through a walk, a block, punches, kicks, a heat shock and a PAE
// click, watching for exceptions and for the moves to register.
//
//     node tests/play.js            one player against the CPU
//     node tests/play.js --remote   a host and a guest in two browsers, over PeerJS
//
// Needs Chrome at the usual macOS path (or CHROME=/path/to/chrome) and python3 for the
// server. Each browser draws with software OpenGL, so a run takes a minute or two.
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HTTP = 8700 + Math.floor(Math.random() * 200), DEV = 9300 + Math.floor(Math.random() * 200);
const remote = process.argv.includes('--remote'), relay = process.argv.includes('--relay');   // --relay: both sides may use only the TURN relay (?relay=1), so the relay path itself is what is tested
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn('python3', ['-m', 'http.server', String(HTTP), '--directory', ROOT], { stdio: 'ignore' });
const browsers = [];
function launch(port) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pf-chrome-'));
  const b = spawn(CHROME, ['--headless=new', '--no-sandbox', '--mute-audio', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  browsers.push(b); return b;
}
async function tab(port) {
  let made; for (let i = 0; i < 60; i++) { try { made = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json(); break; } catch {} await sleep(250); }
  if (!made) throw new Error('Chrome did not answer on port ' + port);
  const ws = new WebSocket(made.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = {}; const errors = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map(a => a.value ?? a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const key = async (k, type) => send('Input.dispatchKeyEvent', { type, key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, text: type === 'keyDown' && k.length === 1 ? k : undefined });
  const tap = async k => { await key(k, 'keyDown'); await sleep(50); await key(k, 'keyUp'); };
  const hold = async (k, ms) => { await key(k, 'keyDown'); await sleep(ms); await key(k, 'keyUp'); };
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 720, deviceScaleFactor: 1, mobile: false });
  return { send, ev, key, tap, hold, errors, ws };
}
const state = t => t.ev(`(() => { const g = window.proteinFighter, [a, b] = g.fighters; return JSON.stringify({ phase: g.phase, mode: g.mode, p1: { x: Math.round(a.x), hp: a.hp, action: a.action, special: a.specialAt > 0 }, p2: { x: Math.round(b.x), hp: b.hp, action: b.action } }); })()`);
let failures = 0;
const check = (ok, what) => { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) failures++; };

async function solo() {
  launch(DEV); const t = await tab(DEV);
  await t.send('Page.navigate', { url: `http://localhost:${HTTP}/index.html` }); await sleep(4000);
  check(await t.ev(`!!window.proteinFighter && window.proteinFighter.fighters.length === 2`), 'the game booted with two fighters');
  await t.ev(`document.querySelector('[data-level="hard"]').click(); document.getElementById('one').click(); 'go'`); await sleep(400);
  // count what happens to P1 and P2 from here on
  await t.ev(`window.__c = { blocks: 0, hurt: 0, hitsGiven: 0, thrown: 0, shock: 0 }; const g = window.proteinFighter; let b = false, h = false, k = 0, th = false;
    setInterval(() => { const [p, c] = g.fighters; if (p.blockStun > 0 && !b) window.__c.blocks++; b = p.blockStun > 0; if (c.stun > 0 && !h) window.__c.hitsGiven++; h = c.stun > 0;
      if (p.stun > 0 && !k) window.__c.hurt++; k = p.stun > 0; if ((c.action === 'thrown' || p.action === 'thrown') && !th) window.__c.thrown++; th = c.action === 'thrown' || p.action === 'thrown';
      if (p.action === 'special' || p.action === 'roll') window.__c.shock = 1; }, 16); 'counting'`);
  await t.hold('d', 1800);                       // walk in
  await t.hold('a', 3000);                       // hold back: block whatever comes
  for (let i = 0; i < 6; i++) { await t.tap(i % 2 ? 'f' : 'g'); await sleep(450); }   // punches and kicks
  for (let i = 0; i < 5; i++) {   // heat shock: punch and kick together, tried until P1 is free to throw it
    await t.key('f', 'keyDown'); await t.key('g', 'keyDown'); await sleep(60); await t.key('f', 'keyUp'); await t.key('g', 'keyUp');
    await sleep(900);
    if (await t.ev(`window.__c.shock`)) break;
  }
  await t.key('d', 'keyDown'); await sleep(600); await t.tap('f'); await sleep(200); await t.key('d', 'keyUp');   // forward + punch: a throw if close
  await sleep(1500);
  await t.ev(`(() => { const c = document.getElementById('pae0'), r = c.getBoundingClientRect(); c.onclick({ clientX: r.left + r.width * 0.3, clientY: r.top + r.height * 0.6 }); return 'clicked'; })()`);
  await sleep(300);
  const c = JSON.parse(await t.ev(`JSON.stringify(window.__c)`)), s = JSON.parse(await state(t));
  const picked = await t.ev(`(window.proteinFighter.viewer.residueSelection || window.proteinFighter.viewer.renderer?.residueSelection || new Set()).size`);
  console.log('  counts', JSON.stringify(c), '| state', JSON.stringify(s));
  check(s.phase !== 'ready', 'the fight started');
  check(c.hitsGiven + c.hurt + c.blocks > 0, 'blows were exchanged (hits given, taken or blocked)');
  check(c.shock === 1, 'the special came out on punch + kick');
  // Which leg kicks: either, over many kicks from a whole body; only the sound one once
  // the other is battered. Forced from a clear state each time, as a fight would not allow.
  const kicks = async n => { const seen = new Set(); for (let i = 0; i < n; i++) { seen.add(await t.ev(`(() => { const G = window.proteinFighter, f = G.fighters[0]; Object.assign(f, { stun: 0, blockStun: 0, cooldown: 0, action: 'idle', t: 0, y: 0 }); G.attack(f, 'kick'); return f.limb; })()`)); await sleep(60); } return [...seen].sort().join(''); };
  check(await kicks(14) === 'lr', 'a whole body kicks with either leg over fourteen kicks');
  await t.ev(`(() => { const f = window.proteinFighter.fighters[0]; for (const i of f.form.legSide.l) f.unfold[i] = 0.8; return 'left leg battered'; })()`);
  check(await kicks(8) === 'r', 'with its left leg battered it kicks with the right every time');
  check(picked > 0, 'a click on the PAE map selected residues on the body');
  check(t.errors.length === 0, 'no exceptions or console errors' + (t.errors.length ? ': ' + t.errors.slice(0, 3).join(' | ') : ''));
  t.ws.close();
}

async function pair() {
  launch(DEV); launch(DEV + 1);
  const host = await tab(DEV), guest = await tab(DEV + 1);
  await host.send('Page.navigate', { url: `http://localhost:${HTTP}/index.html${relay ? '?relay=1' : ''}` }); await sleep(4000);
  await host.ev(`document.querySelector('[data-players="3"]').click(); document.getElementById('one').click(); 'hosting'`);
  let link = '';
  for (let i = 0; i < 50 && !link.startsWith('http'); i++) { await sleep(500); link = await host.ev(`document.getElementById('joinlink').value`); }
  check(link.startsWith('http'), 'the host got a join link: ' + link);
  check(await host.ev(`!!document.querySelector('#qr img')`), 'and drew it as a QR code');
  if (!link.startsWith('http')) return;
  await guest.send('Page.navigate', { url: link.replace(/^https?:\/\/[^/]+/, `http://localhost:${HTTP}`) + (relay ? '&relay=1' : '') });
  let hs = {}; for (let i = 0; i < 30 && hs.phase !== 'playing'; i++) { await sleep(500); hs = JSON.parse(await state(host)); }
  check(hs.mode === 3 && hs.phase === 'playing', 'the fight started on the host when the guest connected');
  const x0 = (await state(host).then(JSON.parse)).p2.x;
  await guest.hold('a', 2000); await guest.tap('f'); await sleep(800);   // a long hold: headless draws a few frames a second, and the fight steps at most three times a frame
  const x1 = (await state(host).then(JSON.parse)).p2.x, gs = JSON.parse(await state(guest));
  check(Math.abs(x1 - x0) > 8, `the guest's keys moved P2 on the host (${x0} → ${x1})`);   // a few steps: headless draws a few frames a second
  check(Math.abs(gs.p2.x - x1) < 40, `the guest sees P2 near where the host has it (${gs.p2.x} vs ${x1})`);
  // The route taken, from the guest's own connection: a relay at both ends when only the relay was allowed.
  // ...read from its stats, which name the pair in use a moment after the channel opens: asked a few times
  let route = 'no pair';
  for (let i = 0; i < 10 && route === 'no pair'; i++) { route = await guest.ev(`(async () => { const pc = Object.values(window.Net.peer().connections).flat()[0].peerConnection; const st = await pc.getStats(); let pair = null; st.forEach(r => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r; }); if (!pair) return 'no pair'; const l = st.get(pair.localCandidateId), r = st.get(pair.remoteCandidateId); return (l ? l.candidateType : '?') + ' → ' + (r ? r.candidateType : '?'); })()`); if (route === 'no pair') await sleep(500); }
  check(relay ? route === 'relay → relay' : route !== 'no pair', `the guest's route to the host is ${route}${relay ? ' (relay only was asked for)' : ''}`);
  check(await host.ev(`window.Net.ice().iceServers.some(s => s.username && s.credential)`) && await guest.ev(`window.Net.ice().iceServers.some(s => s.username && s.credential)`), 'both sides hold TURN credentials from the worker');
  // Pause sync: host pauses with escape, guest reflects pause; guest resumes with go button
  await host.ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))'); await sleep(500);
  check(await guest.ev('window.proteinFighter.phase') === 'paused' && await guest.ev('document.getElementById("title").textContent') === 'PAUSED', 'the guest paused when the host paused');
  await guest.ev('document.getElementById("go").click()'); await sleep(600);
  check(await host.ev('window.proteinFighter.phase') === 'playing' && await guest.ev('window.proteinFighter.phase') === 'playing', 'the fight resumed on both when the guest clicked resume');
  // The round ends: the host's REFOLD button is not on the guest (a click there would do
  // nothing), which is told the host refolds; the host's REFOLD moves both on.
  await host.ev(`window.proteinFighter.fighters[1].hp = 0; 'knocked out'`);   // the tick sees it and calls the knockout
  let over = false; for (let i = 0; i < 100 && !over; i++) { await sleep(1000); over = await guest.ev(`window.proteinFighter.phase === 'over' && !document.getElementById('overlay').hidden`); }   // the knockout's collapse takes a minute of real time headless
  check(over && await guest.ev(`document.getElementById('go').hidden && document.getElementById('modes').hidden && document.getElementById('msg').textContent === 'the host refolds'`), 'the guest saw the round end with no button and "the host refolds"');
  await host.ev(`document.getElementById('go').click(); 'refold'`);
  let next = false; for (let i = 0; i < 20 && !next; i++) { await sleep(500); next = await host.ev(`window.proteinFighter.phase === 'playing'`) && await guest.ev(`window.proteinFighter.phase === 'playing' && document.getElementById('overlay').hidden`); }
  check(next, "the host's REFOLD started the next round on both sides");
  // The signaling link drops (as it does when a phone sleeps or the server hiccups):
  // the match carries on over the data channel, the status line says so, the peer
  // comes back under the same id, and a newcomer can still use the same link.
  const idBefore = await host.ev(`window.Net.peer().id`);
  await host.ev(`window.Net.peer().socket._socket.close(); 'dropped'`); await sleep(1500);
  const p2a = (await state(host).then(JSON.parse)).p2.x;
  await guest.hold('d', 2000); await sleep(800);
  const p2b = (await state(host).then(JSON.parse)).p2.x, during = JSON.parse(await state(host));
  check(during.phase === 'playing' && Math.abs(p2b - p2a) >= 8, `the host's signaling socket closed and the match went on (P2 ${p2a} → ${p2b})`);
  check(/signal lost/.test(await host.ev(`document.getElementById('netstat').textContent`)) || await host.ev(`window.Net.peer().open`), 'the status line said the signal was lost, or it was already back');
  let back = false; for (let i = 0; i < 40 && !back; i++) { await sleep(500); back = await host.ev(`window.Net.peer().open && window.Net.peer().id === ${JSON.stringify(idBefore)}`); }
  check(back, 'the host reconnected to the signaling server under the same id');
  const watcher = await tab(DEV + 1);
  await watcher.send('Page.navigate', { url: link.replace(/^https?:\/\/[^/]+/, `http://localhost:${HTTP}`) + '&watch=1' }); await sleep(7000);
  check(await host.ev(`window.proteinFighter.net.watchers === 1`), 'a watcher joined on the same link afterwards');
  check(host.errors.length === 0 && guest.errors.length === 0, 'no exceptions on either side' + ([...host.errors, ...guest.errors].length ? ': ' + [...host.errors, ...guest.errors].slice(0, 3).join(' | ') : ''));
  host.ws.close(); guest.ws.close(); watcher.ws.close();
}

(async () => {
  await sleep(800);
  try { if (remote) await pair(); else await solo(); }
  catch (e) { console.error(e); failures++; }
  for (const b of browsers) b.kill(); server.kill();
  console.log(failures ? `${failures} failure(s)` : 'ok');
  process.exit(failures ? 1 : 0);
})();
