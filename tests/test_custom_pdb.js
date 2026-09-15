// Test custom PDB building and posing
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

const window = {};
for (const file of ['rig.js', 'custom_pdb.js']) {
  new Function('window', fs.readFileSync(path.join(ROOT, file), 'utf8'))(window);
}
const { DomainRig, rotX: X, rotY: Y, matMul3: mul, CA_STEP } = window.Rig;
const { buildCustomFighter } = window.CustomPdb;

const pdbs = [
  { name: 'hemoglobin_alpha', file: 'scripts/hemoglobin_alpha.pdb' },
  { name: 'gfp', file: 'scripts/gfp.pdb' },
  { name: 'fus', file: 'scripts/fus.pdb' },
];

for (const { name, file } of pdbs) {
  const fullPath = path.join(ROOT, file);
  if (!fs.existsSync(fullPath)) {
    console.log(`Skipping ${name}, file not found: ${file}`);
    continue;
  }
  const text = fs.readFileSync(fullPath, 'utf8');
  const res = buildCustomFighter(name, text);
  console.log(`\n=== Testing ${name} ===`);
  console.log(`Core residues: ${res.coreResidues}, Total residues: ${res.totalResidues}`);
  console.log(`Core mean pLDDT: ${res.coreMeanPlddt}`);
  console.log(`Detected arm range: ${res.armRange.start} - ${res.armRange.end} (${res.armRange.end - res.armRange.start + 1} residues)`);

  const rig = new DomainRig(res.rigData);
  console.log(`Rig created: ${rig.n} CAs, domains: ${Object.keys(rig.domains).join(', ')}`);

  // Pose through several test transforms
  const arm = (side, lift) => mul(Y(side * Math.PI / 2), X(lift));
  const poses = [
    {},
    { root_R: X(0.3), rarm_upper: arm(1, -1), rarm_lower: arm(1, 0.95), lleg_upper: X(0.4), lleg_lower: X(-0.9), lleg_foot: X(0.2) },
    { root_R: X(-1.0), rarm_upper: arm(1, 0.5), rarm_lower: arm(1, 0.5), rleg_upper: X(1.2), rleg_lower: X(-2.2) },
  ];

  for (let k = 0; k < poses.length; k++) {
    const p = rig.pose(poses[k]);
    const valid = p.every(pt => pt.every(Number.isFinite));
    if (!valid) {
      console.error(`FAIL: Pose ${k} produced NaN or non-finite values!`);
      process.exit(1);
    }
  }
  console.log(`PASS: All poses valid for ${name}!`);
}
console.log('\nALL CUSTOM PDB RIG TESTS PASSED!');
