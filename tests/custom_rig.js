// A fighter out of any structure: custom_pdb.js reads a file through py2Dmol's parser,
// finds its limbs, rigs it, and the rig poses through the game's motion without a bond
// stretching. Run with:  node tests/custom_rig.js
// Ian Anderson's tests/test_custom_pdb.js, test_cif.js and test_motion_custom.js, on the
// module as it is now (parsing by py2Dmol, the armature by protrusion).
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const noop = () => {};
const el = () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop }, addEventListener: noop, appendChild: noop, getContext: () => null, setAttribute: noop });
global.window = global;
global.document = { createElement: el, createElementNS: el, querySelector: () => null, querySelectorAll: () => [], body: el(), head: el(), documentElement: el(), addEventListener: noop, getElementById: () => null };
global.navigator = { userAgent: 'node', platform: 'node' }; global.localStorage = { getItem: () => null, setItem: noop };
global.requestAnimationFrame = noop; global.self = global; global.HTMLElement = class {}; global.ResizeObserver = class { observe() {} };
try { new Function(fs.readFileSync(path.join(ROOT, 'vendor/py2Dmol.embed.min.js'), 'utf8'))(); } catch (e) { /* the viewer needs a page; the parser and the cartoon module are defined by then */ }
for (const file of ['rig.js', 'motion.js', 'lddt.js', 'custom_pdb.js']) new Function('window', fs.readFileSync(path.join(ROOT, file), 'utf8'))(window);
const { DomainRig, CA_STEP } = window.Rig, C = window.CustomPdb;
let failures = 0;
const check = (ok, what) => { console.log((ok ? '  ok   ' : '  FAIL ') + what); if (!ok) failures++; };

const MOVES = {
  punch: { duration: 0.24, active: 0.07, window: 0.07, damage: 7, stun: 0.16, push: 120, fist: 'rarm', text: 'HIT' },
  kick:  { duration: 0.40, active: 0.13, window: 0.09, damage: 10, stun: 0.24, push: 260, fist: 'rleg_foot', text: 'CRUNCH' },
};
// The motion as game.js drives it: a fighter posed through a punch, a kick, a walk.
function poseThrough(res) {
  const rig = new DomainRig(res.rigData), motion = window.Motion.create(rig, { MOVES, JUMP_V: 655, JUMP_VX: 240, SQUAT: 0.07, LANDING: 0.2 });
  const f = { form: { rig, motion, n: rig.n }, x: 0, y: 0, vx: 0, vy: 0, facing: 1, hp: 100, crouch: false, action: 'idle', t: 0, stun: 0, blockStun: 0, guard: false, squat: 0, landing: 0, landPower: 0, fatigue: 0, seed: 1, motion: null };
  const env = { clock: 0, dt: 1 / 60, sag: 0, crawl: 0, tired: 0.15, mean: 0, kickRange: 1, legs: { l: 0, r: 0 }, arms: { l: 0, r: 0 }, bounce: 0 };
  let worst = 0, minY = Infinity, worstAt = '';
  const breaks = rig.chainBreaks;
  const run = (action, frames, vx = 0) => {
    f.action = action; f.t = 0; f.vx = vx;
    for (let k = 0; k < frames; k++) {
      env.clock += 1 / 60; f.t += 1 / 60; f.x += vx / 60;
      const P = motion.update(f, env);
      for (let i = 0; i < P.length - 1; i++) { if (breaks.has(i)) continue; const e = Math.abs(Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1], P[i + 1][2] - P[i][2]) - rig.bondRest[i]); /* against the scaffold's own bond: a real protein has cis peptides */ if (e > worst) { worst = e; worstAt = `${i + 1}-${i + 2} (${rig.owner[i] || 'hinge'}/${rig.owner[i + 1] || 'hinge'}) in ${action}`; } }
      P.forEach((q, i) => { if (!q.every(Number.isFinite)) throw new Error('a non-finite coordinate in ' + action); if (rig.owner[i] && /leg_/.test(rig.owner[i])) minY = Math.min(minY, q[1]); });   // the feet: a loose body may hang below them
    }
  };
  run('idle', 30); run('punch', 16); run('idle', 10); run('kick', 26); run('idle', 10); run('walk', 60, 120); run('idle', 20);
  return { worst, minY, worstAt };
}

const FILES = [
  ['tests/structures/gfp.pdb', { special: 'spin', legsAdded: true, plddt: true }],
  ['tests/structures/gfp.cif', { special: 'spin', legsAdded: true, plddt: true }],
  ['tests/structures/hemoglobin_alpha.pdb', { special: 'spin', legsAdded: true, plddt: true }],
  ['tests/structures/fus.pdb', { special: 'special', plddt: true }],
  ['scripts/helix_fighter.pdb', { special: 'special', legsAdded: false, plddt: false, roles: ['head', 'larm', 'rarm', 'lleg', 'rleg'] }],
  ['scripts/barrel_fighter.pdb', { special: 'special', legsAdded: false, plddt: false }],
];
const results = {};
for (const [file, want] of FILES) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const res = C.buildCustomFighter(path.basename(file), text);
  results[file] = res;
  console.log(`${file}: ${res.residues} residues, pLDDT ${res.meanPlddt}${res.hasPlddt ? '' : ' (none in file)'}, ${res.special.special}, roles ${JSON.stringify(res.roles)}${res.legsAdded ? ', legs grown' : ''}`);
  check(res.special.special === want.special, `its size picks ${want.special}`);
  if (want.legsAdded !== undefined) check(res.legsAdded === want.legsAdded, want.legsAdded ? 'it has no leg-like protrusions, so helix legs are added' : 'its own legs are found');
  check(res.hasPlddt === want.plddt, want.plddt ? 'its pLDDT is read from the file' : 'a scaffold with no prediction in it reads as folded, its B-factors left alone');
  if (want.roles) for (const r of want.roles) check(!!res.roles[r], `a ${r} is found`);
  const D = res.rigData.domain_indices;
  check(['lleg_thigh', 'lleg_shin', 'lleg_foot', 'rleg_thigh', 'rleg_shin', 'rleg_foot', 'torso'].every(k => D[k] && D[k].length), 'every leg part and the torso have residues');
  check(res.rigData.n_ca === res.rigData.ca_xyz.length && res.rigData.base_plddt.length === res.rigData.n_ca, 'the rig data is consistent');
  const { worst, minY, worstAt } = poseThrough(res);
  check(worst < 0.15, `posed through a punch, a kick and a walk, every bond within 0.15 Å (worst ${worst.toFixed(3)} at ${worstAt})`);
  check(minY > -3, `the legs stay on the floor (lowest ${minY.toFixed(1)})`);
}
// The same structure as PDB and as mmCIF gives the same fighter.
{ const a = results['tests/structures/gfp.pdb'], b = results['tests/structures/gfp.cif'];
  const same = a.residues === b.residues && a.rigData.ca_xyz.every((p, i) => p.every((v, k) => Math.abs(v - b.rigData.ca_xyz[i][k]) < 1e-3)) && a.rigData.base_plddt.every((v, i) => Math.abs(v - b.rigData.base_plddt[i]) < 0.01);
  check(same, 'GFP as PDB and as mmCIF give the same fighter, coordinate for coordinate and pLDDT for pLDDT'); }
// Chain breaks: two chains, and a gap in one, are breaks the rig respects.
{ const two = fs.readFileSync(path.join(ROOT, 'tests/structures/hemoglobin_alpha.pdb'), 'utf8').split('\n').filter(l => l.startsWith('ATOM')).map((l, i) => l.slice(0, 21) + (i < 500 ? 'A' : 'B') + l.slice(22)).join('\n') + '\nEND\n';
  const t = C.caTrace('REMARK ALPHAFOLD\n' + two);
  check(t.breaks.size >= 1 && [...t.breaks].some(i => t.chains[i] !== t.chains[i + 1]), `a change of chain is a break (${[...t.breaks].join(', ')})`); }
// Missing density: a gap in the chain (residues absent from the file) is a break, and the
// rig and the physics hold no bond across it, however far apart the two ends sit.
{ const lines = fs.readFileSync(path.join(ROOT, 'tests/structures/gfp.pdb'), 'utf8').split('\n');
  const kept = lines.filter(l => { if (!l.startsWith('ATOM')) return true; const r = parseInt(l.slice(22, 26)); return r < 100 || r > 112; });
  const t = C.caTrace(kept.join('\n'));
  const gap = [...t.breaks].find(i => t.resnum[i] === 99 && t.resnum[i + 1] === 113);
  const res = C.buildCustomFighter('gapped', kept.join('\n'));
  // ...and in the rig (its indices moved by the limbs grown in): a break whose two
  // sides sit far apart in the scaffold, and stay so when posed, no bond pulling them
  const rig = new DomainRig(res.rigData), d = (a, c) => Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
  const wide = res.rigData.chain_breaks.filter(i => d(rig.bind[i], rig.bind[i + 1]) > 4.5);
  const posed = rig.pose({}), held = wide.every(i => Math.abs(d(posed[i], posed[i + 1]) - d(rig.bind[i], rig.bind[i + 1])) < 0.5);
  check(gap != null, `residues 100–112 missing: the chain breaks at 99|113`);
  check(wide.length >= 1 && held, `the rig carries the gap (${wide.map(i => d(rig.bind[i], rig.bind[i + 1]).toFixed(1) + ' Å').join(', ')}) and poses no bond across it`); }
// Too big to fight is refused before anything is built. And a model's own error travels
// as a REFERENCE STRUCTURE rather than as a matrix: custom_pdb.js inverts the matrix into
// a structure displaced by as much as the error said, and game.js regenerates the map
// from the pair. A matrix that is confident within each half of a chain and doubtful
// between them has to come back as exactly that.
{ const pdb = n => Array.from({ length: n }, (_, i) => `ATOM  ${String(i + 1).padStart(5)}  CA  GLY A${String(i + 1).padStart(4)}    ${(i * 3.8).toFixed(3).padStart(8)}   0.000   0.000  1.00 ${(50 + (i % 40)).toFixed(2)}           C`).join('\n');
  let refused = false; try { C.caTrace(pdb(3200)); } catch (e) { refused = /too many/.test(e.message); }
  check(refused, 'a structure over the size limit is refused');
  // ...on a real fold, not a straight line: a chain on one axis has no local frame to
  // measure anything in, and the regenerated map would be meaningless there.
  const gfpText = fs.readFileSync(path.join(ROOT, 'tests/structures/gfp.pdb'), 'utf8');
  const M = C.caTrace(gfpText).coords.length, half = M / 2, NEAR = 1, FAR = 24;
  const pae = new Uint8Array(M * M);   // the flat map is Angstrom x 8, as py2Dmol gives it
  for (let i = 0; i < M; i++) for (let j = 0; j < M; j++) pae[i * M + j] = 8 * ((i < half) === (j < half) ? NEAR : FAR);
  const res = C.buildCustomFighter('two halves', gfpText, { pae });
  check(!!res.ref && res.ref.length === res.totalResidues, `the model's error comes back as a reference structure (${res.ref ? res.ref.length : 0} points for ${res.totalResidues} residues)`);
  // a grown limb has no error of its own: its reference point IS its point
  const X = res.rigData.ca_xyz, grownIdx = [];
  for (const [, [from, to]] of Object.entries(res.grown)) for (let i = from - 1; i < to; i++) grownIdx.push(i);
  const grownStill = grownIdx.every(i => Math.abs(X[i][0] - res.ref[i][0]) < 1e-6 && Math.abs(X[i][1] - res.ref[i][1]) < 1e-6 && Math.abs(X[i][2] - res.ref[i][2]) < 1e-6);
  check(grownIdx.length > 0 && grownStill, `the ${grownIdx.length} grown residues sit on the model, so they carry no error`);
  // and the pair regenerates the map: near within a half, far between them
  const own = []; res.rigData.base_plddt.forEach((v, i) => { if (v !== res.grownPlddt) own.push(i); });
  const frame = (P, i) => { const n = P.length, c = Math.min(n - 2, Math.max(1, i)), a = P[c - 1], o = P[c], b = P[c + 1];
    let x1 = b[0] - o[0], y1 = b[1] - o[1], z1 = b[2] - o[2]; let l = Math.hypot(x1, y1, z1) || 1; x1 /= l; y1 /= l; z1 /= l;
    let x2 = a[0] - o[0], y2 = a[1] - o[1], z2 = a[2] - o[2]; const d = x2 * x1 + y2 * y1 + z2 * z1; x2 -= d * x1; y2 -= d * y1; z2 -= d * z1;
    l = Math.hypot(x2, y2, z2) || 1; x2 /= l; y2 /= l; z2 /= l;
    return [o, [x1, y1, z1], [x2, y2, z2], [y1 * z2 - z1 * y2, z1 * x2 - x1 * z2, x1 * y2 - y1 * x2]]; };
  const err = (i, j) => { const [o, e1, e2, e3] = frame(X, i), [q, f1, f2, f3] = frame(res.ref, i);
    const p = X[j], r = res.ref[j];
    const vx = p[0] - o[0], vy = p[1] - o[1], vz = p[2] - o[2], wx = r[0] - q[0], wy = r[1] - q[1], wz = r[2] - q[2];
    const dx = (e1[0] * vx + e1[1] * vy + e1[2] * vz) - (f1[0] * wx + f1[1] * wy + f1[2] * wz);
    const dy = (e2[0] * vx + e2[1] * vy + e2[2] * vz) - (f2[0] * wx + f2[1] * wy + f2[2] * wz);
    const dz = (e3[0] * vx + e3[1] * vy + e3[2] * vz) - (f3[0] * wx + f3[1] * wy + f3[2] * wz);
    return Math.hypot(dx, dy, dz); };
  let within = 0, wn = 0, between = 0, bn = 0;
  for (let a = 0; a < own.length; a += 3) for (let b = 0; b < own.length; b += 3) {
    if (a === b) continue;
    const sameHalf = (a < own.length / 2) === (b < own.length / 2);
    const e = err(own[a], own[b]);
    if (sameHalf) { within += e; wn++; } else { between += e; bn++; }
  }
  within /= Math.max(1, wn); between /= Math.max(1, bn);
  check(within < NEAR + 4 && between > FAR / 2, `the pair regenerates the map: ${within.toFixed(1)} A within a half against ${NEAR}, ${between.toFixed(1)} A between them against ${FAR}`);
}
console.log(failures ? `${failures} failure(s)` : 'ok');
process.exit(failures ? 1 : 0);
