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
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--mute-audio', '--use-mock-keychain', '--password-store=basic', `--remote-debugging-port=${DEV}`, `--user-data-dir=${dir}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
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
  // the id field takes every key, the fight's own included (1, 2 and 3 are P2's strikes; w, a, s, d and f P1's)
  await ev(`document.getElementById('uniprot-input').focus(); 'focused'`);
  for (const ch of '1ubq2wasd3f') { await key(ch, 'keyDown'); await key(ch, 'keyUp'); }
  const typed = await ev(`document.getElementById('uniprot-input').value`);
  check(typed === '1ubq2wasd3f', `the id field takes digits and the fight's keys as text (${JSON.stringify(typed)})`);
  await ev(`document.getElementById('uniprot-input').value = ''; document.getElementById('uniprot-input').blur(); 'cleared'`);
  // the file, dropped on the panel as a file is: no network needed here
  await ev(`(async () => { const text = await (await fetch('tests/structures/gfp.pdb')).text(); const dt = new DataTransfer(); dt.items.add(new File([text], 'gfp.pdb')); document.getElementById('drop-zone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return 'dropped'; })()`);
  for (let i = 0; i < 60 && (await ev(`document.getElementById('btn-load-custom').hidden`)); i++) await sleep(250);
  const status = await ev(`document.getElementById('custom-status').innerText`);
  check(/238 residues/.test(status) && /pLDDT 97/.test(status), 'GFP was read from the dropped file: 238 residues, mean pLDDT 97');
  check(/HURRICANE/.test(status), 'a small protein, so its special is the hurricane spin');
  // a file dropped anywhere on the page opens the card and reads it: the same GFP, dropped on the arena with the card closed
  await ev(`document.getElementById('custom-modal').hidden = true; 'closed'`);
  await ev(`(async () => { const text = await (await fetch('tests/structures/gfp.pdb')).text(); const dt = new DataTransfer(); dt.items.add(new File([text], 'gfp2.pdb')); document.getElementById('stage').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return 'dropped anywhere'; })()`);
  await sleep(1500);
  check(await ev(`!document.getElementById('custom-modal').hidden && /gfp2/.test(document.getElementById('custom-status').innerText)`), 'a file dropped on the arena opened the card and was read');
  // the arena behind the card keeps its own picture: py2Dmol's one GL canvas is the arena's layer, and the preview drawing into it must not show there
  const arenaOk = await ev(`(() => { const st = document.getElementById('stage'), cs = st.querySelectorAll('canvas'); const layer = [...cs].find(c => c.hasAttribute('data-py2dmol-layer')); return { canvases: cs.length, layerHidden: layer ? getComputedStyle(layer).display === 'none' : null }; })()`);
  check(arenaOk && arenaOk.layerHidden === true, `the arena's GL layer is hidden while the preview draws (${JSON.stringify(arenaOk)})`);
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
  // the rig's reference is what carries confidence and the error floor, so a fighter that
  // arrives without them is a fighter drawn flat: this is the check that was missing when
  // the reference stopped reaching the form
  const conf = JSON.parse(await ev(`JSON.stringify((() => { const F = window.proteinFighter.forms.custom1; const b = F.basePlddt ? Array.from(F.basePlddt) : null, f = F.paeBase ? Array.from(F.paeBase) : null;
    const mm = a => a ? { min: +Math.min(...a).toFixed(1), max: +Math.max(...a).toFixed(1), mean: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(1) } : null;
    return { plddt: mm(b), floor: mm(f) }; })())`));
  check(!!conf.plddt && conf.plddt.min < 90 && conf.plddt.max > 95, `GFP's own confidence comes through with it (${conf.plddt ? conf.plddt.min + ' to ' + conf.plddt.max + ', mean ' + conf.plddt.mean : 'missing'})`);
  // ...and this file carries no predicted error, so there is no floor under its map: a
  // structure with nothing to doubt has a reference that sits on it.
  check(!!conf.floor && conf.floor.max === 0, `a file with no predicted error has no floor under its map (${conf.floor ? conf.floor.max : 'missing'})`);
  // A model that does carry one gets it back through the form. This is the path a
  // fetched AlphaFold model takes, and the check that was missing when the reference
  // stopped reaching the form: the panel went blank and nothing else said so.
  const floor = JSON.parse(await ev(`(async () => { try {
    const G = window.proteinFighter;
    const text = await (await fetch('tests/structures/gfp.pdb')).text();
    const n = window.CustomPdb.caTrace(text).coords.length;
    // a two-block error: each half of the chain sure of itself, 24 A between them
    const pae = new Uint8Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) pae[i * n + j] = ((i < n / 2) === (j < n / 2)) ? 8 : 192;
    const built = window.CustomPdb.buildCustomFighter('synthetic', text, { pae });
    const F = G.makeForm('probe', built.rigData);
    const b = F.paeBase ? Array.from(F.paeBase) : null;
    const X = built.rigData.ca_xyz, R = built.rigData.ref;
    const moved = R.reduce((s, p, i) => s + Math.hypot(p[0] - X[i][0], p[1] - X[i][1], p[2] - X[i][2]), 0) / X.length;
    return JSON.stringify({ max: b ? +Math.max(...b).toFixed(1) : null, nonzero: b ? b.filter(v => v > 0.01).length : 0, px: b ? b.length : 0, moved: +moved.toFixed(1), n });
  } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); } })()`));
  if (floor.err) check(false, `the model with a predicted error threw: ${floor.err}`);
  check(floor.moved > 2, `a predicted error moves the reference off the model (${floor.moved} A a residue)`);
  check(floor.nonzero > floor.px / 4 && floor.max > 5, `and comes back as the floor under the map (${floor.nonzero} of ${floor.px} pixels, up to ${floor.max} A)`);
  const form = JSON.parse(await ev(`JSON.stringify((() => { const G = window.proteinFighter, F = G.forms.custom1; return { n: F.n, special: G.SPECIAL.custom1, name: document.getElementById('name1').textContent }; })())`));
  check(form.n > 238 && form.special === 'spin' && /^GFP/.test(form.name), `P2 is ${form.name} with grown limbs (${form.n} residues), special ${form.special}`);
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
  // A SHORT SCREEN STILL COLOURS BY CONFIDENCE. A phone on its side is under 520 pixels
  // tall, where the two map panels are hidden for want of room - and the work that
  // updates them used to carry the lDDT with it, so the bodies fought in the colours
  // they were dealt at the bell and never darkened where a blow landed.
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 420, deviceScaleFactor: 1, mobile: false });
  await sleep(1200);
  const short0 = JSON.parse(await ev(`JSON.stringify((() => { const f = window.proteinFighter.fighters[1];
    return { shortScreen: matchMedia('(max-height: 520px)').matches, under90: Array.from(f.shown).filter(v => v < 90).length }; })())`));
  check(short0.shortScreen, 'the screen is a phone\'s on its side (under 520px tall)');
  await ev(`(() => { const f = window.proteinFighter.fighters[1]; for (let i = 120; i < 260 && i < f.form.n; i++) f.unfold[i] = 0.9; return 'x'; })()`);
  await sleep(2500);
  const short1 = JSON.parse(await ev(`JSON.stringify((() => { const f = window.proteinFighter.fighters[1];
    return { under90: Array.from(f.shown).filter(v => v < 90).length, lowest: +Math.min(...f.shown).toFixed(0) }; })())`));
  check(short1.under90 > short0.under90 + 20, `damage still darkens the bodies there (${short0.under90} residues under 90 → ${short1.under90}, lowest ${short1.lowest})`);
  check(!errors.length, 'no exceptions or console errors' + (errors.length ? ': ' + errors[0].slice(0, 200) : ''));
  ws.close(); chrome.kill(); server.kill();
  console.log(failures ? `${failures} failure(s)` : 'ok');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); chrome.kill(); server.kill(); process.exit(1); });
