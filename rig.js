// Forward kinematics for a protein fighter (from ../dance/mocap_engine.js, with the arms
// reworked). Rigid domains follow joint rotations, each arm is two rigid halves hinged at
// the elbow, and hinge loops relax. Any protein with the same joints will do: the barrel
// humanoid (rig_data.js) and the helical fighter (rig_data_helix.js) both pose here.
(function () {
  const CA_STEP = 3.8021;

  const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const norm3 = a => Math.hypot(a[0], a[1], a[2]);
  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // 3x3 matrices, row-major flat arrays
  const mat3Eye = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const matT = m => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  function matMul3(A, B) {
    const out = new Array(9);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        out[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    return out;
  }
  const matVec3 = (M, v) => [
    M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
    M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
    M[6] * v[0] + M[7] * v[1] + M[8] * v[2],
  ];
  function rotX(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; }
  function rotY(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; }

  class DomainRig {
    constructor(data) {
      this.n = data.n_ca;
      this.bind = data.ca_xyz.map(p => p.slice());
      this.pivots = data.pivots;
      this.domains = data.domain_indices;
      this.chainBreaks = new Set(data.chain_breaks || []);
      // How much of each arm bends at the elbow, as a fraction of its length each side of
      // the joint. A helix arm bends in a few residues (a wider blend distorts its turns);
      // a hairpin sheet keeps more of its pairing when the bend is spread over a quarter.
      this.armHinge = data.arm_hinge ?? 0.07;
      // Which domain owns each residue; null for the hinge residues between domains.
      this.owner = new Array(this.n).fill(null);
      for (const name in this.domains) {
        if (!this.domains[name]) continue;
        for (const i of this.domains[name]) this.owner[i] = name;
      }
      // Tethers: a limb that hangs off the body by a hinge loop cannot be posed further
      // from its anchor than the loop reaches, so the whole limb, and each part down the
      // chain from a joint, is pulled back toward the residue the loop leaves from. Read
      // off the chain: the first residue outside the group before it, and after it.
      const chains = [['lleg_thigh', 'lleg_shin', 'lleg_foot'], ['rleg_thigh', 'rleg_shin', 'rleg_foot'], ['head'], ['larm'], ['rarm']];
      this.tethers = [];
      for (const chain of chains) for (let k = 0; k < chain.length; k++) {
        const group = chain.slice(k).filter(name => this.domains[name] && this.domains[name].length);
        if (!group.length) continue;
        const inside = i => this.owner[i] === null || group.includes(this.owner[i]);
        const idx = group.flatMap(name => this.domains[name]);
        if (!idx.length) continue;
        const lo = Math.min(...idx), hi = Math.max(...idx), pulls = [];
        let a = lo - 1; while (a >= 0 && inside(a) && !this.chainBreaks.has(a)) a--;
        let b = hi + 1; while (b < this.n && inside(b) && !this.chainBreaks.has(b - 1)) b++;
        if (a >= 0 && !this.chainBreaks.has(a)) pulls.push([lo, a, lo - a >= 2 ? (lo - a) * CA_STEP * 0.98 : CA_STEP, lo - a < 2]);
        if (b < this.n && !this.chainBreaks.has(b - 1)) pulls.push([hi, b, b - hi >= 2 ? (b - hi) * CA_STEP * 0.98 : CA_STEP, b - hi < 2]);
        if (pulls.length) this.tethers.push({ domains: group, pulls });
      }
    }

    // How far along an arm each of its residues sits: 0 at the shoulder, 1 at the hand,
    // by position along the shoulder-to-hand line. A helix arm runs from one end to the
    // other; a hairpin arm goes out and comes back, so its two strands share values.
    // Where the arm's elbow is, as a fraction of shoulder to hand: from the elbow pivot
    // if the rig gives one, projected onto the arm's line; otherwise halfway.
    elbowAt(name) {
      const P = this.pivots, e = P[name + '_elbow'];
      if (!e) return 0.5;
      const sh = P[name + '_shoulder'], axis = sub3(P[name + '_hand'], sh), d = sub3(e, sh);
      return Math.min(Math.max((d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]) / (axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2), 0.1), 0.9);
    }

    armParam(name) {
      const P = this.pivots, sh = P[name + '_shoulder'], axis = sub3(P[name + '_hand'], sh), L2 = axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2;
      return this.domains[name].map(i => {
        const d = sub3(this.bind[i], sh);
        return Math.min(Math.max((d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]) / L2, 0), 1);
      });
    }

    // An arm is two rigid halves, shoulder→elbow and elbow→hand, joined by a short
    // hinge. The rigid halves keep every i→i+3 and i→i+4 distance of the bind pose, so
    // the cartoon still reads helix (or strand) on both sides of the elbow; only the few
    // hinge residues bend. (The original smeared the bend over 60% of the arm by blending
    // rotations residue by residue, which distorted the helical turns by up to 3.7 Å.)
    // `param` is each residue's place along the arm, 0 shoulder … 1 hand (armParam).
    // `elbow` is where along the arm it bends, 0 shoulder … 1 hand: the rig's elbow pivot
    // if it has one, else halfway.
    _bendArm(ca, param, pShBind, pHandBind, pSh, Rup, Rfa, elbow = 0.5) {
      const n = ca.length, HINGE = this.armHinge;   // half-width of the hinge, as a fraction of the arm
      const pElBind = add3(pShBind, scale3(sub3(pHandBind, pShBind), elbow));
      const RupT = matT(Rup), RfaT = matT(Rfa);
      const pEl = add3(matVec3(RupT, sub3(pElBind, pShBind)), pSh);
      const out = new Array(n), free = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const s = param[i];
        const upper = add3(matVec3(RupT, sub3(ca[i], pShBind)), pSh);
        const fore = add3(matVec3(RfaT, sub3(ca[i], pElBind)), pEl);
        const u = Math.min(Math.max((s - (elbow - HINGE)) / (2 * HINGE), 0), 1);
        const w = u * u * (3 - 2 * u);
        out[i] = add3(scale3(upper, 1 - w), scale3(fore, w));
        free[i] = u > 0 && u < 1 ? 1 : 0;
      }
      // Restore bond lengths through the hinge without moving either rigid helix.
      for (let it = 0; it < 30; it++) {
        for (let i = 0; i < n - 1; i++) {
          if (!free[i] && !free[i + 1]) continue;
          const d = sub3(out[i + 1], out[i]), l = norm3(d);
          if (l < 1e-9) continue;
          const corr = scale3(d, (l - CA_STEP) / l);
          if (free[i] && free[i + 1]) { out[i] = add3(out[i], scale3(corr, 0.5)); out[i + 1] = sub3(out[i + 1], scale3(corr, 0.5)); }
          else if (free[i]) out[i] = add3(out[i], corr);
          else out[i + 1] = sub3(out[i + 1], corr);
        }
      }
      return out;
    }

    // transforms: {root_R, root_T, larm_upper, larm_lower, rarm_upper, rarm_lower,
    //   lleg_upper, lleg_lower, lleg_foot, rleg_upper, rleg_lower, rleg_foot, head}
    pose(tr) {
      const P = this.pivots, D = this.domains;
      const ca = this.bind.map(p => p.slice());
      const Rroot = tr.root_R || mat3Eye(), Troot = tr.root_T || [0, 0, 0];
      const RrootT = matT(Rroot);
      const pelvis = scale3(add3(P.lleg_hip, P.rleg_hip), 0.5);
      const fromRoot = p => add3(add3(matVec3(RrootT, sub3(p, pelvis)), pelvis), Troot);

      const Rlup = tr.larm_upper || Rroot, Rlfa = tr.larm_lower || Rlup;
      const Rrup = tr.rarm_upper || Rroot, Rrfa = tr.rarm_lower || Rrup;
      const Rlth = tr.lleg_upper || Rroot, Rlsh = tr.lleg_lower || Rlth, Rlft = tr.lleg_foot || Rlsh;
      const Rrth = tr.rleg_upper || Rroot, Rrsh = tr.rleg_lower || Rrth, Rrft = tr.rleg_foot || Rrsh;
      const Rhd = tr.head || Rroot;

      const pLsh = fromRoot(P.larm_shoulder), pRsh = fromRoot(P.rarm_shoulder);
      const pLhip = fromRoot(P.lleg_hip), pRhip = fromRoot(P.rleg_hip);
      const pLkn = add3(matVec3(matT(Rlth), sub3(P.lleg_knee, P.lleg_hip)), pLhip);
      const pLank = add3(matVec3(matT(Rlsh), sub3(P.lleg_ankle, P.lleg_knee)), pLkn);
      const pRkn = add3(matVec3(matT(Rrth), sub3(P.rleg_knee, P.rleg_hip)), pRhip);
      const pRank = add3(matVec3(matT(Rrsh), sub3(P.rleg_ankle, P.rleg_knee)), pRkn);

      // Each rigid domain: world = RT * bind + t, pinned at its joint.
      const pin = (R, pivotBind, pivotWorld) => [matT(R), sub3(pivotWorld, matVec3(matT(R), pivotBind))];
      const affine = {
        torso: [RrootT, sub3(add3(pelvis, Troot), matVec3(RrootT, pelvis))],
        lleg_thigh: pin(Rlth, P.lleg_hip, pLhip),
        lleg_shin: pin(Rlsh, P.lleg_knee, pLkn),
        lleg_foot: pin(Rlft, P.lleg_ankle, pLank),
        rleg_thigh: pin(Rrth, P.rleg_hip, pRhip),
        rleg_shin: pin(Rrsh, P.rleg_knee, pRkn),
        rleg_foot: pin(Rrft, P.rleg_ankle, pRank),
      };
      if (P.neck) affine.head = pin(Rhd, P.neck, fromRoot(P.neck));

      const owner = new Array(this.n).fill(null);
      for (const name in affine) {
        if (!D[name]) continue;
        const [R, t] = affine[name];
        for (const i of D[name]) { ca[i] = add3(matVec3(R, this.bind[i]), t); owner[i] = name; }
      }
      const arms = [
        ['larm', P.larm_shoulder, P.larm_hand, pLsh, Rlup, Rlfa],
        ['rarm', P.rarm_shoulder, P.rarm_hand, pRsh, Rrup, Rrfa],
      ].filter(([name]) => D[name] && D[name].length);
      this._armParam ??= {};
      for (const [name] of arms) this._armParam[name] ??= this.armParam(name);
      for (const [name, sb, hb, ps, Ru, Rf] of arms) {
        const bent = this._bendArm(D[name].map(i => this.bind[i]), this._armParam[name], sb, hb, ps, Ru, Rf, this.elbowAt(name));
        D[name].forEach((i, k) => { ca[i] = bent[k]; owner[i] = name; });
      }
      // Unowned hinge residues: blend the neighbouring domains' transforms.
      for (let i = 0; i < this.n; i++) {
        if (owner[i] !== null) continue;
        let a = i - 1; while (a >= 0 && owner[a] === null && !this.chainBreaks.has(a)) a--;
        let b = i + 1; while (b < this.n && owner[b] === null && !this.chainBreaks.has(b - 1)) b++;
        if (a < 0 || b >= this.n || this.chainBreaks.has(a)) continue;
        const f = (i - a) / (b - a);
        const [Ra, ta] = affine[owner[a]] || affine.torso, [Rb, tb] = affine[owner[b]] || affine.torso;
        ca[i] = add3(scale3(add3(matVec3(Ra, this.bind[i]), ta), 1 - f), scale3(add3(matVec3(Rb, this.bind[i]), tb), f));
      }
      this._relax(ca, owner, 40);
      return ca;
    }

    _relax(ca, owner, iterations) {
      const D = this.domains;
      const pull = (from, to, reach, exact) => {
        const d = dist3(ca[from], ca[to]);
        return d > reach || (exact && d < reach) ? scale3(sub3(ca[to], ca[from]), (exact ? 1 : 0.5) * (d - reach) / d) : [0, 0, 0];
      };
      const shiftDomains = (names, s) => {
        if (norm3(s) <= 1e-4) return;
        for (const name of names) for (const i of D[name]) ca[i] = add3(ca[i], s);
      };
      for (let it = 0; it < iterations; it++) {
        for (const { domains, pulls } of this.tethers) {
          let s = [0, 0, 0];
          for (const [from, to, reach, exact] of pulls) s = add3(s, pull(from, to, reach, exact));
          shiftDomains(domains, s);
        }
        for (let i = 0; i < this.n - 1; i++) {
          if (this.chainBreaks.has(i)) continue;
          if (owner[i] !== null && owner[i] === owner[i + 1]) continue;
          const d = sub3(ca[i + 1], ca[i]), l = norm3(d);
          if (l < 1e-9) continue;
          const corr = scale3(d, 0.5 * (l - CA_STEP) / l);
          const fixedA = owner[i] !== null, fixedB = owner[i + 1] !== null;
          if (fixedA && fixedB) continue;   // a bond straight between two rigid parts: the tether above holds it, so neither part is bent
          if (fixedA) ca[i + 1] = sub3(ca[i + 1], scale3(corr, 2));
          else if (fixedB) ca[i] = add3(ca[i], scale3(corr, 2));
          else { ca[i] = add3(ca[i], corr); ca[i + 1] = sub3(ca[i + 1], corr); }
        }
      }
    }
  }

  window.Rig = { CA_STEP, DomainRig, rotX, rotY, matMul3, mat3Eye };
})();
