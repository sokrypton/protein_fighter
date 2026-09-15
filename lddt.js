// lDDT on alpha carbons, the score AlphaFold's pLDDT predicts: for every pair of
// residues within 15 A of each other in the reference, whether their distance now is
// within 0.5, 1, 2 and 4 A of what it was, the four averaged, per residue. No
// superposition, so a body that has moved whole scores as it did; only what has come
// apart locally counts. Pairs are prepared once from the reference (the stance at the
// bell), so a frame costs one pass over them.
//
// `group`, if given to prepare, keeps a pair only when both residues belong to the same
// group; the game passes none, and scores against the undamaged pose instead.
(function () {
  const RADIUS = 15, THRESHOLDS = [0.5, 1, 2, 4];
  // The pairs, from the reference coordinates: two Int32Arrays of residue indices and a
  // Float32Array of their reference distances, and how many pairs each residue is in.
  function prepare(ref, group) {
    const N = ref.length, cell = RADIUS, grid = new Map();
    const key = (x, y, z) => x + ',' + y + ',' + z;
    for (let i = 0; i < N; i++) { const p = ref[i], k = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
    const I = [], J = [], D = [], count = new Int32Array(N), r2 = RADIUS * RADIUS;
    for (let i = 0; i < N; i++) {
      const p = ref[i], gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell), gz = Math.floor(p[2] / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const idx = grid.get(key(gx + dx, gy + dy, gz + dz)); if (!idx) continue;
        for (const j of idx) {
          if (j <= i) continue;
          if (group && group[i] !== group[j]) continue;
          const q = ref[j], ddx = q[0] - p[0], ddy = q[1] - p[1], ddz = q[2] - p[2], d2 = ddx * ddx + ddy * ddy + ddz * ddz;
          if (d2 >= r2) continue;
          I.push(i); J.push(j); D.push(Math.sqrt(d2)); count[i]++; count[j]++;
        }
      }
    }
    return { n: N, i: Int32Array.from(I), j: Int32Array.from(J), d: Float32Array.from(D), count };
  }
  // The score per residue, 0..1, into `out` (a Float32Array of n). A residue in no pair
  // scores 1: nothing it could have lost. `ref`, if given, is the coordinates to score
  // against instead of the distances prepared: the body's undamaged pose this frame, so
  // that what moved with the body (a limb swung, a loop bent) scores as it should and
  // only what has come away from the pose counts.
  function score(pairs, coords, out, ref) {
    const { n, i: I, j: J, d: D, count } = pairs;
    const sum = pairs.sum || (pairs.sum = new Float32Array(n)); sum.fill(0);
    for (let k = 0; k < I.length; k++) {
      const a = coords[I[k]], b = coords[J[k]];
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      let want = D[k];
      if (ref) { const ra = ref[I[k]], rb = ref[J[k]], rx = rb[0] - ra[0], ry = rb[1] - ra[1], rz = rb[2] - ra[2]; want = Math.sqrt(rx * rx + ry * ry + rz * rz); }
      const diff = Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - want);
      let s = 0; for (const t of THRESHOLDS) if (diff < t) s++;
      sum[I[k]] += s; sum[J[k]] += s;
    }
    for (let r = 0; r < n; r++) out[r] = count[r] ? sum[r] / (4 * count[r]) : 1;
    return out;
  }
  const api = { prepare, score, RADIUS, THRESHOLDS };
  if (typeof window !== 'undefined') window.LDDT = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
