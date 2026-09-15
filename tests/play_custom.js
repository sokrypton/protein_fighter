// Plays a match against a custom PDB protein (FUS, low pLDDT) in headless Chrome
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HTTP = 8850 + Math.floor(Math.random() * 100), DEV = 9550 + Math.floor(Math.random() * 100);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn('python3', ['-m', 'http.server', String(HTTP), '--directory', ROOT], { stdio: 'ignore' });
let chrome;

function launch(port) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pf-custom-'));
  chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
}

async function tab(port) {
  let made;
  for (let i = 0; i < 60; i++) {
    try { made = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json(); break; }
    catch {}
    await sleep(250);
  }
  if (!made) throw new Error('Chrome did not answer on port ' + port);
  const ws = new WebSocket(made.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
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

let failures = 0;
const check = (ok, what) => { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) failures++; };

(async () => {
  try {
    launch(DEV);
    const t = await tab(DEV);
    await t.send('Page.navigate', { url: `http://localhost:${HTTP}/index.html` });
    await sleep(4000);

    check(await t.ev(`!!window.proteinFighter`), 'game initialized');

    // 1. Open custom modal and click FUS preset
    console.log('Selecting FUS (low-pLDDT protein) for P2...');
    await t.ev(`document.getElementById('btn-open-custom').click();`);
    await sleep(300);
    check(await t.ev(`!document.getElementById('custom-modal').hidden`), 'custom PDB modal opened');

    // Click FUS preset
    await t.ev(`document.querySelector('[data-preset="fus"]').click();`);
    await sleep(1000);

    const statusText = await t.ev(`document.getElementById('custom-status').innerText`);
    console.log('Status message:', statusText.replace(/\n/g, ' '));
    check(statusText.includes('FUS ready to fight'), 'FUS protein loaded and rigged');

    // Click "FIGHT THIS PROTEIN"
    await t.ev(`document.getElementById('btn-load-custom').click();`);
    await sleep(400);
    check(await t.ev(`document.getElementById('custom-modal').hidden`), 'modal closed after selection');

    // Verify P2 state
    const p2FormName = await t.ev(`window.proteinFighter.fighters[1].form.name`);
    const p2DisplayName = await t.ev(`window.proteinFighter.fighters[1].form.displayName`);
    const p2Hp = await t.ev(`window.proteinFighter.fighters[1].hp`);
    console.log(`P2 form: ${p2FormName}, name: ${p2DisplayName}, initial HP: ${p2Hp}`);

    check(p2FormName === 'custom', 'P2 form is set to custom');
    check(p2DisplayName === 'FUS', 'P2 display name is FUS');
    check(p2Hp < 80, `P2 starts with low-pLDDT handicap health (${p2Hp} HP < 80)`);

    // Start fight
    await t.ev(`document.getElementById('one').click();`);
    await sleep(500);

    // Track hits
    await t.ev(`window.__hits = 0; const c = window.proteinFighter.fighters[1];
      setInterval(() => { if (c.stun > 0) window.__hits++; }, 30);`);

    // P1 walks in and punches P2
    await t.hold('d', 1800);
    for (let i = 0; i < 5; i++) {
      await t.tap('f');
      await sleep(350);
    }

    const finalHp = await t.ev(`window.proteinFighter.fighters[1].hp`);
    const hitsTaken = await t.ev(`window.__hits`);
    console.log(`After punches: P2 HP went from ${p2Hp} -> ${finalHp} (${hitsTaken} stun ticks)`);

    check(finalHp < p2Hp, `P2 took damage from punches (${p2Hp} -> ${finalHp})`);

    // 2. Now test GFP with signature BARREL STUFF (barrel_trap)
    console.log('\nSelecting GFP (beta-barrel protein) for P2...');
    await t.ev(`document.getElementById('btn-open-custom').click();`);
    await sleep(300);
    await t.ev(`document.querySelector('[data-preset="gfp"]').click();`);
    await sleep(1000);

    const gfpStatus = await t.ev(`document.getElementById('custom-status').innerText`);
    console.log('GFP Status:', gfpStatus.replace(/\n/g, ' '));
    check(gfpStatus.includes('GFP ready to fight'), 'GFP protein loaded');
    check(gfpStatus.includes('BARREL STUFF'), 'Signature move detected as BARREL STUFF');
    check(gfpStatus.includes('Pure floating hover mode'), 'Pure floating hover mode indicated');

    await t.ev(`document.getElementById('btn-load-custom').click();`);
    await sleep(400);

    const gfpN = await t.ev(`window.proteinFighter.fighters[1].form.n`);
    const gfpFloating = await t.ev(`window.proteinFighter.fighters[1].form.isFloating`);
    const gfpSpecial = await t.ev(`window.proteinFighter.SPECIAL.custom`);
    console.log(`GFP form: n=${gfpN} residues, floating=${gfpFloating}, special=${gfpSpecial}`);
    check(gfpN === 238, `GFP has exactly 238 residues (pure structure, no fake legs)`);
    check(gfpFloating === true, `GFP fighter is floating`);
    check(gfpSpecial === 'barrel_trap', `GFP special is barrel_trap`);

    // Reset round to play with GFP
    await t.ev(`window.proteinFighter.resetRound();`);
    await sleep(400);

    // Setup listener to track trap and ejection
    await t.ev(`
      window.__trapLog = { trapped: false, thrown: false, minHp: 100 };
      setInterval(() => {
        const [p1, p2] = window.proteinFighter.fighters;
        if (p1.action === 'trapped') window.__trapLog.trapped = true;
        if (p1.action === 'thrown') window.__trapLog.thrown = true;
        if (p1.hp < window.__trapLog.minHp) window.__trapLog.minHp = p1.hp;
      }, 16);
    `);

    // Bring P2 close to P1 and fire GFP's BARREL TRAP
    console.log('Executing GFP BARREL TRAP special move...');
    await t.ev(`
      const [p1, p2] = window.proteinFighter.fighters;
      const dx = (p1.x + 35) - p2.x;
      p2.x += dx;
      for (let i = 0; i < p2.form.n; i++) { p2.coords[i][0] += dx; p2.prev[i][0] += dx; }
      p2.specialAt = -10;
      window.proteinFighter.attack(p2, 'barrel_trap');
    `);

    // Wait for containment and ejection sequence
    let sawTrapped = false, sawThrown = false;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      const log = await t.ev(`window.__trapLog`);
      if (log.trapped) sawTrapped = true;
      if (log.thrown || log.minHp < 100) { sawThrown = true; break; }
    }

    const log = await t.ev(`window.__trapLog`);
    console.log(`Trap log: sawTrapped=${sawTrapped}, sawThrown=${sawThrown}, minHp=${log.minHp}`);
    check(sawTrapped, 'P1 was sucked into GFP beta-barrel cavity (trapped)');
    check(sawThrown && log.minHp < 100, `P1 took damage and was ejected from barrel (HP dropped to ${log.minHp})`);

    check(t.errors.length === 0, 'no browser errors or exceptions' + (t.errors.length ? ': ' + t.errors.join(' | ') : ''));

    t.ws.close();
  } catch (err) {
    console.error('Test error:', err);
    failures++;
  } finally {
    if (chrome) chrome.kill();
    server.kill();
    console.log(failures ? `\n${failures} failure(s)` : '\nALL CUSTOM FIGHTER TESTS PASSED!');
    process.exit(failures ? 1 : 0);
  }
})();
