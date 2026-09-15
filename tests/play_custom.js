// A custom protein as P2, in headless Chrome: GFP, dropped as a file, is read, rigged and fought; its
// special is the hurricane spin, since it is small; it takes damage; nothing throws.
// Begun by Ian Anderson. Run with:  node tests/play_custom.js
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HTTP = 8850 + Math.floor(Math.random() * 100), DEV = 9550 + Math.floor(Math.random() * 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn('python3', ['-m', 'http.server', String(HTTP), '--directory', ROOT], { stdio: 'ignore' });
const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pf-custom-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--mute-audio', `--remote-debugging-port=${DEV}`, `--user-data-dir=${dir}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
let failures = 0;
const check = (ok, what) => { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) failures++; };
(async () => {
  await sleep(800);
  let made; for (let i = 0; i < 60; i++) { try { made = await (await fetch(`http://127.0.0.1:${DEV}/json/new?about:blank`, { method: 'PUT' })).json(); break; } catch {} await sleep(250); }
  const ws = new WebSocket(made.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = {}; const errors = [];
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; } if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map(a => a.value ?? a.description).join(' ')); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const key = (k, type) => send('Input.dispatchKeyEvent', { type, key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, text: type === 'keyDown' && k.length === 1 ? k : undefined });
  const hold = async (k, ms) => { await key(k, 'keyDown'); await sleep(ms); await key(k, 'keyUp'); };
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://localhost:${HTTP}/index.html` }); await sleep(3500);
  check(await ev(`!!window.proteinFighter`), 'the game booted');
  // the modal, the preset, the analysis
  await ev(`document.querySelector('[data-pick="1:custom1"]').click(); 'x'`); await sleep(200);
  check(await ev(`!document.getElementById('custom-modal').hidden`), 'the custom-protein panel opened');
  // the file, dropped on the panel as a file is: no network needed here
  await ev(`(async () => { const text = await (await fetch('tests/structures/gfp.pdb')).text(); const dt = new DataTransfer(); dt.items.add(new File([text], 'gfp.pdb')); document.getElementById('drop-zone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return 'dropped'; })()`);
  for (let i = 0; i < 60 && (await ev(`document.getElementById('custom-actions').hidden`)); i++) await sleep(250);
  const status = await ev(`document.getElementById('custom-status').innerText`);
  check(/238 residues/.test(status) && /pLDDT 97/.test(status), 'GFP was read from the dropped file: 238 residues, mean pLDDT 97');
  check(/HURRICANE/.test(status), 'a small protein, so its special is the hurricane spin');
  // the preview: the built body in a viewer of its own in the card, turning on its own, and turned by a drag
  await sleep(800);
  const pv = JSON.parse(await ev(`JSON.stringify((() => { const el = document.getElementById('custom-preview'), c = el.querySelector('canvas'), p = window.proteinFighter.preview; return { shown: !el.hidden && !!c && c.clientWidth > 100 && c.clientHeight > 100, frames: p && p.objectsData.preview.frames.length, n: p && p.objectsData.preview.frames[0].coords.length }; })())`));
  check(pv.shown && pv.frames === 1 && pv.n > 238, `the card shows a preview of the built body (${pv.n} residues)`);
  const r0 = await ev(`JSON.stringify(window.proteinFighter.preview.viewerState.rotation)`); await sleep(1000);
  check(r0 !== await ev(`JSON.stringify(window.proteinFighter.preview.viewerState.rotation)`), 'the preview turns on its own');
  const box = JSON.parse(await ev(`JSON.stringify(document.getElementById('custom-preview').getBoundingClientRect())`)), mx = box.x + box.width / 2, my = box.y + box.height / 2;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mx, y: my, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mx + i * 12, y: my, button: 'left' }); await sleep(30); }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mx + 96, y: my, button: 'left', clickCount: 1 }); await sleep(500);
  check(await ev(`window.proteinFighter.preview.autoRotate === false`), 'a drag turns it by hand and stops the spin');
  await ev(`document.getElementById('btn-load-custom').click(); 'x'`); await sleep(1500);
  const form = JSON.parse(await ev(`JSON.stringify((() => { const G = window.proteinFighter, F = G.forms.custom1; return { n: F.n, special: G.SPECIAL.custom1, name: document.getElementById('name1').textContent }; })())`));
  check(form.n > 238 && form.special === 'spin' && form.name === 'GFP', `P2 is GFP with grown limbs (${form.n} residues), special ${form.special}`);
  // the fight: P1 walks in and strikes; P2 (the CPU, hard) fights back
  await ev(`document.querySelector('[data-level="hard"]').click(); document.getElementById('one').click(); 'go'`); await sleep(1000);
  const hp0 = JSON.parse(await ev(`JSON.stringify(window.proteinFighter.fighters.map(f => f.hp))`));
  let sawSpin = false;
  for (let i = 0; i < 10; i++) {
    await hold('d', 300); await hold('f', 60); await sleep(150); await hold('g', 60); await sleep(300);
    if (await ev(`window.proteinFighter.fighters[1].action === 'spin'`)) sawSpin = true;
  }
  // and the custom one's special, forced once so the spin itself is exercised
  // ...from a clear state, since a fighter mid-move, stunned or cooling down refuses a special
  await ev(`const G = window.proteinFighter, f = G.fighters[1]; Object.assign(f, { stun: 0, blockStun: 0, cooldown: 0, action: 'idle', t: 0, y: 0, vy: 0, squat: 0, specialAt: -99 }); G.attack(f, 'spin'); 'x'`);
  for (let i = 0; i < 20; i++) { await sleep(100); if (await ev(`window.proteinFighter.fighters[1].action === 'spin'`)) sawSpin = true; }
  await sleep(1500);
  const after = JSON.parse(await ev(`JSON.stringify((() => { const G = window.proteinFighter; return { hp: G.fighters.map(f => f.hp), plddt: [0, 1].map(i => document.getElementById('fold' + i).textContent), finite: G.fighters.every(f => f.coords.every(q => q.every(Number.isFinite))), minY: Math.min(...G.fighters.flatMap(f => f.coords.map(q => q[1]))) }; })())`));
  check(after.hp[1] < hp0[1] || after.hp[0] < hp0[0], `blows landed (hp ${hp0.join('/')} → ${after.hp.join('/')})`);
  check(sawSpin, 'GFP spun');
  check(after.finite && after.minY > -5, `every coordinate finite and above the floor (lowest ${after.minY.toFixed(1)})`);
  check(/pLDDT \d+/.test(after.plddt[1]), `the HUD shows GFP's pLDDT (${after.plddt[1]})`);
  check(!errors.length, 'no exceptions or console errors' + (errors.length ? ': ' + errors[0].slice(0, 200) : ''));
  ws.close(); chrome.kill(); server.kill();
  console.log(failures ? `${failures} failure(s)` : 'ok');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); chrome.kill(); server.kill(); process.exit(1); });
