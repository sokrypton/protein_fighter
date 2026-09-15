// Test suite for mmCIF parsing, multi-chain handling, and rig generation.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
global.window = global;
require(path.join(ROOT, 'rig.js'));
const { parseCif, parsePdb, parseStructure, orientCore, detectArm, buildCustomFighter } = require(path.join(ROOT, 'custom_pdb.js'));
const { DomainRig } = global.window.Rig;
const motion = require(path.join(ROOT, 'motion.js'));

console.log('=== Test 1: Real AlphaFold mmCIF (scripts/gfp.cif) ===');
const cifText = fs.readFileSync(path.join(ROOT, 'scripts/gfp.cif'), 'utf8');
const pdbText = fs.readFileSync(path.join(ROOT, 'scripts/gfp.pdb'), 'utf8');

const casCif = parseCif(cifText);
const casPdb = parsePdb(pdbText);

assert.strictEqual(casCif.length, 238, 'GFP CIF should have 238 residues');
assert.strictEqual(casCif.length, casPdb.length, 'CIF and PDB should have identical residue count');

// Check coordinate agreement between CIF and PDB
for (let i = 0; i < casCif.length; i++) {
  assert.strictEqual(casCif[i].resSeq, casPdb[i].resSeq);
  assert.strictEqual(casCif[i].resName, casPdb[i].resName);
  assert.strictEqual(casCif[i].chain, casPdb[i].chain);
  assert(Math.abs(casCif[i].x - casPdb[i].x) < 1e-3, `X mismatch at residue ${i}`);
  assert(Math.abs(casCif[i].y - casPdb[i].y) < 1e-3, `Y mismatch at residue ${i}`);
  assert(Math.abs(casCif[i].z - casPdb[i].z) < 1e-3, `Z mismatch at residue ${i}`);
  assert(Math.abs(casCif[i].plddt - casPdb[i].plddt) < 1e-2, `pLDDT mismatch at residue ${i}`);
}
console.log('PASS: GFP mmCIF matches PDB atom-for-atom, coordinate-for-coordinate, and pLDDT-for-pLDDT!');

console.log('\n=== Test 2: Auto-detection via parseStructure ===');
assert.strictEqual(parseStructure(cifText).length, 238);
assert.strictEqual(parseStructure(pdbText).length, 238);
console.log('PASS: parseStructure correctly distinguishes and parses both mmCIF and PDB!');

console.log('\n=== Test 3: Multi-chain complex & Chain Breaks ===');
// Simulate an AF3 / Boltz / Chai heterodimer (Chain A: 30 residues, Chain B: 30 residues)
function generateMultiChainCif() {
  let s = 'data_multimer\n#\nloop_\n';
  s += '_atom_site.group_PDB\n_atom_site.id\n_atom_site.type_symbol\n_atom_site.label_atom_id\n';
  s += '_atom_site.label_comp_id\n_atom_site.label_asym_id\n_atom_site.label_seq_id\n';
  s += '_atom_site.Cartn_x\n_atom_site.Cartn_y\n_atom_site.Cartn_z\n';
  s += '_atom_site.B_iso_or_equiv\n';

  let id = 1;
  // Chain A: residues 1..30 along X axis
  for (let r = 1; r <= 30; r++) {
    s += `ATOM ${id++} C CA ALA A ${r} ${(r * 3.8).toFixed(3)} 0.000 0.000 88.00\n`;
  }
  // Chain B: residues 1..30 along Y axis
  for (let r = 1; r <= 30; r++) {
    s += `ATOM ${id++} C CA GLY B ${r} 0.000 ${(r * 3.8).toFixed(3)} 0.000 92.00\n`;
  }
  return s;
}

const multimerCif = generateMultiChainCif();
const multimerFighter = buildCustomFighter('DIMER', multimerCif);
assert.strictEqual(multimerFighter.coreResidues, 60, 'Dimer should have 60 core residues');
// Must have chain break at index 29 (between Chain A and Chain B)
const breaks = multimerFighter.rigData.chain_breaks;
assert(breaks.includes(29), 'Must register chain break between Chain A and Chain B at index 29');
console.log('PASS: Multi-chain complexes register internal chain breaks between chains:', breaks);

console.log('\n=== Test 4: 0.0–1.0 pLDDT scale auto-scaling ===');
// Some models output raw pLDDT in [0, 1] range (e.g. 0.85 instead of 85.0)
function generateZeroToOneCif() {
  let s = 'data_raw_scale\n#\nloop_\n';
  s += '_atom_site.group_PDB\n_atom_site.id\n_atom_site.label_atom_id\n_atom_site.label_comp_id\n';
  s += '_atom_site.label_asym_id\n_atom_site.label_seq_id\n';
  s += '_atom_site.Cartn_x\n_atom_site.Cartn_y\n_atom_site.Cartn_z\n';
  s += '_atom_site.B_iso_or_equiv\n';

  for (let r = 1; r <= 25; r++) {
    s += `ATOM ${r} CA ALA A ${r} ${(r * 3.8).toFixed(3)} 0.000 0.000 0.75\n`;
  }
  return s;
}

const rawScaleCas = parseCif(generateZeroToOneCif());
assert.strictEqual(rawScaleCas.length, 25);
assert.strictEqual(rawScaleCas[0].plddt, 75.0, '0.75 should scale to 75.0 pLDDT');
console.log('PASS: 0.0-1.0 scale auto-detected and normalized to 0-100 (0.75 -> 75.0)!');

console.log('\n=== Test 5: ModelCIF _ma_qa_metric_local fallback ===');
// CIF with missing B_iso_or_equiv but explicit _ma_qa_metric_local table
function generateModelCifTable() {
  let s = 'data_modelcif_table\n#\nloop_\n';
  s += '_atom_site.group_PDB\n_atom_site.id\n_atom_site.label_atom_id\n_atom_site.label_comp_id\n';
  s += '_atom_site.label_asym_id\n_atom_site.label_seq_id\n';
  s += '_atom_site.Cartn_x\n_atom_site.Cartn_y\n_atom_site.Cartn_z\n';

  for (let r = 1; r <= 20; r++) {
    s += `ATOM ${r} CA ALA A ${r} ${(r * 3.8).toFixed(3)} 0.000 0.000\n`;
  }

  s += '#\nloop_\n';
  s += '_ma_qa_metric_local.label_asym_id\n_ma_qa_metric_local.label_comp_id\n_ma_qa_metric_local.label_seq_id\n';
  s += '_ma_qa_metric_local.metric_id\n_ma_qa_metric_local.metric_value\n';
  for (let r = 1; r <= 20; r++) {
    s += `A ALA ${r} 1 ${(50 + r * 2).toFixed(2)}\n`;
  }
  return s;
}

const modelCifCas = parseCif(generateModelCifTable());
assert.strictEqual(modelCifCas.length, 20);
assert.strictEqual(modelCifCas[0].plddt, 52.0, 'Residue 1 pLDDT should be 52.0');
assert.strictEqual(modelCifCas[19].plddt, 90.0, 'Residue 20 pLDDT should be 90.0');
console.log('PASS: ModelCIF _ma_qa_metric_local table correctly parsed as fallback!');

console.log('\n=== Test 6: Full Motion IK simulation on CIF Fighter ===');
const gfpFighter = buildCustomFighter('GFP_CIF', cifText);
const rig = new DomainRig(gfpFighter.rigData);

const MOVES = {
  punch: { duration: 0.24, active: 0.07, window: 0.07, damage: 7, stun: 0.16, push: 120, fist: 'rarm', text: 'HIT' },
  kick:  { duration: 0.40, active: 0.13, window: 0.09, damage: 10, stun: 0.24, push: 260, fist: 'rleg_foot', text: 'CRUNCH' },
};
require(path.join(ROOT, 'motion.js'));
const motionInst = global.window.Motion.create(rig, { MOVES, JUMP_V: 655, JUMP_VX: 240, SQUAT: 0.07, LANDING: 0.2 });

const dummyFighter = {
  form: { rig, ...gfpFighter.rigData },
  x: 80, y: 0, vx: 0, vy: 0, facing: -1, hp: gfpFighter.coreMeanPlddt, crouch: false,
  action: 'punch', t: 0.08, hit: false, stun: 0, blockStun: 0,
  seed: 12.34,
  unfold: new Float32Array(gfpFighter.totalResidues),
  coords: null,
};

const actions = ['punch', 'kick', 'idle', 'walk'];
for (const act of actions) {
  dummyFighter.action = act;
  for (let frame = 0; frame < 15; frame++) {
    dummyFighter.t = frame / 60;
    const pose = motionInst.update(dummyFighter, {
      dt: 0.016, clock: 1.0 + frame / 60,
      arms: { l: 0, r: 0 }, legs: { l: 0, r: 0 },
      mean: 0, sag: 0, crawl: 0, tired: 0, kickRange: 1,
    });
    assert(Array.isArray(pose) && pose.length === gfpFighter.totalResidues);
    for (const p of pose) {
      assert(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]), `NaN in pose during ${act}`);
    }
  }
}
console.log('PASS: Full IK motion loop (punch, kick, idle, walk) executed flawlessly on CIF fighter!');

console.log('\n========================================');
console.log('ALL CIF TESTS PASSED SUCCESSFULLY!');
console.log('========================================\n');
