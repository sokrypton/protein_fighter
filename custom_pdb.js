// A fighter out of any structure. py2Dmol parses the file (PDB or mmCIF, the same reader
// the viewer uses, so what it draws is what fights); the C-alpha trace is turned to stand
// on its longest axis; the chain's protruding stretches are found and become the head,
// arms and legs by which way they stick out, the rest the torso; a body with no leg-like
// protrusions is given two ideal helix legs so it walks as the built-in fighters do; and
// the fold picks its special. Real pLDDT (the B-factors, or ModelCIF's) sets its
// starting health and how loosely it hangs, and a model from the AlphaFold DB comes with
// its real PAE. Begun by Ian Anderson (github.com/ianandersonlol): the orientation, the
// arm search and the helix legs are his; his floating body and signature moves gave way
// to a full armature and the game's own specials.
(function () {
  const CA_STEP = 3.8021;

  const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm3 = a => Math.hypot(a[0], a[1], a[2]);
  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round3 = v => Math.round(v * 1000) / 1000;
  const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);

  // ------------------------------------------------------------ the trace, from py2Dmol
  // The protein residues of the first model, in file order, with what py2Dmol read for
  // each: its pLDDT (a B-factor, scaled from 0-1 where a model wrote it so), its chain
  // and its number. A break in the chain is a change of chain, a jump in the numbering,
  // or two consecutive alpha carbons further apart than a bond (a missing loop).
  const MAX_RESIDUES = 3000;
  function caTrace(text) {
    if (!window.py2Dmol || !window.py2Dmol.framesFromText) throw new Error('py2Dmol is not loaded');
    const frame = window.py2Dmol.framesFromText(text, { biounit: false })[0];
    const types = frame.position_types || [], pl = frame.plddts || [], ch = frame.chains || [], rn = frame.residue_numbers || [];
    const coords = [], plddts = [], chains = [], resnum = [];
    frame.coords.forEach((p, i) => {
      if (types[i] && types[i] !== 'P') return;
      coords.push([p[0], p[1], p[2]]); plddts.push(pl[i]); chains.push(ch[i] ?? 'A'); resnum.push(rn[i] ?? i + 1);
    });
    if (!coords.length) throw new Error('no protein residues in that file');
    if (coords.length > MAX_RESIDUES) throw new Error(`${coords.length} residues is too many to fight (up to ${MAX_RESIDUES})`);
    // The B-factor column is pLDDT in a predicted model and nothing of the kind in a
    // crystal structure, whose B-factors would read as a body half unfolded; so it is
    // taken only from a file that says it is a prediction. No confidence reads as
    // confident, and a residue missing its value takes the others' mean.
    const predicted = /ALPHAFOLD|PREDICT(ED|ION)|MODEL ARCHIVE|_ma_qa_metric|_ma_model|pLDDT|BOLTZ|\bCHAI\b|COLABFOLD|ESMFOLD|OPENFOLD/i.test(text.slice(0, 40000));
    const known = predicted ? plddts.filter(v => Number.isFinite(v)) : [];
    const hasPlddt = known.length > 0 && !known.every(v => v === 0);
    if (!hasPlddt) plddts.fill(NaN);
    const fill = hasPlddt ? mean(known) : 90;
    for (let i = 0; i < plddts.length; i++) if (!Number.isFinite(plddts[i])) plddts[i] = fill;
    const breaks = new Set();
    for (let i = 0; i < coords.length - 1; i++) {
      if (chains[i] !== chains[i + 1] || dist3(coords[i], coords[i + 1]) > 4.5 || (Number.isFinite(resnum[i]) && Number.isFinite(resnum[i + 1]) && resnum[i + 1] - resnum[i] > 1 && dist3(coords[i], coords[i + 1]) > 4.2)) breaks.add(i);
    }
    return { coords, plddts, chains, resnum, breaks, hasPlddt };
  }

  // -------------------------------------------------------------------- orientation
  // Jacobi eigenvectors of a 3x3 symmetric matrix, largest eigenvalue first.
  function jacobi3(A) {
    const a = A.slice(), V = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let iter = 0; iter < 40; iter++) {
      let p = 0, q = 1, maxOff = Math.abs(a[1]);
      if (Math.abs(a[2]) > maxOff) { p = 0; q = 2; maxOff = Math.abs(a[2]); }
      if (Math.abs(a[5]) > maxOff) { p = 1; q = 2; maxOff = Math.abs(a[5]); }
      if (maxOff < 1e-9) break;
      const app = a[p * 3 + p], aqq = a[q * 3 + q], apq = a[p * 3 + q];
      const theta = 0.5 * Math.atan2(2 * apq, aqq - app), c = Math.cos(theta), s = Math.sin(theta);
      for (let k = 0; k < 3; k++) { const vkp = V[k * 3 + p], vkq = V[k * 3 + q]; V[k * 3 + p] = c * vkp - s * vkq; V[k * 3 + q] = s * vkp + c * vkq; }
      const app2 = c * c * app - 2 * s * c * apq + s * s * aqq, aqq2 = s * s * app + 2 * s * c * apq + c * c * aqq;
      a[p * 3 + q] = a[q * 3 + p] = 0; a[p * 3 + p] = app2; a[q * 3 + q] = aqq2;
      for (let k = 0; k < 3; k++) {
        if (k === p || k === q) continue;
        const akp = a[k * 3 + p], akq = a[k * 3 + q];
        a[k * 3 + p] = a[p * 3 + k] = c * akp - s * akq; a[k * 3 + q] = a[q * 3 + k] = s * akp + c * akq;
      }
    }
    return [[a[0], [V[0], V[3], V[6]]], [a[4], [V[1], V[4], V[7]]], [a[8], [V[2], V[5], V[8]]]].sort((x, y) => y[0] - x[0]).map(e => e[1]);
  }
  // Stood on its principal axes: the longest up, the next across, the shortest into the
  // screen, centred on the mean. Which way is up along the longest axis is decided by
  // the roles below (the head goes up); this returns the coordinates and the axes.
  function orient(coords) {
    const N = coords.length, c = [0, 0, 0];
    for (const p of coords) { c[0] += p[0] / N; c[1] += p[1] / N; c[2] += p[2] / N; }
    const cov = new Array(9).fill(0);
    for (const p of coords) { const d = sub3(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i * 3 + j] += d[i] * d[j] / N; }
    const [vy, vx] = jacobi3(cov);
    const vz = [vx[1] * vy[2] - vx[2] * vy[1], vx[2] * vy[0] - vx[0] * vy[2], vx[0] * vy[1] - vx[1] * vy[0]];
    return coords.map(p => { const d = sub3(p, c); return [dot3(d, vx), dot3(d, vy), dot3(d, vz)]; });
  }
  const flipY = coords => coords.map(p => [-p[0], -p[1], p[2]]);   // turned over, still right-handed

  // ------------------------------------------------------------------ the armature
  // A limb is a stretch of chain that sticks out of the body: exposed (few neighbours)
  // and reaching well beyond where it leaves the core. Candidates are every window of
  // 10 to 60 residues; the best are taken greedily, not overlapping, then given roles by
  // which way their tips point from the centre: up is a head, down a leg, across an arm.
  function neighbourLists(coords, radius) {
    const N = coords.length, r2 = radius * radius, cell = radius, grid = new Map(), out = [];
    const key = (x, y, z) => `${x},${y},${z}`;
    coords.forEach((p, i) => { const k = key(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    coords.forEach((p, i) => {
      const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell), gz = Math.floor(p[2] / cell), list = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const idx = grid.get(key(gx + dx, gy + dy, gz + dz)); if (!idx) continue;
        for (const j of idx) { if (j === i) continue; const q = coords[j], ddx = q[0] - p[0], ddy = q[1] - p[1], ddz = q[2] - p[2]; if (ddx * ddx + ddy * ddy + ddz * ddz < r2) list.push(j); }
      }
      out.push(list);
    });
    return out;
  }
  function findLimbs(coords, breaks, sec) {
    const N = coords.length, c = [0, 0, 0];
    for (const p of coords) { c[0] += p[0] / N; c[1] += p[1] / N; c[2] += p[2] / N; }
    const radial = coords.map(p => dist3(p, c)), near = neighbourLists(coords, 10), near14 = neighbourLists(coords, 14);
    const sorted = radial.slice().sort((a, b) => a - b), coreR = sorted[Math.floor(0.7 * N)];   // most of the body lies within this
    // 🔴 A LIMB STANDS CLEAR OF THE BODY. Sticking out past the core's radius was not
    // enough: a long bundle (11EU) has surface helices at its ends further from the
    // centre than seven tenths of it, and they passed as arms, lying flush with the
    // body, nothing to see and nothing to swing. The outer half of a limb has none of
    // the body alongside it: body residues (within the core's radius and a bit) within
    // 14 Å of it, per residue - 0 to 0.3 on a real protrusion, 4 to 5 on those helices.
    const bodyR = coreR * 1.15;
    const clear = (a, b) => {
      const rs = []; for (let i = a; i <= b; i++) rs.push(radial[i]);
      rs.sort((x, y) => x - y); const mid = rs[rs.length >> 1];
      let n = 0, k = 0;
      for (let i = a; i <= b; i++) { if (radial[i] < mid) continue; k++; for (const j of near14[i]) if ((j < a - 2 || j > b + 2) && radial[j] <= bodyR) n++; }
      return k ? n / k : 0;
    };
    const minL = 10, maxL = Math.min(60, Math.floor(N / 3));
    if (maxL < minL) return { limbs: [], centre: c, coreR };
    // A stretch is a limb by how few contacts it has with the REST of the chain: a helix
    // has a dozen neighbours along itself and is a limb all the same, a strand in a
    // sheet has as many across it and is not.
    const external = (a, b) => {
      let s = 0;
      for (let i = a; i <= b; i++) { let k = 0; for (const j of near[i]) if (j < a - 2 || j > b + 2) k++; s += k; }
      return s / (b - a + 1);
    };
    const cands = [];
    const stepA = N > 1200 ? 3 : 2, stepL = N > 1200 ? 5 : 3;
    for (let a = 0; a < N - minL; a += stepA) {
      for (let L = minL; L <= maxL && a + L <= N; L += stepL) {
        const b = a + L - 1;
        // not across a chain break: a limb is one piece of chain
        let broken = false; for (let i = a; i < b; i++) if (breaks.has(i)) { broken = true; break; }
        if (broken) continue;
        let tip = a; for (let i = a; i <= b; i++) if (radial[i] > radial[tip]) tip = i;
        // Each end of a limb is either the end of its chain or at the body: a stretch whose
        // far end runs on into the body from out in space would tear where it joins.
        const free = i => i === 0 || i === N - 1 || breaks.has(i) || breaks.has(i - 1);   // a chain end: nothing beyond it to tear
        const attached = i => radial[i] <= coreR * 1.15;
        if (!(free(a) || attached(a)) || !(free(b) || attached(b)) || !(attached(a) || attached(b))) continue;
        // ...and attached at both ends only as a hairpin, the two ends together: swung
        // about one root, a stretch rooted in two places 30 A apart tears at the other.
        if (attached(a) && attached(b) && !free(a) && !free(b) && dist3(coords[a], coords[b]) > 14) continue;
        const attach = Math.min(radial[a], radial[b]);
        const stick = radial[tip] - Math.max(attach, coreR * 0.8);   // beyond the body, not just beyond its own root
        if (stick < 6) continue;
        const exposure = Math.max(0, 6 - external(a, b));
        if (exposure < 2.5) continue;
        // ...and runs out to its tip and back at most once: along the chain, the distance
        // from the root changes about twice its range in all (once out, once back) for a
        // hairpin and once for a straight limb; a coil that wanders back and forth along
        // itself changes it far more, and the rig cannot swing what has no direction.
        const root = coords[radial[a] < radial[b] ? a : b], reach = dist3(coords[tip], root) || 1;
        let travel = 0; for (let i = a; i < b; i++) travel += Math.abs(dist3(coords[i + 1], root) - dist3(coords[i], root));
        // ...and how much of it sits out beyond the body: a compact domain on a stalk (a
        // head) is all out there and wanders as much as it likes; a wandering coil that
        // keeps coming back to the body is neither limb nor head.
        let out = 0; for (let i = a; i <= b; i++) if (radial[i] > coreR * 0.9) out++;
        const outFrac = out / L;
        // ...and narrow: a helix, a hairpin or a strand lies along its axis, and the rig
        // bends it about an elbow on that axis; a coil that balloons out sideways would
        // be torn by the bend. Its mean distance from the axis, against its length.
        const axis = sub3(coords[tip], root), al2 = dot3(axis, axis) || 1;
        let off = 0; for (let i = a; i <= b; i++) { const d = sub3(coords[i], root), t = dot3(d, axis) / al2; off += norm3(sub3(d, scale3(axis, t))); }
        const narrow = off / L <= 0.3 * reach;
        // ...and built of helix or strand, at least half: a disordered tail has no shape
        // to swing, and hangs loose off the body instead (its pLDDT sees to that)
        let ss = 0; if (sec) for (let i = a; i <= b; i++) if (sec[i] === 'H' || sec[i] === 'E') ss++;
        const structured = !sec || ss / L >= 0.5;
        const straight = travel <= 2.6 * reach && narrow && structured;
        if (!straight && outFrac < 0.5) continue;
        if (straight && clear(a, b) > 1) continue;   // an arm or a leg stands clear of the body; a head is a lobe and may sit against it
        cands.push({ a, b, tip, straight, score: stick + 2 * exposure + 0.05 * L });
      }
    }
    cands.sort((x, y) => y.score - x.score);
    const taken = new Uint8Array(N), limbs = [];
    for (const k of cands) {
      let free = true; for (let i = Math.max(0, k.a - 3); i <= Math.min(N - 1, k.b + 3); i++) if (taken[i]) { free = false; break; }
      if (!free) continue;
      for (let i = k.a; i <= k.b; i++) taken[i] = 1;
      const dir = sub3(coords[k.tip], c), l = norm3(dir) || 1;
      limbs.push({ a: k.a, b: k.b, tip: k.tip, score: k.score, straight: k.straight, dir: scale3(dir, 1 / l), reach: radial[k.tip] });
      if (limbs.length >= 6) break;
    }
    return { limbs, centre: c, coreR };
  }
  // Roles from directions. The body may be standing on its head: both ways up are
  // tried, and the one that gives the more complete armature (legs and a head) wins.
  function assignRoles(limbs) {
    // A head is turned whole, so any shape will do; an arm or a leg is bent by the rig
    // along its length, so only a stretch that runs out and back (straight) can be one.
    const up = limbs.filter(l => l.dir[1] > 0.55).sort((x, y) => y.reach - x.reach);
    const down = limbs.filter(l => l.straight && l.dir[1] < -0.55).sort((x, y) => y.score - x.score);
    const side = limbs.filter(l => l.straight && Math.abs(l.dir[1]) <= 0.55).sort((x, y) => y.score - x.score);
    const roles = {};
    if (up.length) roles.head = up[0];
    if (down.length >= 2) {
      const [p, q] = down.slice(0, 2).sort((x, y) => x.dir[0] - y.dir[0]);   // by x: left first
      roles.lleg = p; roles.rleg = q;
    }
    const left = side.filter(l => l.dir[0] < 0), right = side.filter(l => l.dir[0] >= 0);
    if (left.length && right.length) { roles.larm = left[0]; roles.rarm = right[0]; }
    else if (side.length) { roles.rarm = side[0]; if (side.length > 1) roles.larm = side[1]; }   // both on one side: the rig mirrors
    return roles;
  }
  const armatureScore = roles => (roles.lleg ? 2 : 0) + (roles.head ? 1 : 0) + (roles.rarm ? 1 : 0) + (roles.larm ? 0.5 : 0);

  // --------------------------------------------------------- ideal helices, for legs
  // An alpha-helix trace with exact bonds: 1.5 A rise, 100 degrees a residue.
  function alphaHelix(start, direction, count, phase = 0, ref = [0, 0, 1]) {
    const dir = scale3(direction, 1 / norm3(direction));
    let e1 = [ref[1] * dir[2] - ref[2] * dir[1], ref[2] * dir[0] - ref[0] * dir[2], ref[0] * dir[1] - ref[1] * dir[0]];
    const l1 = norm3(e1); e1 = l1 < 1e-4 ? [1, 0, 0] : scale3(e1, 1 / l1);
    const e2 = [dir[1] * e1[2] - dir[2] * e1[1], dir[2] * e1[0] - dir[0] * e1[2], dir[0] * e1[1] - dir[1] * e1[0]];
    const rise = 1.5, twist = 100 * Math.PI / 180, radius = Math.sqrt(CA_STEP * CA_STEP - rise * rise) / (2 * Math.sin(twist / 2));
    const pts = [];
    for (let i = 0; i < count; i++) {
      const ang = phase + i * twist, r = add3(scale3(e1, Math.cos(ang)), scale3(e2, Math.sin(ang)));
      const p = add3(add3(start, scale3(dir, i * rise)), scale3(r, radius));
      pts.push([round3(p[0]), round3(p[1]), round3(p[2])]);
    }
    return pts;
  }
  // ---------------------------------------------------- limbs grown out of the chain
  // A body with no leg-like (or arm-like) protrusion is given them the way the built-in
  // fighters have theirs: as part of its own chain. A terminus that lies where a limb
  // should leave the body is continued as an alpha helix (a helix leg, as the bundle
  // fighter's); otherwise a surface loop there is extended as a pair of strands, out
  // and back (a hairpin leg, as the barrel fighter's). The new residues bond to their
  // anchors at 3.8 A and carry a pLDDT of 90.
  //
  // A strand: 3.3 A of rise a residue with a 0.9 A pleat to either side, which keeps
  // every bond at 3.8. A hairpin: one strand out, a turn, one strand back 4.8 A over.
  // `phase` sets which way the first residue pleats. Paired residues of a hairpin pleat
  // the same way, which is what makes py2Dmol read the pair as a sheet (measured: the
  // wrong phase reads as coil), and the strand coming back starts at the far end, so
  // its phase is set from its length to land in step with the strand going out.
  function strand(start, dir, side, count, pleat = 0.9, phase = 0) {
    const d = scale3(dir, 1 / norm3(dir)), pts = [];
    for (let i = 0; i < count; i++) pts.push(add3(add3(start, scale3(d, 3.3 * i)), scale3(side, ((i + phase) % 2 ? 1 : -1) * pleat)));
    return pts;
  }
  // Bonds along a run of new residues pulled to 3.8 A, its two anchors held (or one, at a
  // chain end): a few passes, so the ideal shape is kept and only the joins give.
  function relaxRun(pts, anchorA, anchorB) {
    for (let it = 0; it < 24; it++) {
      const chain = [anchorA, ...pts, anchorB].filter(Boolean);
      const fixed = i => (anchorA && i === 0) || (anchorB && i === chain.length - 1);
      for (let i = 0; i < chain.length - 1; i++) {
        const a = chain[i], b = chain[i + 1], d = sub3(b, a), l = norm3(d) || 1e-9, corr = scale3(d, (l - CA_STEP) / l);
        if (fixed(i) && fixed(i + 1)) continue;
        if (fixed(i)) { for (let k = 0; k < 3; k++) b[k] -= corr[k]; }
        else if (fixed(i + 1)) { for (let k = 0; k < 3; k++) a[k] += corr[k]; }
        else for (let k = 0; k < 3; k++) { a[k] += corr[k] / 2; b[k] -= corr[k] / 2; }
      }
    }
    return pts;
  }
  // A run of residues in a straight line from `from` (not included) toward `to`, a bond
  // apart, ending a bond short of `to`: the loop that carries a grown limb from where
  // it leaves the chain to where it hangs from the body.
  function connector(from, to) {
    const d = sub3(to, from), l = norm3(d), n = Math.max(0, Math.round(l / 3.7) - 1), pts = [];
    for (let i = 1; i <= n; i++) pts.push(add3(from, scale3(d, i / (n + 1))));
    return pts;
  }
  // A limb's points: from its root down (or out) for `len`, then a foot forward for
  // `footLen` (a leg has one; an arm none). As a helix rooted at one point, or a hairpin
  // rooted at two, 4.8 A apart. The root is where it hangs from the body, and a
  // connector runs from the chain's anchor to it, so both legs hang from hips at one
  // height whatever height their anchors were at.
  function helixLimb(anchor, root, dir, len, footLen) {
    const lead = connector(anchor, root);
    const out = alphaHelix(root, dir, Math.max(4, Math.round(len / 1.5)));
    if (footLen > 0) {
      const end = out[out.length - 1], fwd = [0, 0, 1];
      out.push(...alphaHelix(add3(end, scale3(fwd, 2.5)), fwd, Math.max(3, Math.round(footLen / 1.5)), 0, [0, 1, 0]));
    }
    const nUp = Math.max(4, Math.round(len / 1.5));
    const pts = relaxRun([...lead, ...out], anchor, null);
    // the knee halfway down the upright part, the ankle where the foot turns forward
    return { pts, limbFrom: lead.length, kneeAt: lead.length + (nUp >> 1), footAt: lead.length + nUp };
  }
  // `sideWanted`, if given, is the way the two strands sit apart: a leg's sit left and
  // right across the body (along x, the rig's width), a pair seen side by side from the
  // front, and the pleat then runs along z (the rig's forward, which the game turns to
  // face the opponent), so the ribbons face the front and read as lines from the side,
  // where the fight is watched. An arm's sit the way its two anchors do.
  function hairpinLimb(anchorA, anchorB, rootA, dir, len, footLen, sideWanted) {
    const d = scale3(dir, 1 / norm3(dir));
    // the strands run 4.8 A apart, across the way the anchors sit
    const across = sideWanted || sub3(anchorB, anchorA);
    // ...at right angles to the limb: where the anchors sit along it (an arm growing
    // sideways from two residues one above the other), any perpendicular will do
    let side = sub3(across, scale3(d, dot3(across, d))); const sl = norm3(side);
    if (sideWanted && sl > 1e-6) {   // a wanted way is a direction, not a distance: made long enough to be taken, and pointed the way the anchors sit so the two connectors do not cross
      side = scale3(side, 4.8 / sl);
      if (dot3(side, sub3(anchorB, anchorA)) < 0) side = scale3(side, -1);
    } else if (sideWanted) side = [0, 0, 0];
    const sl2 = norm3(side);
    if (sl2 > 1.5) side = scale3(side, 1 / sl2);
    else { const ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]; side = [d[1] * ref[2] - d[2] * ref[1], d[2] * ref[0] - d[0] * ref[2], d[0] * ref[1] - d[1] * ref[0]]; side = scale3(side, 1 / norm3(side)); }
    const pleat = [d[1] * side[2] - d[2] * side[1], d[2] * side[0] - d[0] * side[2], d[0] * side[1] - d[1] * side[0]];
    const n = Math.max(3, Math.round(len / 3.3)), nf = footLen > 0 ? Math.max(2, Math.round(footLen / 3.3)) : 0;
    const baseA = rootA, baseB = add3(rootA, scale3(side, 4.8));
    const A = strand(baseA, d, pleat, n), B = strand(add3(baseB, scale3(d, 3.3 * (n - 1))), scale3(d, -1), pleat, n, 0.9, (n - 1) % 2);
    let foot = [];
    if (nf) {   // the tip turned forward: out along z from the end of A, back to the start of B
      const fwd = [0, 0, 1], tipA = A[A.length - 1], tipB = B[0];
      foot = strand(add3(tipA, scale3(fwd, 3.3)), fwd, pleat, nf).concat(strand(add3(tipB, scale3(fwd, 3.3 * nf)), scale3(fwd, -1), pleat, nf, 0.9, (nf - 1) % 2));
    }
    const lead = connector(anchorA, baseA), tail = connector(baseB, anchorB);
    const pts = relaxRun([...lead, ...A, ...foot, ...B, ...tail], anchorA, anchorB);
    return { pts, limbFrom: lead.length, limbTo: lead.length + A.length + foot.length + B.length - 1, kneeAt: lead.length + (A.length >> 1), footAt: lead.length + A.length };
  }

  // Where to grow from. Every free terminus and every surface-loop residue is scored
  // for the limb (for a leg the lowest and the nearest to where a hip belongs, a little
  // to its own side of the body's middle and on the fighting plane; for an arm the
  // furthest out at mid height), a terminus with a modest bonus, since continuing a free end as a
  // helix adds no cut and cannot tear; the best wins. At least one limb takes a
  // terminus: if none did, the limb whose slot a terminus suits best is moved onto it.
  // A limb grows where its anchor is, not carried anywhere: a body may come out
  // lopsided, which is what a real protein's shape gives, and each leg is made long
  // enough from its own anchor to reach the same floor. Nothing already in a limb,
  // nothing at a break.
  // In the score's units, angstroms of placement. A leg's is the larger: a free end
  // anywhere in the lower half of the body makes a better leg than a loop a few
  // angstroms lower (hemoglobin's N-terminus, a quarter of the way up, lost its leg to
  // a loop beside it at 6), while an arm takes a terminus only where it sits right.
  const TERMINUS_BONUS = { leg: 20, arm: 6 };
  function planAnchors(coords, sec, breaks, taken, torsoBottom, torsoTop, need, hipX) {
    const N = coords.length, h = torsoTop - torsoBottom;
    const ok = i => !taken.has(i) && !breaks.has(i) && !(i > 0 && breaks.has(i - 1));
    // 🔴 LEGS CLOSE TOGETHER. A leg scored by how far out on its own side its anchor sat
    // put a long body's hips at the two ends of it, 80 Å apart along the fighting
    // axis, so a kick from the rear hip never passed the body's own front and landed
    // nothing. A leg is scored by height and by distance from where its hip belongs:
    // hipX to its own side of the middle, on the fighting plane (z 0).
    // ...and the second leg's hip belongs a stance's width from wherever the first leg
    // was put: a terminus taken for the first leg on the far side of the middle (its
    // bonus outweighs the distance) would otherwise have the second leg's loop chosen
    // beside it, the two legs grown through each other.
    let legX = null, armX = null;   // where the first of each pair went: the second belongs a width away
    // An arm is anchored at the FRONT of the body (z, the rig's forward), at mid height,
    // to its own side: it is grown out sideways and the pose folds it forward from its
    // shoulder, so a shoulder at the back of a deep body (FUS is 110 Å deep) left the
    // fist short of the body's own front, and every punch short of the opponent.
    const zFront = Math.max(...coords.filter((_, i) => !taken.has(i)).map(p => p[2]));
    const score = (i, want, side) => {
      const p = coords[i];
      if (want !== 'leg') { const sx = armX == null ? side * 1.5 * hipX : armX - Math.sign(armX || side) * 3 * hipX; return (p[2] - zFront) - 0.8 * Math.abs(p[1] - (torsoBottom + 0.6 * h)) - 0.6 * Math.abs(p[0] - sx); }
      const hx = legX == null ? side * hipX : legX - Math.sign(legX || side) * 2 * hipX;
      return -1.5 * (p[1] - torsoBottom) - 0.7 * Math.hypot(p[0] - hx, p[2]);
    };
    const used = new Set(), slots = [];
    for (const { want, sides } of need) for (const side of sides) {
      let best = null, bs = -Infinity;
      for (const i of [0, N - 1]) if (ok(i) && !used.has(i)) { const sc = score(i, want, side) + TERMINUS_BONUS[want]; if (sc > bs) { bs = sc; best = { i, terminus: true }; } }
      // a loop residue, exposed, with room to insert after it (i and i+1 both free)
      for (let i = 1; i < N - 2; i++) {
        if (!ok(i) || !ok(i + 1) || breaks.has(i) || used.has(i) || used.has(i + 1)) continue;
        if (sec && sec[i] !== 'C' && sec[i + 1] !== 'C') continue;
        const sc = score(i, want, side); if (sc > bs) { bs = sc; best = { i, terminus: false }; }
      }
      if (best) { used.add(best.i); if (!best.terminus) used.add(best.i + 1); if (want === 'leg' && legX == null) legX = coords[best.i][0]; if (want === 'arm' && armX == null) armX = coords[best.i][0]; }
      slots.push({ want, side: side < 0 ? 'l' : 'r', score: bs, at: best });
    }
    if (!slots.some(s => s.at && s.at.terminus)) {
      let move = null, loss = Infinity;
      for (const s of slots) for (const i of [0, N - 1]) {
        if (!ok(i)) continue;
        const cost = s.score - score(i, s.want, s.side === 'l' ? -1 : 1);   // what the slot gives up
        if (cost < loss) { loss = cost; move = { slot: s, i }; }
      }
      // ...unless every terminus is somewhere no limb belongs (FUS: one at the top of the
      // head, one deep in the back), where the slot moved would be a limb that cannot
      // reach: an arm rooted mid-body, its fist short of the body's own front.
      if (move && loss <= 30) move.slot.at = { i: move.i, terminus: true };
    }
    return slots;
  }
  // The chain with limbs grown into it: the coordinates, pLDDTs and breaks rebuilt, every
  // index of the old chain mapped, and the grown limbs returned as roles on the new one.
  function growLimbs(coords, plddts, breaks, sec, roles, torsoBottom, torsoTop, need) {
    const taken = new Set();
    for (const l of Object.values(roles)) if (l) for (let i = l.a; i <= l.b; i++) taken.add(i);
    const h = torsoTop - torsoBottom, inserts = [], grown = {};
    const legLen = clamp(1.7 * h, 40, 80), armLen = clamp(1.3 * h, 30, 60);
    // the body's half-width, for where the hips and shoulders sit
    const torso = coords.filter((_, i) => !taken.has(i)), halfWidth = Math.max(8, ...torso.map(p => Math.abs(p[0])));
    const hipX = clamp(halfWidth * 0.5, 6, 14);
    // Which is left and which is right is where the anchors are, not which slot found
    // them: the first leg may have been a terminus on the far side of the middle, and a
    // left leg grown from the right side tilts left through the right leg, the two
    // crossed (hemoglobin, ubiquitin). The lower x is the left of each pair.
    const plan = planAnchors(coords, sec, breaks, taken, torsoBottom, torsoTop, need, hipX);
    for (const { want } of need) {
      const pair = plan.filter(s => s.want === want && s.at);
      if (pair.length === 2 && coords[pair[0].at.i][0] > coords[pair[1].at.i][0]) [pair[0].side, pair[1].side] = [pair[1].side, pair[0].side];
    }
    for (const { want, side, at: a } of plan) {
      if (!a) continue;
      {
        const sg = side === 'l' ? -1 : 1;
        const dir = want === 'leg' ? [0.15 * sg, -1, 0] : [sg, 0.05, 0];
        const len = want === 'leg' ? legLen : armLen, foot = want === 'leg' ? clamp(0.27 * legLen, 10, 20) : 0;
        // the root is a bond below (or beside) the loop it leaves from: a hip where the
        // loop is, and a leg long enough from there to reach the floor the other reaches
        const anchor = coords[a.i], root = add3(anchor, scale3(scale3(dir, 1 / norm3(dir)), 3.5));
        const floorY = torsoBottom + 2 - legLen, limbLen = want === 'leg' ? Math.max(30, root[1] - floorY) : len;
        let built, where;
        if (a.terminus) { built = helixLimb(anchor, root, dir, limbLen, foot); where = a.i === 0 ? { before: 0, reverse: true } : { before: coords.length }; }
        else { built = hairpinLimb(anchor, coords[a.i + 1], root, dir, limbLen, foot, want === 'leg' ? [1, 0, 0] : null); where = { before: a.i + 1 }; }
        let { pts, limbFrom, limbTo = pts.length - 1, kneeAt, footAt } = built;
        if (where.reverse) { pts.reverse(); const n = pts.length; [limbFrom, limbTo] = [n - 1 - limbTo, n - 1 - limbFrom]; kneeAt = n - 1 - kneeAt; footAt = n - 1 - footAt; }   // grown off the N-terminus, the chain runs tip first
        inserts.push({ ...where, pts, limbFrom, limbTo, kneeAt, footAt, role: want === 'leg' ? side + 'leg' : side + 'arm', terminus: a.terminus, anchor: a.i });
        taken.add(a.i); if (!a.terminus) taken.add(a.i + 1);
      }
    }
    if (!inserts.length) return { coords, plddts, breaks, roles, grown, map: i => i };
    // apply, last first, and build the index map
    inserts.sort((x, y) => y.before - x.before);
    const shift = new Int32Array(coords.length + 1);   // how many new residues sit before old index i
    for (const ins of inserts) for (let i = ins.before; i <= coords.length; i++) shift[i] += ins.pts.length;
    const map = i => i + shift[i];
    // A grown limb is built to ideal geometry and has nothing uncertain about it: pLDDT
    // 100 (a fixed 90 drew the legs a paler blue than a model whose own residues sit at
    // 97, as if they were the doubtful part).
    const grownPlddt = 100;
    const out = coords.map(p => p.slice()), pl = plddts.slice(), placed = [];
    for (const ins of inserts) {
      out.splice(ins.before, 0, ...ins.pts.map(p => [round3(p[0]), round3(p[1]), round3(p[2])]));
      pl.splice(ins.before, 0, ...ins.pts.map(() => grownPlddt));
    }
    // where each grown limb landed: its first new index is its old insertion point plus
    // whatever was inserted before that point by others
    for (const ins of inserts) {
      const before = inserts.filter(o => o !== ins && (o.before < ins.before)).reduce((s, o) => s + o.pts.length, 0);
      const start = ins.before + before;
      // the limb proper is the role; its connectors are torso
      placed.push({ role: ins.role, a: start + ins.limbFrom, b: start + ins.limbTo, kneeI: start + ins.kneeAt, footI: start + ins.footAt, terminus: ins.terminus, chainFirst: ins.before === 0 });
    }
    const newBreaks = new Set([...breaks].map(i => map(i)));
    for (const g of placed) {
      // the root is the limb's end toward the body; the tip the residue furthest from it
      const rootI = g.chainFirst ? g.b : g.a, rootP = out[rootI];
      let tip = g.a; for (let i = g.a; i <= g.b; i++) if (dist3(out[i], rootP) > dist3(out[tip], rootP)) tip = i;
      grown[g.role] = { a: g.a, b: g.b, tip, straight: true, grown: true, chainFirst: g.chainFirst, kneeI: g.kneeI, footI: g.footI, dir: [g.role[0] === 'l' ? -1 : 1, g.role.endsWith('leg') ? -1 : 0, 0], reach: 0, score: 0 };
    }
    const mapped = {};
    for (const [k, l] of Object.entries(roles)) if (l) mapped[k] = { ...l, a: map(l.a), b: map(l.b), tip: map(l.tip) };
    return { coords: out, plddts: pl, breaks: newBreaks, roles: { ...mapped, ...grown }, grown, map, grownPlddt };
  }

  // ------------------------------------------------------------ the special, by size
  // A small protein whirls: the helix spin, both arms out, ligands flying. A big one
  // has the mass for the heat shock, the wave along the membrane. The fold is still
  // read (py2Dmol's own assignment, the one it draws) and reported, since it says
  // what the body is made of, but it is size that picks the move.
  const SPECIALS = {
    spin: { title: 'HURRICANE', description: 'whirls twice round with its arms out, ligands flying' },
    special: { title: 'HEAT SHOCK', description: 'sends a wave along the membrane that unfolds whatever it reaches' },
  };
  const SMALL = 250;   // residues: up to this it spins, above it shocks
  function secondary(coords) {
    const cart = window.py2dmolCartoon;
    if (!cart || !cart.assignSecondaryOpen) return null;
    // as the viewer calls it: positions as {x, y, z}
    const pts = coords.map(p => ({ x: p[0], y: p[1], z: p[2] }));
    try { return cart.assignSecondaryOpen(pts, pts.length, null, {}).sec; } catch (e) { return null; }
  }
  function chooseSpecial(sec, plddts) {
    sec = sec || []; const n = plddts.length;
    let h = 0, e = 0; for (const s of sec) { if (s === 'H') h++; else if (s === 'E') e++; }
    const fH = h / n, fE = e / n, m = mean(plddts);
    const special = n <= SMALL ? 'spin' : 'special';
    return { special, ...SPECIALS[special], helix: fH, strand: fE, plddt: m };
  }

  // ------------------------------------------------ the model's error, as a structure
  // 🔴 A MATRIX IS NOT WHAT THE GAME NEEDS, A SECOND STRUCTURE IS. The live map is
  // already "how far is j from where the reference puts it, seen in i's own frame"
  // (game.js updatePAE), so a structure displaced from the model by as much as the
  // predicted error says REPRODUCES that error through the same code. The matrix is
  // n x n - 475 KB for a 689-residue fighter over a link, and up to 9 MB to download -
  // while a structure is three numbers a residue.
  //
  // Finding it is the matrix's own inverse: a displacement field whose pairwise spread
  // matches the error. That is classical scaling (the top three eigenvectors of the
  // double-centred squared matrix) refined by a few rounds of metric scaling. It cannot
  // be exact - 3n numbers cannot hold n^2 - and it does not need to be: measured against
  // the AlphaFold DB's own matrices, pooled to the 64-pixel map the game draws, the
  // regenerated map is 0.5 to 3.5 A out of a 31.75 A scale (GFP 0.95, haemoglobin 0.52,
  // insulin 3.49, FUS 1.83), which is a shade of colour on a small panel.
  // 🔴 AND IT IS SCALED ON A THINNED CHAIN. Both halves of it - the leading directions
  // and the metric refinement - are n-squared a pass, so a big model paid for the start
  // and not the answer: two seconds of a three-second build for the spike, and nine at
  // the three-thousand-residue limit. The matrix is smooth at this range (it is what the
  // displacement is smoothed along the chain for anyway), so it is solved on at most
  // four hundred residues spread through the chain and spread back between them, and the
  // fit below corrects the detail at full resolution. Fixed cost, whatever the size.
  const SCALE_CAP = 400;
  function referenceFrom(coords, pae) {
    const n = coords.length, m = Math.round(Math.sqrt(pae.length));
    if (!m || m < 2) return null;
    const lim = Math.min(n, m);
    const stride = Math.max(1, Math.ceil(lim / SCALE_CAP)), pick = [];
    for (let i = 0; i < lim; i += stride) pick.push(i);
    if (pick[pick.length - 1] !== lim - 1) pick.push(lim - 1);
    const N = pick.length;
    const at = (i, j) => (pae[pick[i] * m + pick[j]] + pae[pick[j] * m + pick[i]]) / 16;   // the flat map is A x 8, and asymmetric
    // classical scaling: B = -1/2 J D^2 J, then its three leading directions
    const d2 = new Float64Array(N * N), rowMean = new Float64Array(N);
    let all = 0;
    for (let i = 0; i < N; i++) { let sum = 0; for (let j = 0; j < N; j++) { const v = at(i, j); const q = v * v; d2[i * N + j] = q; sum += q; } rowMean[i] = sum / N; all += sum; }
    all /= N * N;
    const B = d2;   // in place: the squared distances are not needed again
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) B[i * N + j] = -0.5 * (B[i * N + j] - rowMean[i] - rowMean[j] + all);
    const vecs = [], vals = [], w = new Float64Array(N);
    for (let k = 0; k < 3; k++) {
      let v = new Float64Array(N);
      for (let i = 0; i < N; i++) v[i] = Math.sin(i * (k + 1) * 0.7) + 0.1;
      let lam = 0;
      for (let it = 0; it < 120; it++) {
        for (let i = 0; i < N; i++) { let sum = 0; const r = i * N; for (let j = 0; j < N; j++) sum += B[r + j] * v[j]; w[i] = sum; }
        for (const q of vecs) { let dot = 0; for (let i = 0; i < N; i++) dot += w[i] * q[i]; for (let i = 0; i < N; i++) w[i] -= dot * q[i]; }
        let norm = 0; for (let i = 0; i < N; i++) norm += w[i] * w[i];
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < N; i++) v[i] = w[i] / norm;
        lam = norm;
      }
      vecs.push(v.slice()); vals.push(Math.max(0, lam));
    }
    const s = Array.from({ length: N }, () => [0, 0, 0]);
    for (let k = 0; k < 3; k++) { const sc = Math.sqrt(vals[k]); for (let i = 0; i < N; i++) s[i][k] = vecs[k][i] * sc; }
    // ...refined: each point moved to where every pair would put it (metric scaling)
    for (let it = 0; it < 30; it++) {
      const next = Array.from({ length: N }, () => [0, 0, 0]);
      for (let i = 0; i < N; i++) {
        const a = s[i];
        for (let j = 0; j < N; j++) {
          if (i === j) continue;
          const b = s[j], dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6, f = at(i, j) / d;
          next[i][0] += b[0] + f * dx; next[i][1] += b[1] + f * dy; next[i][2] += b[2] + f * dz;
        }
      }
      for (let i = 0; i < N; i++) { s[i][0] = next[i][0] / (N - 1); s[i][1] = next[i][1] / (N - 1); s[i][2] = next[i][2] / (N - 1); }
    }
    // ...spread back over the residues between the ones it was solved on
    const u = Array.from({ length: n }, () => [0, 0, 0]);
    for (let k = 0; k + 1 < N; k++) {
      const a = pick[k], b = pick[k + 1], span = b - a;
      for (let i = a; i <= b && i < lim; i++) {
        const t = span ? (i - a) / span : 0;
        for (let c = 0; c < 3; c++) u[i][c] = s[k][c] * (1 - t) + s[k + 1][c] * t;
      }
    }
    if (N === 1) for (let i = 0; i < lim; i++) u[i] = s[0].slice();
    // past the matrix's own length (a grown limb) there is no displacement
    for (let i = lim; i < n; i++) u[i] = [0, 0, 0];
    return u;
  }
  // 🔴 AND IT IS FITTED TO WHAT THE GAME ACTUALLY READS, NOT TO A PROXY. Scaling fits
  // |u_i - u_j| to the matrix, but the game does not read that: it reads the pair in
  // residue i's OWN FRAME, and it reads the confidence as an lDDT. Fit the proxy and the
  // two disagree - the reference's frames tilt where the displacement turns, and the
  // wobble that buys a residue its confidence lands on top of an error already placed,
  // so a doubtful model came back with its map 6 A light across the board.
  //
  // So the displacement is a free field of 3n numbers and the loss is the two readings
  // themselves: (matrix - the frame reading) and (pLDDT - the lDDT), with a bond term to
  // keep the backbone a backbone. Gradient descent (Adam, from the scaling solution),
  // with the frames recomputed every step and the lDDT's four thresholds softened into
  // sigmoids so it has a gradient at all. Both sides of a link run the same steps from
  // the same start, so both build the same structure.
  const FIT_ITERS = 150, FIT_LR = 0.05, CONF_WEIGHT = 2500, BOND_WEIGHT = 400, TAU = 0.25, PAE_CAP = 30, B1 = 0.9, B2 = 0.99, EPS_REL = 0.1, FIT_CAP = 0.35, BOND_TOL = 0.4, RECAL = 20;
  const frameAt = (P, i) => {
    const n = P.length, c = Math.min(n - 2, Math.max(1, i)), a = P[c - 1], o = P[c], b = P[c + 1];
    let x1 = b[0] - o[0], y1 = b[1] - o[1], z1 = b[2] - o[2];
    let l = Math.hypot(x1, y1, z1) || 1; x1 /= l; y1 /= l; z1 /= l;
    let x2 = a[0] - o[0], y2 = a[1] - o[1], z2 = a[2] - o[2];
    const d = x2 * x1 + y2 * y1 + z2 * z1; x2 -= d * x1; y2 -= d * y1; z2 -= d * z1;
    l = Math.hypot(x2, y2, z2) || 1; x2 /= l; y2 /= l; z2 /= l;
    return [c, o, [x1, y1, z1], [x2, y2, z2], [y1 * z2 - z1 * y2, z1 * x2 - x1 * z2, x1 * y2 - y1 * x2]];
  };
  const FIT_ROWS = 96, COL_CAP = 384;   // the map is read off strided rows anyway, and every column of each
  function fitReference(coords, ref, plddts, paeFlat, breaks, own) {
    const n = coords.length;
    const m = (paeFlat && paeFlat.length) ? Math.round(Math.sqrt(paeFlat.length)) : 0;
    const lim = m ? Math.min(n, m) : 0;
    const at = (i, j) => Math.min(PAE_CAP, (paeFlat[i * m + j] + paeFlat[j * m + i]) / 16);
    // ...over the residues the matrix speaks for. A grown limb has no predicted error,
    // only the convention that it has none, and made to read zero against every row it
    // pulled the fit away from the pairs that carry data.
    const pool = []; for (let i = 0; i < lim; i++) if (!own || own.has(i)) pool.push(i);
    // ...and read at a spacing, not residue by residue. The map is drawn as sixty-four
    // pixels a side and every pixel already averages a block of residues together, so a
    // column every few residues says the same thing for a fraction of the work, and the
    // fit stops costing more the bigger the protein is. Below the cap nothing is
    // dropped; the spike's 1,274 residues fit in the time its 400th used to take.
    const cstride = Math.max(1, Math.ceil(pool.length / COL_CAP));
    const cols = Int32Array.from(pool.filter((_, k) => k % cstride === 0)), rows = [];
    if (pool.length > 1) { const R = Math.min(pool.length, FIT_ROWS); for (let k = 0; k < R; k++) rows.push(pool[Math.round(k * (pool.length - 1) / Math.max(1, R - 1))]); }
    const L = window.LDDT, pairs = (L && L.prepare) ? L.prepare(coords, null) : null;
    const want = new Float64Array(n);
    for (let i = 0; i < n; i++) want[i] = Math.max(0.2, Math.min(0.995, (plddts[i] ?? 90) / 100));
    const rest = new Float64Array(Math.max(0, n - 1));
    for (let i = 0; i < n - 1; i++) rest[i] = dist3(coords[i], coords[i + 1]);
    const wAE = (lim && rows.length) ? 1 / (rows.length * cols.length) : 0, wP = CONF_WEIGHT / n, wB = BOND_WEIGHT / n;
    const lddt = new Float64Array(n), THR = [0.5, 1, 2, 4];
    // 🔴 AND THE SOFTENED lDDT IS KEPT HONEST AGAINST THE REAL ONE. The four thresholds
    // are counted with sigmoids so the score has a gradient, and a sigmoid is not a step:
    // driven to the confidence the file states, the softened score lands where the real
    // one reads something else - on a crystal structure, where nothing else is being
    // fitted, ten points else. Every so often the real score is taken and the difference
    // is carried as an offset, so what the fit is actually matching is the score the game
    // will read.
    const bias = new Float64Array(n), hard = new Float32Array(n);
    // the loss at P, and its gradient into g when one is asked for
    function evaluate(P, g) {
      let loss = 0;
      if (g) g.fill(0);
      for (let ri = 0; ri < rows.length; ri++) {
        const a = rows[ri];
        const [c, o, e1, e2, e3] = frameAt(coords, a);
        // the reference's frame at this row, kept in pieces: the gradient goes back
        // through every one of them
        const pa = P[c - 1], po = P[c], pb = P[c + 1];
        let ux = pb[0] - po[0], uy = pb[1] - po[1], uz = pb[2] - po[2];
        const ul = Math.hypot(ux, uy, uz) || 1;
        const f1 = [ux / ul, uy / ul, uz / ul];
        const px = pa[0] - po[0], py = pa[1] - po[1], pz = pa[2] - po[2];
        const pd = px * f1[0] + py * f1[1] + pz * f1[2];
        let qx = px - pd * f1[0], qy = py - pd * f1[1], qz = pz - pd * f1[2];
        const ql = Math.hypot(qx, qy, qz) || 1;
        const f2 = [qx / ql, qy / ql, qz / ql];
        const f3 = [f1[1] * f2[2] - f1[2] * f2[1], f1[2] * f2[0] - f1[0] * f2[2], f1[0] * f2[1] - f1[1] * f2[0]];
        const c3 = c * 3;
        let G1x = 0, G1y = 0, G1z = 0, G2x = 0, G2y = 0, G2z = 0, G3x = 0, G3y = 0, G3z = 0;
        for (let cj = 0; cj < cols.length; cj++) {
          const j = cols[cj];
          if (j === c) continue;
          const p = coords[j], r = P[j];
          const vx = p[0] - o[0], vy = p[1] - o[1], vz = p[2] - o[2];
          const wx = r[0] - po[0], wy = r[1] - po[1], wz = r[2] - po[2];
          const dx = (e1[0] * vx + e1[1] * vy + e1[2] * vz) - (f1[0] * wx + f1[1] * wy + f1[2] * wz);
          const dy = (e2[0] * vx + e2[1] * vy + e2[2] * vz) - (f2[0] * wx + f2[1] * wy + f2[2] * wz);
          const dz = (e3[0] * vx + e3[1] * vy + e3[2] * vz) - (f3[0] * wx + f3[1] * wy + f3[2] * wz);
          const e = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6, resid = e - at(a, j);
          loss += wAE * resid * resid;
          if (!g) continue;
          const sc = 2 * wAE * resid / e;
          // ...through the frame's axes, where the reading is taken
          const gx = -sc * (f1[0] * dx + f2[0] * dy + f3[0] * dz);
          const gy = -sc * (f1[1] * dx + f2[1] * dy + f3[1] * dz);
          const gz = -sc * (f1[2] * dx + f2[2] * dy + f3[2] * dz);
          const j3 = j * 3;
          g[j3] += gx; g[j3 + 1] += gy; g[j3 + 2] += gz;
          g[c3] -= gx; g[c3 + 1] -= gy; g[c3 + 2] -= gz;
          // ...and on to the axes themselves: a frame that turns moves every reading in
          // its row, which is most of the loss and all of the reason a fit that held the
          // frames still could not take a step
          const s1 = -sc * dx, s2 = -sc * dy, s3 = -sc * dz;
          G1x += s1 * wx; G1y += s1 * wy; G1z += s1 * wz;
          G2x += s2 * wx; G2y += s2 * wy; G2z += s2 * wz;
          G3x += s3 * wx; G3y += s3 * wy; G3z += s3 * wz;
        }
        if (!g) continue;
        // x3 = x1 x x2
        let A1x = G1x + (f2[1] * G3z - f2[2] * G3y), A1y = G1y + (f2[2] * G3x - f2[0] * G3z), A1z = G1z + (f2[0] * G3y - f2[1] * G3x);
        const A2x = G2x + (G3y * f1[2] - G3z * f1[1]), A2y = G2y + (G3z * f1[0] - G3x * f1[2]), A2z = G2z + (G3x * f1[1] - G3y * f1[0]);
        // x2 = q / |q|
        const a2d = A2x * f2[0] + A2y * f2[1] + A2z * f2[2];
        const Qx = (A2x - a2d * f2[0]) / ql, Qy = (A2y - a2d * f2[1]) / ql, Qz = (A2z - a2d * f2[2]) / ql;
        // q = p - (p.x1) x1
        const qd = Qx * f1[0] + Qy * f1[1] + Qz * f1[2];
        const Px = Qx - qd * f1[0], Py = Qy - qd * f1[1], Pz = Qz - qd * f1[2];
        A1x -= qd * px + pd * Qx; A1y -= qd * py + pd * Qy; A1z -= qd * pz + pd * Qz;
        // x1 = u / |u|
        const a1d = A1x * f1[0] + A1y * f1[1] + A1z * f1[2];
        const Ux = (A1x - a1d * f1[0]) / ul, Uy = (A1y - a1d * f1[1]) / ul, Uz = (A1z - a1d * f1[2]) / ul;
        const bm = (c + 1) * 3, am = (c - 1) * 3;
        g[bm] += Ux; g[bm + 1] += Uy; g[bm + 2] += Uz;
        g[am] += Px; g[am + 1] += Py; g[am + 2] += Pz;
        g[c3] -= Ux + Px; g[c3 + 1] -= Uy + Py; g[c3 + 2] -= Uz + Pz;
      }
      if (pairs) {
        const I = pairs.i, J = pairs.j, D = pairs.d, cnt = pairs.count, K = I.length;
        lddt.fill(0);
        for (let k = 0; k < K; k++) {
          const a = P[I[k]], b = P[J[k]];
          const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
          const h = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9, del = Math.abs(h - D[k]);
          let sm = 0; for (let t = 0; t < 4; t++) sm += 1 / (1 + Math.exp((del - THR[t]) / TAU));
          lddt[I[k]] += sm; lddt[J[k]] += sm;
        }
        for (let i = 0; i < n; i++) { lddt[i] = cnt[i] ? lddt[i] / (4 * cnt[i]) : 1; const r = lddt[i] - want[i] - bias[i]; loss += wP * r * r; }
        if (g) for (let k = 0; k < K; k++) {
          const i = I[k], j = J[k];
          const dLds = 2 * wP * ((lddt[i] - want[i] - bias[i]) / (4 * cnt[i]) + (lddt[j] - want[j] - bias[j]) / (4 * cnt[j]));
          if (!dLds) continue;
          const a = P[i], b = P[j];
          const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
          const h = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9, del = Math.abs(h - D[k]);
          let ds = 0; for (let t = 0; t < 4; t++) { const sg = 1 / (1 + Math.exp((del - THR[t]) / TAU)); ds -= sg * (1 - sg) / TAU; }
          const f = dLds * ds * (h >= D[k] ? 1 : -1) / h, i3 = i * 3, j3 = j * 3;
          g[j3] += f * dx; g[j3 + 1] += f * dy; g[j3 + 2] += f * dz;
          g[i3] -= f * dx; g[i3 + 1] -= f * dy; g[i3 + 2] -= f * dz;
        }
      }
      for (let i = 0; i < n - 1; i++) {
        if (breaks && breaks.has(i)) continue;
        const a = P[i], b = P[i + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        // ...held in a well with a flat bottom. A doubtful residue needs its local
        // distances to be wrong, and the shortest of them is the bond to its neighbour;
        // pinned exactly, the chain is too stiff to be doubtful anywhere and a
        // disordered model reads back 19 points too confident. Free within a tenth of
        // its length and firm past that, the backbone stays a backbone and the doubt
        // has somewhere to go.
        const h = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9, slack = h - rest[i];
        const off = slack > BOND_TOL ? slack - BOND_TOL : (slack < -BOND_TOL ? slack + BOND_TOL : 0);
        loss += wB * off * off;
        if (!g || !off) continue;
        const f = 2 * wB * off / h, i3 = i * 3, j3 = i3 + 3;
        g[j3] += f * dx; g[j3 + 1] += f * dy; g[j3 + 2] += f * dz;
        g[i3] -= f * dx; g[i3 + 1] -= f * dy; g[i3 + 2] -= f * dz;
      }
      return loss;
    }
    // ...walked downhill: momentum for the direction, and a step taken only while it
    // helps. Scaled by the field's own root-mean-square the move is the same size
    // whatever the loss is, so a settled model would walk away from its own answer;
    // halved whenever it does not help, the fit ends where it is best and needs no
    // learning rate chosen per protein.
    const g = new Float64Array(n * 3), mt = new Float64Array(n * 3), vt = new Float64Array(n * 3);
    const dir = new Float64Array(n * 3), trial = ref.map(q => q.slice());
    const recalibrate = () => {
      if (!pairs || !L.score) return;
      L.score(pairs, ref, hard, coords);
      for (let i = 0; i < n; i++) bias[i] = lddt[i] - hard[i];
    };
    let loss = evaluate(ref, g);
    recalibrate();
    loss = evaluate(ref, g);
    let scale = FIT_LR;
    for (let it = 1; it <= FIT_ITERS; it++) {
      // 🔴 PRECONDITIONED, OR THE FIT CANNOT MOVE AT ALL. A residue that a sampled row's
      // frame is built from carries the whole of that row's gradient and is a hundred
      // times steeper than the rest of the field; one step size for all of them is set
      // by the steepest, and a doubtful model got nowhere. Each coordinate is divided by
      // its own recent gradient size, with a floor at a fraction of the field's, so the
      // flat parts still move and a residue with nothing to correct still does not.
      const b1c = 1 - Math.pow(B1, it), b2c = 1 - Math.pow(B2, it);
      let vs = 0;
      for (let q = 0; q < n * 3; q++) {
        mt[q] = B1 * mt[q] + (1 - B1) * g[q];
        vt[q] = B2 * vt[q] + (1 - B2) * g[q] * g[q];
        vs += vt[q];
      }
      const floor = EPS_REL * Math.sqrt((vs / (n * 3)) / b2c);
      let ss = 0;
      for (let q = 0; q < n * 3; q++) { dir[q] = (mt[q] / b1c) / (Math.sqrt(vt[q] / b2c) + floor); ss += dir[q] * dir[q]; }
      const rms = Math.sqrt(ss / (n * 3)) || 1e-12;
      let took = false;
      for (let tries = 0; tries < 5 && !took; tries++) {
        const step = scale / rms;
        for (let i = 0; i < n; i++) { const i3 = i * 3; trial[i][0] = ref[i][0] - step * dir[i3]; trial[i][1] = ref[i][1] - step * dir[i3 + 1]; trial[i][2] = ref[i][2] - step * dir[i3 + 2]; }
        const next = evaluate(trial, null);
        if (next < loss) {
          for (let i = 0; i < n; i++) { ref[i][0] = trial[i][0]; ref[i][1] = trial[i][1]; ref[i][2] = trial[i][2]; }
          loss = next; scale = Math.min(FIT_CAP, scale * 1.3); took = true;
        } else scale *= 0.4;
      }
      if (!took) { if (scale < 1e-4) break; }
      else if (it % RECAL === 0) { recalibrate(); loss = evaluate(ref, g); }
      else loss = evaluate(ref, g);
    }
    return ref;
  }
  // 🔴 ONE REFERENCE CARRIES BOTH, AND EVERY STRUCTURE HAS ONE. The error matrix is the
  // large scale of a displacement and the per-residue confidence is its fine detail, so a
  // single second structure holds both and the game reads them back with maths it already
  // runs - the map from the pair in each residue's own frame, the confidence from the
  // lDDT between them. Nothing about a prediction travels except that structure: a plain
  // crystal structure gets one too, wobbled to the confidence such a file is given, so
  // there is no predicted-versus-not branch anywhere downstream.
  //
  // The displacement is SMOOTHED over each residue's neighbours before the wobble goes
  // on. The matrix says how distant parts sit relative to one another; the fit's local
  // noise is not that, and left in it sets a floor on local disagreement that no wobble
  // can lift - GFP read as pLDDT 81 where the file says 97. Smoothed, the long range
  // survives and the detail is free: 2.3 points out on GFP, 1.7 on haemoglobin, 4.6 on
  // FUS, 8.0 on insulin, with the regenerated map 0.8 to 4.5 A of a 31.75 A scale.
  const SMOOTH_PASSES = 8;
  function referenceFor(coords, plddts, paeFlat, breaks, own) {
    const n = coords.length;
    const u = (paeFlat && paeFlat.length) ? referenceFrom(coords, paeFlat) : Array.from({ length: n }, () => [0, 0, 0]);
    // ...smoothed ALONG THE CHAIN, not through space. Averaging over spatial neighbours
    // mixes the displacement of parts that touch but genuinely disagree - two domains
    // packed against each other - and flattens exactly the error the matrix was stating:
    // on a barrel whose two sequence halves interleave, a 24 A separation came back as
    // 3.8. Along the chain the long range survives, the fit's local noise goes, and a
    // chain break stops the average, two chains being two chains.
    for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
      const next = new Array(n);
      for (let i = 0; i < n; i++) {
        let x = u[i][0] * 2, y = u[i][1] * 2, z = u[i][2] * 2, k = 2;
        if (i > 0 && !(breaks && breaks.has(i - 1))) { x += u[i - 1][0]; y += u[i - 1][1]; z += u[i - 1][2]; k++; }
        if (i < n - 1 && !(breaks && breaks.has(i))) { x += u[i + 1][0]; y += u[i + 1][1]; z += u[i + 1][2]; k++; }
        next[i] = [x / k, y / k, z / k];
      }
      for (let i = 0; i < n; i++) u[i] = next[i];
    }
    // ...and a seed wobble, so the fit has somewhere to push from. The lDDT of a
    // structure sitting exactly on the model is 1 with a flat gradient in every
    // direction; nudged off it, the fit can size each residue's disagreement. The
    // direction is fixed by index and smoothed along the chain (a chain break stops the
    // average), so both sides of a link start from the same structure and no seed has to
    // be agreed on.
    const raw = (i) => {
      const a = Math.sin(i * 12.9898) * 43758.5453, b = Math.sin(i * 78.233) * 12345.6789, c = Math.sin(i * 39.425) * 24634.6345;
      return [a - Math.floor(a) - 0.5, b - Math.floor(b) - 0.5, c - Math.floor(c) - 0.5];
    };
    const dirs = new Array(n);
    for (let i = 0; i < n; i++) dirs[i] = raw(i);
    for (let pass = 0; pass < 2; pass++) {
      const next = new Array(n);
      for (let i = 0; i < n; i++) {
        let x = dirs[i][0], y = dirs[i][1], z = dirs[i][2], k = 1;
        if (i > 0 && !(breaks && breaks.has(i - 1))) { x += dirs[i - 1][0]; y += dirs[i - 1][1]; z += dirs[i - 1][2]; k++; }
        if (i < n - 1 && !(breaks && breaks.has(i))) { x += dirs[i + 1][0]; y += dirs[i + 1][1]; z += dirs[i + 1][2]; k++; }
        next[i] = [x / k, y / k, z / k];
      }
      for (let i = 0; i < n; i++) dirs[i] = next[i];
    }
    for (let i = 0; i < n; i++) { const v = dirs[i], l = Math.hypot(v[0], v[1], v[2]) || 1; dirs[i] = [v[0] / l, v[1] / l, v[2] / l]; }
    // ...sized, before the fit, until the local agreement between the two structures
    // reads as each residue's own confidence. A residue the file calls certain (a grown
    // limb is 100) keeps its reference point on the model. This is a starting structure,
    // not the answer: the fit below descends from it and cannot climb out of a bad one,
    // and from a bare displacement a doubtful model settled twice as far out.
    const sure = (i) => (plddts[i] ?? 90) >= 99.5;
    const ref = new Array(n), amp = new Float64Array(n);
    for (let i = 0; i < n; i++) amp[i] = sure(i) ? 0 : 0.4;
    const rest0 = new Float64Array(Math.max(0, n - 1));
    for (let i = 0; i < n - 1; i++) rest0[i] = dist3(coords[i], coords[i + 1]);
    const knit = (P) => {
      for (let i = 0; i < n - 1; i++) {
        if (breaks && breaks.has(i)) continue;
        const a = P[i], b = P[i + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9, k = 0.5 * (l - rest0[i]) / l;
        a[0] += dx * k; a[1] += dy * k; a[2] += dz * k;
        b[0] -= dx * k; b[1] -= dy * k; b[2] -= dz * k;
      }
    };
    const lay = () => {
      for (let i = 0; i < n; i++) { const d = dirs[i], a = amp[i]; ref[i] = [coords[i][0] + u[i][0] + d[0] * a, coords[i][1] + u[i][1] + d[1] * a, coords[i][2] + u[i][2] + d[2] * a]; }
      knit(ref);
    };
    lay();
    const L0 = window.LDDT;
    if (L0 && L0.prepare) {
      const pairs = L0.prepare(coords, null), got = new Float32Array(n);
      for (let it = 0; it < 14; it++) {
        L0.score(pairs, ref, got, coords);
        for (let i = 0; i < n; i++) {
          if (sure(i)) continue;
          const want = Math.max(0.2, Math.min(0.995, (plddts[i] ?? 90) / 100)), have = Math.max(0.001, got[i]);
          const f = Math.max(0.5, Math.min(2, (1 - want + 1e-3) / (1 - have + 1e-3)));
          amp[i] = Math.max(0, Math.min(12, amp[i] * Math.pow(f, 0.6) + (want < have ? 0.05 : -0.02)));
        }
        lay();
      }
    }
    fitReference(coords, ref, plddts, paeFlat, breaks, own);
    return ref.map(p => [round3(p[0]), round3(p[1]), round3(p[2])]);
  }
  // The matrix laid over the grown chain: a grown limb has no error of its own, so its
  // rows and columns are zero and the model's own keep their values at their new indices.
  function growMatrixIndices(pae, map, n2) {
    const m = Math.round(Math.sqrt(pae.length)), out = new pae.constructor(n2 * n2);
    for (let i = 0; i < m; i++) { const r = map(i) * n2; for (let j = 0; j < m; j++) out[r + map(j)] = pae[i * m + j]; }
    return out;
  }

  // ---------------------------------------------------------------- the fighter
  // name: what to call it. text: the file. opts.pae: a flat n x n PAE (py2Dmol.paeFromJSON)
  // to draw under the live map. Returns the rig data game.js's makeForm takes, and a
  // description of what was found.
  function buildCustomFighter(name, text, opts = {}) {
    const trace = caTrace(text);
    // The model's own error travels as a REFERENCE STRUCTURE, not as a matrix: see
    // referenceFrom. Built once here, from the matrix the AlphaFold DB supplied.
    const paeIn = opts.pae || null;
    let paeGrown = paeIn;
    const n = trace.coords.length;
    // its secondary structure, py2Dmol's own, on the trace as read (scaling or turning
    // changes nothing about it, but it is computed once); then stood up, and the way up
    // that gives the better armature
    const sec = secondary(trace.coords);
    let coords = orient(trace.coords), found = findLimbs(coords, trace.breaks, sec), roles = assignRoles(found.limbs);
    { const flipped = flipY(coords), f2 = findLimbs(flipped, trace.breaks, sec), r2 = assignRoles(f2.limbs);
      if (armatureScore(r2) > armatureScore(roles)) { coords = flipped; found = f2; roles = r2; } }
    // The torso is what no limb took. NOT SCALED: a protein scaled to a size is a protein
    // whose bonds are no longer 3.8 A, which py2Dmol then draws as coil (its helices and
    // strands are read off the geometry) and the physics pulls back toward real bonds,
    // tearing it. It is only stood up and centred on its torso; the helix legs, if it
    // needs them, are sized to it instead.
    const limbIdx = new Set();
    for (const l of Object.values(roles)) for (let i = l.a; i <= l.b; i++) limbIdx.add(i);
    const torsoIdx = []; for (let i = 0; i < n; i++) if (!limbIdx.has(i)) torsoIdx.push(i);
    if (torsoIdx.length < 20) { for (let i = 0; i < n; i++) torsoIdx.push(i); limbIdx.clear(); for (const k of Object.keys(roles)) delete roles[k]; }
    const ty = torsoIdx.map(i => coords[i][1]), tMin = Math.min(...ty), tMax = Math.max(...ty);
    coords = coords.map(p => [p[0], p[1] - (tMin + tMax) / 2, p[2]]);
    const torsoBottom = -(tMax - tMin) / 2, torsoTop = (tMax - tMin) / 2;
    // What it lacks is grown out of its chain: legs if it has none (or one), arms if it
    // has none. Grown before the parts are cut, since growing moves every index after
    // the insertion.
    const special = chooseSpecial(sec, trace.plddts);   // the protein's own residues: chosen before anything is grown
    const meanPlddt = Math.round(mean(trace.plddts));
    // Legs come as a pair: one found alone is given up and both grown, so they stand
    // alike. An arm found alone keeps its place and the other is grown to it (a body
    // was left one-armed, its strikes landing with the arm it had).
    const need = [];
    if (!(roles.lleg && roles.rleg)) { need.push({ want: 'leg', sides: [-1, 1] }); delete roles.lleg; delete roles.rleg; }
    if (!roles.larm || !roles.rarm) need.push({ want: 'arm', sides: [!roles.larm ? -1 : null, !roles.rarm ? 1 : null].filter(v => v !== null) });
    let grown = {}, grownPlddt = null, modelOwn = null;
    if (need.length) {
      const g = growLimbs(coords, trace.plddts, trace.breaks, sec, roles, torsoBottom, torsoTop, need);
      coords = g.coords; trace.plddts = g.plddts; trace.breaks = g.breaks; roles = g.roles; grown = g.grown; grownPlddt = g.grownPlddt;
      if (paeIn && paeIn.length) paeGrown = growMatrixIndices(paeIn, g.map, coords.length);
      modelOwn = new Set(); for (let i = 0; i < n; i++) modelOwn.add(g.map(i));   // which residues the matrix actually speaks for
      // the torso is every residue no limb has
      const inLimb = new Set(); for (const l of Object.values(roles)) if (l) for (let i = l.a; i <= l.b; i++) inLimb.add(i);
      torsoIdx.length = 0; for (let i = 0; i < coords.length; i++) if (!inLimb.has(i)) torsoIdx.push(i);
    }
    const legsAdded = !!(grown.lleg || grown.rleg), armsAdded = !!(grown.larm || grown.rarm);

    const pivots = {}, domains = { torso: torsoIdx.slice() };   // torsoIdx as it stands after any growth
    const centre = [0, 0, 0];
    // Where a limb leaves the body: its end nearer the centre; and whether the other end
    // is attached too (a hairpin, out and back), which is then a hinge as well.
    const attachOf = l => l.grown ? (l.chainFirst ? l.b : l.a) : (dist3(coords[l.a], centre) < dist3(coords[l.b], centre) ? l.a : l.b);
    const along = (from, to, t) => add3(from, scale3(sub3(to, from), t));
    // A limb's residues laid along its axis, root to tip, as the built-in rigs lay out a
    // hairpin leg: both strands near the hip are thigh, both near the tip are foot. Each
    // residue's place is its projection on the root-to-tip line, 0 at the root, 1 at the
    // tip; `cuts` are where the parts change, and the residue where the chain crosses a
    // cut is left to no part, a hinge for the rig to bend at, as are the residues at the
    // root (and at the far end, if that is attached too).
    const partition = (l, parts, cuts) => {
      const root = attachOf(l), hip = coords[root], tip = coords[l.tip], axis = sub3(tip, hip), len2 = dot3(axis, axis) || 1;
      const part = {}, owned = {};
      // Monotone along each strand: from the root the place only grows to the tip, and
      // from the far end (a hairpin's other root) it only grows back to the tip, so a
      // stretch that wanders keeps one part until it has clearly reached the next.
      const u = {};
      for (let i = l.a; i <= l.b; i++) u[i] = dot3(sub3(coords[i], hip), axis) / len2;
      const v = {};
      const walk = (from, to, step) => { let m = -Infinity; for (let i = from; step > 0 ? i <= to : i >= to; i += step) { m = Math.max(m, u[i]); v[i] = m; } };
      if (root === l.a) { walk(l.a, l.tip, 1); walk(l.b, l.tip, -1); }
      else { walk(l.b, l.tip, -1); walk(l.a, l.tip, 1); }
      // a grown limb knows where its knee and its ankle are: the cuts are their places
      if (l.grown && cuts.length === 2 && l.kneeI != null) cuts = [u[l.kneeI], u[l.footI]];
      for (let i = l.a; i <= l.b; i++) {
        let k = 0; while (k < cuts.length && v[i] >= cuts[k]) k++;
        part[i] = parts[k];
      }
      // A grown limb's cuts get two hinge residues, the one each side of the boundary:
      // its strands pleat, and one residue between two rigid parts bent at the knee
      // could not take the angle without its bonds stretching (0.151 Å on hemoglobin's
      // knee, a whisker over what the rig test allows).
      for (let i = l.a; i <= l.b; i++) {
        const hinge = i === l.a || i === l.b || (i > l.a && part[i] !== part[i - 1]) || (l.grown && i < l.b && part[i + 1] !== part[i]);
        if (!hinge) (owned[part[i]] ??= []).push(i);
      }
      const at = t => along(hip, tip, t);
      return { owned, root: hip.slice(), tip: tip.slice(), at, cuts };
    };
    if (roles.head) {
      const { owned, root, at } = partition(roles.head, ['head'], []);
      domains.head = owned.head || []; pivots.neck = root; pivots.head_neck = root.slice(); pivots.head_cranium = at(0.5);
    }
    for (const side of ['l', 'r']) {
      const l = roles[side + 'arm']; if (!l) continue;
      const { owned, root, tip, at } = partition(l, [side + 'arm'], []);
      domains[side + 'arm'] = owned[side + 'arm'] || [];
      pivots[side + 'arm_shoulder'] = root; pivots[side + 'arm_elbow'] = at(0.5); pivots[side + 'arm_hand'] = tip;
    }
    // one arm found: the other's pivots mirror it, so the guard and the swings have two
    // shoulders to work from, with no residues of their own
    if (roles.rarm && !roles.larm) for (const k of ['shoulder', 'elbow', 'hand']) { const p = pivots['rarm_' + k]; pivots['larm_' + k] = [-p[0], p[1], p[2]]; }
    if (roles.larm && !roles.rarm) for (const k of ['shoulder', 'elbow', 'hand']) { const p = pivots['larm_' + k]; pivots['rarm_' + k] = [-p[0], p[1], p[2]]; }
    if (!roles.rarm && !roles.larm) {   // no arm at all: shoulders at the torso's sides, hands out, nothing to bend
      const y = torsoTop - 4, w = Math.max(...torsoIdx.map(i => Math.abs(coords[i][0])));
      for (const [side, sg] of [['l', -1], ['r', 1]]) { pivots[side + 'arm_shoulder'] = [sg * w, y, 0]; pivots[side + 'arm_elbow'] = [sg * (w + 20), y, 0]; pivots[side + 'arm_hand'] = [sg * (w + 44), y, 0]; }
    }
    for (const side of ['l', 'r']) {
      const l = roles[side + 'leg']; if (!l) continue;
      const { owned, root, tip, at, cuts } = partition(l, [side + 'leg_thigh', side + 'leg_shin', side + 'leg_foot'], [0.42, 0.85]);
      for (const part of ['thigh', 'shin', 'foot']) domains[side + 'leg_' + part] = owned[side + 'leg_' + part] || [];
      // a grown leg's knee and ankle are residues it knows; a found leg's lie on its axis
      pivots[side + 'leg_hip'] = root; pivots[side + 'leg_toe'] = tip;
      if (l.grown && l.kneeI != null) { pivots[side + 'leg_knee'] = coords[l.kneeI].slice(); pivots[side + 'leg_ankle'] = coords[l.footI].slice(); }
      else { pivots[side + 'leg_knee'] = at(cuts[0]); pivots[side + 'leg_ankle'] = at(cuts[1]); }
    }
    // The model's confidence and its error, as ONE structure: see referenceFor. Built
    // over the chain as it will fight, so a grown limb (confidence 100, no error of its
    // own) simply sits on the model.
    const ref = referenceFor(coords, trace.plddts, paeGrown, trace.breaks, modelOwn);
    const data = {
      n_ca: coords.length,
      ca_res: coords.map((_, i) => i + 1),
      ca_xyz: coords.map(p => [round3(p[0]), round3(p[1]), round3(p[2])]),
      chain_breaks: [...trace.breaks].sort((a, b) => a - b),
      ref,   // the model's confidence and its error, as a structure (referenceFor)
      pivots, domain_indices: domains,
      arm_hinge: 0.12,
    };
    return {
      name, rigData: data, special,
      residues: n, totalResidues: coords.length, hasPlddt: trace.hasPlddt, meanPlddt, grownPlddt,
      roles: Object.fromEntries(Object.entries(roles).filter(([, l]) => l).map(([k, l]) => [k, [l.a + 1, l.b + 1]])),
      legsAdded, armsAdded, grown: Object.fromEntries(Object.entries(grown).map(([k, l]) => [k, [l.a + 1, l.b + 1]])),
    };
  }

  // ------------------------------------------------------- a structure by its id
  // As py2Dmol has it: four characters is a PDB entry, from the RCSB; anything else a
  // UniProt accession, from the AlphaFold DB. Both through py2Dmol's own fetch, which
  // knows the archives' URLs; an AlphaFold model also gets, from the DB's API, what it
  // is called and where its PAE is, the PAE through py2Dmol's reader.
  async function fetchStructure(id) {
    const key = String(id || '').trim().toUpperCase();
    if (!key) throw new Error('a PDB id or a UniProt accession is needed');
    if (key.length === 4) return { text: await window.py2Dmol.fetch(key), pae: null, id: key, name: key, title: 'from the PDB', plddt: null, organism: '' };
    return fetchAlphaFold(key);
  }
  async function fetchAlphaFold(id) {
    const key = String(id || '').trim().toUpperCase();
    const api = await fetch(`https://alphafold.ebi.ac.uk/api/prediction/${encodeURIComponent(key)}`);
    if (!api.ok) throw new Error(`the AlphaFold DB has no ${key} (${api.status})`);
    const entries = await api.json();
    const e = Array.isArray(entries) && entries[0];
    if (!e) throw new Error(`the AlphaFold DB has no ${key}`);
    const text = await window.py2Dmol.fetch(key);
    let pae = null;
    if (e.paeDocUrl) { try { pae = window.py2Dmol.paeFromJSON(await (await fetch(e.paeDocUrl)).json()); } catch (err) { console.warn('PAE', err); } }
    return { text, pae, id: key, name: e.gene || e.uniprotId || key, title: e.uniprotDescription || '', plddt: e.globalMetricValue, organism: e.organismScientificName || '' };
  }

  const api = { caTrace, orient, findLimbs, assignRoles, chooseSpecial, buildCustomFighter, fetchStructure, fetchAlphaFold, SPECIALS, SMALL, MAX_RESIDUES };
  if (typeof window !== 'undefined') window.CustomPdb = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
