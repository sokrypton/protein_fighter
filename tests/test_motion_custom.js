// Test makeForm and Motion with custom PDB rig across all test proteins
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

const window = {};
for (const file of ['rig.js', 'custom_pdb.js', 'motion.js']) {
  new Function('window', fs.readFileSync(path.join(ROOT, file), 'utf8'))(window);
}
const { DomainRig } = window.Rig;
const { buildCustomFighter } = window.CustomPdb;

const MOVES = {
  punch:    { duration: 0.24, active: 0.07, window: 0.07, damage: 7,  stun: 0.16, push: 120, fist: 'rarm',      text: 'HIT' },
  kick:     { duration: 0.40, active: 0.13, window: 0.09, damage: 10, stun: 0.24, push: 260, fist: 'rleg_foot', text: 'CRUNCH' },
};
const PAE_BIN = 4;

function makeForm(name, data) {
  const rig = new DomainRig(data), n = rig.n, D = rig.domains;
  const motion = window.Motion.create(rig, { MOVES, JUMP_V: 655, JUMP_VX: 240, SQUAT: 0.07, LANDING: 0.2 });
  const legs = new Uint8Array(n);
  for (const side of ['lleg', 'rleg']) {
    const idx = [...(D[side + '_thigh'] || []), ...(D[side + '_shin'] || []), ...(D[side + '_foot'] || [])];
    if (!idx.length) continue;
    let lo = Math.min(...idx), hi = Math.max(...idx);
    while (lo > 0 && rig.owner[lo - 1] === null) lo--;
    while (hi < n - 1 && rig.owner[hi + 1] === null) hi++;
    for (let i = Math.max(0, lo - 1); i <= Math.min(n - 1, hi + 1); i++) legs[i] = 1;
  }
  const legIdx = [...legs.keys()].filter(i => legs[i]);
  const legSide = Object.fromEntries(['l', 'r'].map(s => [s, legIdx.filter(i => rig.owner[i] && rig.owner[i].startsWith(s + 'leg'))]));
  for (const s of ['l', 'r']) if (!legSide[s].length) legSide[s] = legIdx;
  const armSide = { l: D.larm || [], r: D.rarm || [] };
  const reach = D.rarm?.length ? rig.armParam('rarm') : [];
  const reachL = D.larm?.length ? rig.armParam('larm') : [];
  const fist = (D.rarm || []).filter((_, k) => reach[k] > 0.64);
  const fistL = (D.larm || []).filter((_, k) => reachL[k] > 0.64);
  const torso = D.torso || [];
  const pb = Math.ceil(n / PAE_BIN);
  const paeCount = new Float32Array(pb * pb);
  const paeSum = new Float32Array(pb * pb);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) paeCount[(i / PAE_BIN | 0) * pb + (j / PAE_BIN | 0)]++;

  return {
    name, rig, n, motion, legs, legIdx, legSide, armSide, fist, fistL,
    armIdx: [...(D.larm || []), ...(D.rarm || [])],
    kick: [...(D.rleg_shin || []), ...(D.rleg_foot || [])],
    frontKick: [...(D.lleg_shin || []), ...(D.lleg_foot || [])],
    torso,
    mid: torso.length ? torso[torso.length >> 1] : 0,
    pb, paeCount, paeSum, paeFrames: new Float64Array(n * 12),
    chainBreaks: rig.chainBreaks,
    basePlddt: data.base_plddt ? Float32Array.from(data.base_plddt) : null,
  };
}

const testFiles = [
  { name: 'hemoglobin', file: 'scripts/hemoglobin_alpha.pdb' },
  { name: 'gfp', file: 'scripts/gfp.pdb' },
  { name: 'fus', file: 'scripts/fus.pdb' },
];

for (const { name, file } of testFiles) {
  const pdbText = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const res = buildCustomFighter(name, pdbText);
  const form = makeForm(name, res.rigData);

  console.log(`\n=== Testing motion for ${name} ===`);
  console.log(`  Residues: ${form.n} (Core: ${res.coreResidues}, Legs: 104)`);
  console.log(`  Arm: residues ${res.armRange.start}..${res.armRange.end}, Fist hitbox residues: ${form.fist.length}`);
  console.log(`  Core pLDDT: ${res.coreMeanPlddt}`);

  const dummyFighter = {
    form,
    x: 80, y: 0, vx: 0, vy: 0, facing: -1, hp: res.coreMeanPlddt, crouch: false,
    action: 'punch', t: 0.08, hit: false, stun: 0, blockStun: 0,
    seed: 12.34,
    unfold: new Float32Array(form.n),
    coords: null,
  };

  const actions = ['punch', 'kick', 'idle', 'walk'];
  for (const act of actions) {
    dummyFighter.action = act;
    const coords = form.motion.update(dummyFighter, {
      dt: 0.016, clock: 1.0,
      arms: { l: 0, r: 0 }, legs: { l: 0, r: 0 },
      mean: 0, sag: 0, crawl: 0, tired: 0, kickRange: 1,
    });
    const valid = coords.every(p => p.every(Number.isFinite));
    if (!valid) {
      console.error(`FAIL: ${name} motion on action ${act} produced non-finite coords!`);
      process.exit(1);
    }
  }
  console.log(`  PASS: Poses for punch, kick, idle, and walk all valid!`);
}

console.log('\nALL MOTION CUSTOM RIG TESTS PASSED!');
