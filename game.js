// Protein Fighter: two proteins, one py2Dmol scene, live coordinates. P1 is the beta
// barrel humanoid from ../dance; P2 the helical fighter (scripts/build_helix_fighter.py):
// a helix bundle with hairpin arms and helix legs. Both hang off the same joints.
// World units are Ångström. x runs across the arena, y is up, the floor is y = 0.
(function () {
  const { DomainRig, rotX: X, rotY: Y, matMul3: mul, mat3Eye: eye, CA_STEP } = window.Rig;
  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------- combat rules
  // The arena has no walls: the floor runs on, the camera follows, and the two fighters
  // can only get this far apart (torso to torso), which is where the screen's edge
  // becomes the wall once the camera has pulled back as far as it goes.
  const MAX_GAP = 300;
  const WALK = 130, JUMP_V = 655, JUMP_VX = 240, GRAVITY = 2400, FRICTION = 9;
  // Jumps: a knee bend to push off, falling faster than rising, a little air drag,
  // letting go of up early cuts it to a short hop, and the knees soak up the landing.
  // The torso rides the arc and the legs tuck up under it, so ~93 Å clears a fighter.
  const SQUAT = 0.07, FALL_BOOST = 1.35, AIR_DRAG = 0.4, SHORT_HOP = 0.65, LANDING = 0.2;
  // Street Fighter style: punch or kick, standing, crouching (low) or in the air.
  // push: knockback speed in Å/s, slid out by ground friction.
  // low: it unfolds only the legs. air: can only be thrown while airborne.
  const MOVES = {
    punch:    { duration: 0.24, active: 0.07, window: 0.07, damage: 7,  stun: 0.16, push: 120, fist: 'rarm',      text: 'HIT' },
    kick:     { duration: 0.40, active: 0.13, window: 0.09, damage: 10, stun: 0.24, push: 260, fist: 'rleg_foot', text: 'CRUNCH' },
    lowpunch: { duration: 0.22, active: 0.06, window: 0.07, damage: 5,  stun: 0.14, push: 90,  fist: 'rarm',      text: 'JAB' },
    lowkick:  { duration: 0.42, active: 0.14, window: 0.10, damage: 7,  stun: 0.22, push: 130, fist: 'rleg_foot', text: 'LOW KICK', low: true },
    airpunch: { duration: 0.30, active: 0.06, window: 0.14, damage: 8,  stun: 0.20, push: 140, fist: 'rarm',      text: 'HIT', air: true, overhead: true },
    airkick:  { duration: 0.40, active: 0.08, window: 0.22, damage: 14, stun: 0.32, push: 260, fist: 'rleg_foot', text: 'DROP KICK', air: true, overhead: true },   // the heavy one, as in Street Fighter
    // Holding forward: a straight with a lunge, and a roundhouse, the rear leg swung round
    // high. Slower to come out, harder when they land.
    straight:   { duration: 0.32, active: 0.11, window: 0.08, damage: 10, stun: 0.22, push: 200, fist: 'rarm',      text: 'STRAIGHT' },
    roundhouse: { duration: 0.52, active: 0.19, window: 0.10, damage: 14, stun: 0.3,  push: 320, fist: 'rleg_foot', text: 'ROUNDHOUSE' },
    // Forward + punch up close: a grab, unblockable, that lifts the other and flings it.
    throw:    { duration: 0.95, active: 0.14, window: 0.04, damage: 12, stun: 0.5,  push: 380, fist: 'rarm',      text: 'THROW', throw: true, hold: 0.38 },
    // Punch and kick together: a heat shock, a wave along the membrane from the hands
    // that unfolds what it reaches. It runs low, so it is blocked crouching. Once in a while.
    special:  { duration: 0.75, active: 0.18, window: 0.32, damage: 9,  stun: 0.4,  push: 220, fist: 'wave',      text: 'HEAT SHOCK', low: true, wave: true, reach: 300, again: 4 },
    // The bundle's own: a whirl with both paddles out, that can catch the other twice.
    // The barrel's own: it tucks into the cylinder it is and rolls end over end along the
    // membrane, mowing the other down; the body itself is the striking part.
    roll:     { duration: 0.95, active: 0.15, window: 0.55, damage: 8,  stun: 0.32, push: 300, fist: 'torso',     text: 'BARREL ROLL', wave: true, roll: true, again: 4, reach: 26 },
    spin:     { duration: 0.8,  active: 0.12, window: 0.5,  damage: 6,  stun: 0.3,  push: 320, fist: 'arms',      text: 'HELIX SPIN', wave: true, spin: true, multi: 2, again: 4 },
  };
  const SPECIAL = { barrel: 'roll', helix: 'spin', custom: 'special' };   // each protein's special, by form; a custom one's is set by its fold when it is loaded
  const GRAB = 34;            // Å between torsos, as drawn, within which a throw takes hold
  const ROLL_SPEED = 250;     // Å/s the barrel roll covers ground at
  const THROWS = false;       // the throw is switched off for now: it needs more work before it is worth having
  const REACH = 13;           // Å from striking residues to any defender residue
  // ...trimmed for the bundle, whose straight helix legs and long hairpin arms reached 5-10 Å
  // further than the barrel's at the same damage (measured: a kick landed from a 110 Å gap
  // against the barrel's 100), which read as the bundle simply hitting harder.
  const STRIKE_REACH = { barrel: 14, helix: 10, custom: 12 };
  const REFOLD = 0.02, REFOLD_DELAY = 2;   // unfolding recovered per residue per second, after this long unhit
  const DAMAGE_SCALE = 0.55;               // every hit softened, so a round takes about twice as many

  // ---------------------------------------------------------------------- forms
  // A form is a protein to fight as: its rig (the scaffold, joints and rigid domains),
  // the motion that drives it, and every index set the game reads off the chain. The
  // two fighters are different proteins, so each carries its own.
  // The PAE map: PAE_BIN residues a pixel each way on the built-in fighters, more on a
  // big custom protein so the map stays 64 pixels a side at most; and on a big protein
  // only every `stride`-th residue is aligned on (a row), every residue still scored
  // (the columns), so the update costs about 400 residues' worth of rows whatever the
  // size rather than the square of it.
  const PAE_BIN = 4, PAE_SIDE = 64, PAE_ROWS = 400;
  function makeForm(name, data) {
    const rig = new DomainRig(data), n = rig.n, D = rig.domains;
    const motion = window.Motion.create(rig, { MOVES, JUMP_V, JUMP_VX, SQUAT, LANDING });
    // Leg residues: each leg from where it leaves the torso to where it returns (or, a
    // leg at a chain end, to the end).
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
    // ...and each leg and arm on its own, so damage is felt by the limb that took it.
    const torso = D.torso || [];
    const legSide = Object.fromEntries(['l', 'r'].map(s => [s, legIdx.filter(i => rig.owner[i] && rig.owner[i].startsWith(s + 'leg'))]));
    for (const s of ['l', 'r']) if (!legSide[s].length) legSide[s] = legIdx;
    const armSide = { l: D.larm || [], r: D.rarm || [] };
    // The striking end of each limb, not only its tip.
    const reach = D.rarm?.length ? rig.armParam('rarm') : [];
    const reachL = D.larm?.length ? rig.armParam('larm') : [];
    // ...a custom fighter with one arm found and the other only mirrored has no residues
    // in it: its strikes then land with the arm it has
    let fist = (D.rarm || []).filter((_, k) => reach[k] > 0.64);
    let fistL = (D.larm || []).filter((_, k) => reachL[k] > 0.64);
    if (!fist.length) fist = fistL; if (!fistL.length) fistL = fist;
    const paeBin = Math.max(PAE_BIN, Math.ceil(n / PAE_SIDE)), pb = Math.ceil(n / paeBin), stride = Math.max(1, Math.ceil(n / PAE_ROWS));
    const paeCount = new Float32Array(pb * pb);
    const paeSum = new Float32Array(pb * pb);
    for (let i = 0; i < n; i += stride) for (let j = 0; j < n; j++) paeCount[(i / paeBin | 0) * pb + (j / paeBin | 0)]++;
    // A real PAE that came with the structure (the AlphaFold DB's), pooled to the map's
    // pixels: the floor the live map is drawn over, since an error the model already
    // had does not go away by standing still.
    let paeBase = null;
    if (data.pae_flat && data.pae_flat.length) {
      const m = Math.round(Math.sqrt(data.pae_flat.length));
      if (m >= 2) {
        paeBase = new Float32Array(pb * pb); const cnt = new Float32Array(pb * pb);
        const lim = Math.min(m, n);   // the map is laid over the grown chain already (custom_pdb.js growPae): grown residues have no error of their own
        for (let i = 0; i < lim; i++) for (let j = 0; j < lim; j++) { const b = (i / paeBin | 0) * pb + (j / paeBin | 0); paeBase[b] += data.pae_flat[i * m + j] / 8; cnt[b]++; }
        for (let b = 0; b < pb * pb; b++) paeBase[b] = cnt[b] ? paeBase[b] / cnt[b] : 0;
      }
    }
    // Which rigid part each residue belongs to, for the lDDT: a loop between parts is a
    // group of its own, so a limb swinging away from the body is not read as the body
    // coming apart, only what has come apart within a part.
    const group = new Array(n); let loops = 0;
    for (let i = 0; i < n; i++) { if (rig.owner[i]) group[i] = rig.owner[i]; else { if (i === 0 || rig.owner[i - 1]) loops++; group[i] = 'loop' + loops; } }

    return {
      name, rig, n, motion, legs, legIdx, legSide, armSide, fist, fistL,
      armIdx: [...(D.larm || []), ...(D.rarm || [])],
      kick: [...(D.rleg_shin || []), ...(D.rleg_foot || [])],
      frontKick: [...(D.lleg_shin || []), ...(D.lleg_foot || [])],
      torso,
      mid: torso.length ? torso[torso.length >> 1] : 0,   // a residue in the middle of the body
      // Deterministic per-residue direction, so jitter is stable frame to frame.
      jitterDir: Array.from({ length: n }, (_, i) => {
        const h = k => { const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return (v - Math.floor(v)) * 2 - 1; };
        return [h(1), h(2), h(3)];
      }),
      // The folded chain's own spacing two residues apart: enough stiffness that a
      // collapsing body crumples as a heavy chain rather than pouring out like a liquid,
      // while leaving helices and strands (set by spacing three and four apart) free to
      // come undone.
      localShape: [2].map(gap => [gap, Float32Array.from({ length: n - gap }, (_, i) => {
        const a = rig.bind[i], b = rig.bind[i + gap];
        return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      })]),
      // PAE map: residue pairs pooled into each pixel, and scratch space.
      pb, paeBin, stride, paeBase,
      paeCount, paeSum, paeFrames: new Float64Array(n * 12), refFrames: new Float64Array(n * 12),
      chainBreaks: rig.chainBreaks,
      // ...as a mask, and a running count, for the passes that ask per residue per iteration
      breakAt: Uint8Array.from({ length: n }, (_, i) => rig.chainBreaks.has(i) ? 1 : 0),
      breaksBefore: (() => { const c = new Int32Array(n + 1); for (let i = 0; i < n; i++) c[i + 1] = c[i] + (rig.chainBreaks.has(i) ? 1 : 0); return c; })(),
      basePlddt: data.base_plddt ? Float32Array.from(data.base_plddt) : null,
      group,
    };
  }
  const FORMS = { barrel: makeForm('barrel', window.HUMANOID_V8_RIG), helix: makeForm('helix', window.HELIX_FIGHTER_RIG) };

  // Which protein each player fights as: the picks on the title screen. A guest picks its
  // own (P2) and tells the host; the host's picks reach the guest with each new round.
  const pick = ['barrel', 'helix'];

  function newFighter(x, facing, form) {
    const N = form.n;
    const f = {
      form,                          // which protein this is: rig, motion and index sets
      x, y: 0, vx: 0, vy: 0, facing, hp: 100, crouch: false, queued: null, sinceHit: 99,
      squat: 0, jumpDir: 0, upReleased: false, landing: 0, landPower: 0,
      motion: null,                  // motion.js: pose springs, planted feet, the walk cycle
      brain: null,                   // the CPU's footwork, when it is the CPU
      dents: [],                     // recent impacts, springing back
      lastHit: null,                 // where the latest blow landed; a knockout unfolds from there
      fatigue: 0,                    // winded from attacking: deeper breathing, fades over time
      koWave: null, koLoose: null, koBurst: false,
      shock: new Float32Array(N),    // knocked loose by a blow, per residue, fading
      soft: new Float32Array(N),     // the unfolding as shown, easing after the real one
      jit: 5,
      settle: 0,                     // 1 → 0 while a new round's body gathers itself up
      action: 'idle', t: 0, hit: false, stun: 0, cooldown: 0,
      buffered: null,                // an attack pressed while unable to act, kept for a moment
      specialAt: -9,                 // when the last heat shock went out (clock)
      blockStun: 0,                  // braced behind a block, briefly unable to act
      blockHold: 0,                  // the CPU holding back to block, for this long
      guard: false,                  // the guard is up: block held (or the CPU bracing), on the feet, free
      unfold: new Float32Array(N),   // 0 folded … 1 denatured, per residue
      limp: 0.86,                    // how loose a fully unfolded residue hangs off the pose
      shockDecay: 0.955,             // how slowly the last blow's shaking dies away
      seed: Math.random() * 100,
      coords: null,
      heldBy: null, heldProg: 0, tumble: null,
      lddt: new Float32Array(N).fill(1),   // each residue's local geometry against its stance at the bell, 0..1
      shown: new Float32Array(N).fill(100),   // the pLDDT drawn and averaged on the HUD: the base pLDDT scaled by the lDDT
    };
    if (form.basePlddt) for (let i = 0; i < N; i++) f.shown[i] = form.basePlddt[i];
    if (form.basePlddt) {
      f.basePlddt = form.basePlddt;
      f.initUnfold = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        // A residue the model was unsure of starts loose, and stays so: pLDDT 95 and
        // above folded, 45 and below hanging free. Loose, not broken: it moves with
        // the body's motion as a loose chain does, but sits at the model's own
        // coordinates until a blow moves it, and refolds back to them.
        const u0 = clamp01((95 - form.basePlddt[i]) / 50);
        f.unfold[i] = u0;
        f.initUnfold[i] = u0;
      }
      f.initMean = meanUnfold(f);
      f.hp = health(f);
    }
    return f;
  }

  function attack(f, move) {
    const m = MOVES[move];
    if (!m || f.stun > 0 || f.blockStun > 0 || (MOVES[f.action] && !(m.wave && f.t < 0.09)) || f.action === 'thrown' || (f.cooldown > 0 && !m.wave)) return false;
    if (!!m.air !== f.y > 0) return false;
    if (m.wave) { if (f.y > 0 || clock - f.specialAt < m.again) return false; f.specialAt = clock; if (m.spin) sfx.spin(); else if (m.roll) sfx.roll(); else sfx.shock(); }
    f.hits = 0; f.hitAt = -1;
    Object.assign(f, { action: move, t: 0, hit: false, cooldown: m.duration });
    // The limb swings with a whoosh: short and high for a punch, longer and lower for a
    // kick. A guest hears its own fighter's here and the host's through the event.
    if (!m.wave) sfx.swing(m.fist === 'rarm' ? 'punch' : 'kick');
    f.fatigue = Math.min(1, f.fatigue + 0.12);
    return true;
  }

  // ------------------------------------------------------------------- animation
  const clamp01 = n => Math.max(0, Math.min(1, n));
  // How a body moves is motion.js - pose, hips, planted feet, leg IK, the rig - in one
  // pass. The game hands it the fighter and what damage has done to its bearing, and gets
  // back where every residue belongs; what damage does to the chain itself is added here.
  // The more of it has unfolded, the heavier it carries itself: it slumps (sag), nearly
  // gone it tips further forward (crawl), and winded it breathes deeper (tired).
  function bearing(f) {
    const m = meanUnfold(f);
    return { sag: 0.55 * clamp01((m - 0.18) / 0.75), crawl: clamp01((m - 0.66) / 0.32),
      tired: Math.min(1, Math.max(0.15, f.fatigue, 1.3 * m)), mean: m, kickRange: kickRange(f), bounce: f.warm || 0,
      legs: { l: legDamage(f, 'l'), r: legDamage(f, 'r') }, arms: { l: armDamage(f, 'l'), r: armDamage(f, 'r') } };
  }

  // Where each residue belongs this tick: the moving body (motion.js), then what damage
  // does to it. A blow dents it, and unfolded residues get a jitter that breaks the i→i+4
  // geometry, so py2Dmol's own secondary-structure assignment stops calling them helix or
  // strand.
  function targets(f, clock) {
    const { n: N, jitterDir } = f.form;
    const p = f.form.motion.update(f, { clock, dt: TICK, ...bearing(f) });
    // The pose as the rig wants it, before any damage is added: what the lDDT and the
    // PAE score the body against, so that a body that has moved whole scores whole.
    if (!f.poseRef || f.poseRef.length !== N) f.poseRef = Array.from({ length: N }, () => [0, 0, 0]);
    for (let i = 0; i < N; i++) { const q = p[i], r = f.poseRef[i]; r[0] = q[0]; r[1] = q[1]; r[2] = q[2]; }
    // A foot set down sends a ripple through the cytoplasm.
    const M = f.motion;
    if (M && M.stepSeq && M.stepSeq !== f.stepSeen) { f.stepSeen = M.stepSeq; if (f.y === 0) window.Cell?.ripple(M.stepX, f.action === 'walk' ? 1 : 0.6); }
    // A hit breaks the helices over a few frames rather than in one.
    for (let i = 0; i < N; i++) f.soft[i] += (f.unfold[i] - f.soft[i]) * 0.2;
    f.jit += ((f.hp === 0 ? 11 : 5) - f.jit) * 0.05;
    for (let i = 0; i < N; i++) {
      const q = p[i], d = Math.max(0, f.soft[i] - (f.initUnfold ? f.initUnfold[i] : 0));   // the jitter is damage, not the model's own loose stretches
      // The dent grows in over a few frames, then bounces back.
      for (const hit of f.dents) q[0] += hit.dir * hit.amp * Math.exp(-DENT_DECAY * hit.t) * Math.sin(DENT_BOUNCE * hit.t) * hit.w[i];
      if (d < 0.01) continue;
      // A fixed offset, not a wobble: it breaks the helix, then holds still. Stronger once
      // knocked out, so the heap is a tangle rather than a tidy kneel.
      const j = jitterDir[i], amp = f.jit * d;
      q[0] += j[0] * amp; q[1] += j[1] * amp; q[2] += j[2] * amp;
    }
    return p;
  }

  // The body. A folded residue sits on its target; an unfolded one is a bead on a
  // chain under gravity, so a denatured protein falls apart onto the floor. Every CA–CA
  // bond ends each tick at exactly CA_STEP. Mid-fight a residue only goes partway limp
  // (f.limp), so a battered protein still stands; a knockout lets go completely.
  const TICK = 1 / 60;

  function body(f, clock) {
    const { n: N, localShape: LOCAL_SHAPE, breakAt: BREAK, breaksBefore: BEFORE } = f.form, REST = f.form.rig.bondRest;
    const T = targets(f, clock), P = f.coords, u = f.unfold;
    f.targets = T;   // where the pose wanted each residue this tick (for inspection)
    if (!P) { f.prev = T.map(q => q.slice()); return T.map(q => q.slice()); }   // a copy: the rig reuses its pose array
    // Denatured chain is heavy: the pull on each unfolded residue grows with how unfolded
    // the whole protein is, and a knocked-out protein drops hardest of all.
    const collapsing = f.hp === 0;
    f.settle = Math.max(0, f.settle - TICK / 1.5);
    const fall = GRAVITY * TICK * TICK * (1.25 + 2 * meanUnfold(f)) * (collapsing ? 1.6 : 1);
    const loose = f.form.looseBuf || (f.form.looseBuf = new Float32Array(N));
    for (let i = 0; i < N; i++) {
      // How loosely a residue hangs off its pose: nothing while folded, rising steeply as
      // it unfolds, so only the low-pLDDT stretches swing and sag when the body moves.
      const p = P[i], o = f.prev[i], t = T[i], du = u[i];
      // Knocked out: half-held to the heap while it collapses, then let go as the unfolding
      // wave reaches this residue.
      let d = f.koLoose ? 0.5 + 0.42 * f.koLoose[i] : f.limp * (1 - (1 - du) * (1 - du));
      // A hard blow knocks chain loose for a moment, to fly and swing before it is pulled
      // back; a new round's body gathers itself back up from where the last one left it.
      d = Math.max(d, 0.97 * f.shock[i], 0.96 * Math.sqrt(f.settle));
      f.shock[i] *= f.shockDecay;
      const k = 1 - d, heat = 0;   // no random shaking: unfolded chain moves only when the body does
      loose[i] = d;
      const vx = (p[0] - o[0]) * 0.96, vy = (p[1] - o[1]) * 0.96, vz = (p[2] - o[2]) * 0.96;
      o[0] = p[0]; o[1] = p[1]; o[2] = p[2];
      p[0] += vx + (Math.random() - 0.5) * heat;
      p[1] += vy + (Math.random() - 0.5) * heat - fall * d;
      p[2] += vz + (Math.random() - 0.5) * heat;
      p[0] += (t[0] - p[0]) * k; p[1] += (t[1] - p[1]) * k; p[2] += (t[2] - p[2]) * k;
    }
    // Relax bonds, unfolded residues doing the moving; the floor pushes back with friction.
    for (let it = 0; it < 16; it++) {
      for (let i = 0; i < N - 1; i++) {
        if (BREAK[i]) continue;
        const a = P[i], b = P[i + 1], wa = u[i] * f.limp + 1e-3, wb = u[i + 1] * f.limp + 1e-3;
        const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        const l = Math.hypot(dx, dy, dz) || 1e-9, s = (l - REST[i]) / l / (wa + wb);   // held at the scaffold's own bond length
        a[0] += dx * s * wa; a[1] += dy * s * wa; a[2] += dz * s * wa;
        b[0] -= dx * s * wb; b[1] -= dy * s * wb; b[2] -= dz * s * wb;
      }
      // In a knockout the chain keeps its local shape (helix turns, strand pleats) as it
      // falls, so it crumples under its own weight instead of flowing out like a liquid.
      if (collapsing) for (const [gap, rest] of LOCAL_SHAPE) for (let i = 0; i < N - gap; i++) {
        if (BEFORE[i + gap] - BEFORE[i] > 0) continue;   // a break somewhere in the span: no shape across it
        const a = P[i], b = P[i + gap];
        const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        const l = Math.hypot(dx, dy, dz) || 1e-9, s = 0.25 * (l - rest[i]) / l;
        a[0] += dx * s; a[1] += dy * s; a[2] += dz * s;
        b[0] -= dx * s; b[1] -= dy * s; b[2] -= dz * s;
      }
      const grip = collapsing ? 0.7 : 0.4;
      for (let i = 0; i < N; i++) {
        const p = P[i];
        if (p[1] >= 1) continue;
        const o = f.prev[i];
        p[1] = 1; o[1] = 1; o[0] += (p[0] - o[0]) * grip; o[2] += (p[2] - o[2]) * grip;
      }
    }
    // Bond lengths back to CA_STEP. Intact residues stay exactly where the pose put them:
    // walking the whole chain from one anchor let a dangling loop drag everything after it,
    // folded torso included. Instead each loose stretch is solved on its own. Between two
    // intact residues that is FABRIK (inward from both ends, a few rounds); a stretch that
    // runs off a chain end, or a chain that is loose throughout, is laid out exactly.
    const place = (ref, q, rest) => {
      const dx = q[0] - ref[0], dy = q[1] - ref[1], dz = q[2] - ref[2];
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-6) { q[0] = ref[0] + rest; return; }
      const s = rest / l;
      q[0] = ref[0] + dx * s; q[1] = ref[1] + dy * s; q[2] = ref[2] + dz * s;
    };
    const LOOSE = 0.02;
    for (let i = 0; i < N;) {
      if (loose[i] < LOOSE) { i++; continue; }
      const a = i;
      while (i < N && loose[i] >= LOOSE && !BREAK[i]) i++;
      if (i < N && loose[i] >= LOOSE && BREAK[i]) i++;
      const b = i - 1, left = a - 1, right = b + 1;
      const isLeftUnbound = left < 0 || BREAK[left];
      const isRightUnbound = right >= N || BREAK[b];
      if (isLeftUnbound && isRightUnbound) for (let j = a + 1; j <= b; j++) place(P[j - 1], P[j], REST[j - 1]);
      else if (isLeftUnbound) for (let j = b; j >= a; j--) place(P[j + 1], P[j], REST[j]);
      else if (isRightUnbound) for (let j = a; j <= b; j++) place(P[j - 1], P[j], REST[j - 1]);
      else for (let round = 0; round < 10; round++) {
        for (let j = b; j >= a; j--) place(P[j + 1], P[j], REST[j]);
        for (let j = a; j <= b; j++) place(P[j - 1], P[j], REST[j - 1]);
      }
    }
    return P;
  }

  // The striking end of the limb (see makeForm), where it is now.
  function strikePoints(f, move) {
    const m = MOVES[move], c = f.coords;
    const idx = m.fist === 'rarm' ? f.form.fist : m.fist === 'arms' ? [...f.form.fist, ...f.form.fistL] : m.fist === 'torso' ? f.form.torso : m.fist === 'wave' ? [] : move === 'kick' ? f.form.frontKick : f.form.kick;
    return idx.map(i => c[i]);
  }

  // Where a strike lands: the defender's residue closest to any striking residue, if it
  // is within reach. Damage, the dent and the callout all centre on that residue, so the
  // hit shows on the part that was actually struck rather than at the attacker's fist.
  function contact(a, b) {
    let best = null, bestD = MOVES[a.action].reach ?? STRIKE_REACH[a.form.name] ?? REACH;
    // Each axis first, against the best so far: on a two-thousand-residue body almost
    // every residue is out of reach on x alone, and a compare is a fraction of a hypot.
    const B = b.coords;
    for (const s of strikePoints(a, a.action)) {
      const sx = s[0], sy = s[1], sz = s[2];
      for (let j = 0; j < B.length; j++) {
        const q = B[j], dx = q[0] - sx; if (dx > bestD || dx < -bestD) continue;
        const dy = q[1] - sy; if (dy > bestD || dy < -bestD) continue;
        const dz = q[2] - sz; if (dz > bestD || dz < -bestD) continue;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < bestD) { bestD = d; best = q; }
      }
    }
    return best && best.slice();
  }

  // ------------------------------------------------------------------ damage
  const partDamage = (f, idx) => (!idx || !idx.length) ? 0 : idx.reduce((s, i) => s + f.unfold[i], 0) / idx.length;
  // The mean unfolding of the chain within `radius` Å of a point.
  function localUnfold(f, at, radius) {
    let s = 0, n = 0;
    for (let i = 0; i < f.form.n; i++) {
      const q = f.coords[i];
      if (Math.hypot(q[0] - at[0], q[1] - at[1], q[2] - at[2]) < radius) { s += f.unfold[i]; n++; }
    }
    return n ? s / n : 0;
  }
  // Each limb's damage on its own: a leg that took the kicks is the leg that limps.
  const legDamage = (f, side) => partDamage(f, f.form.legSide[side]);
  const armDamage = (f, side) => partDamage(f, f.form.armSide[side]);
  const worstLeg = f => Math.max(legDamage(f, 'l'), legDamage(f, 'r'));
  // Unfolded legs still carry a fighter, just slowly: the worse leg sets the pace, down
  // to a fifth of it.
  const mobility = f => Math.max(0.2, 1 - 0.5 * worstLeg(f) - 0.2 * Math.min(legDamage(f, 'l'), legDamage(f, 'r')) - 0.25 * meanUnfold(f));
  // Which limb a move is thrown with: the right arm punches, the front (left) leg throws
  // the standing kick, the back (right) leg the rest, the spin uses both arms.
  const limbOf = (f, move) => {
    const m = MOVES[move];
    if (!m) return f.form.legIdx;
    if (m.fist === 'rarm') return f.form.armSide.r;
    if (m.fist === 'arms' || m.fist === 'wave') return f.form.armIdx;
    if (m.fist === 'torso') return f.form.torso;
    return move === 'kick' ? f.form.legSide.l : f.form.legSide.r;
  };
  // A strike comes from a limb: the more that limb, and the protein as a whole, has
  // unfolded, the slower it plays out (up to ~2.4x) and the less it hurts (down to a quarter).
  const strikeSlow = f => 1 + 0.9 * partDamage(f, limbOf(f, f.action)) + 0.5 * meanUnfold(f);
  const strikePower = (f, move) => Math.max(0.25, 1 - 0.6 * partDamage(f, limbOf(f, move)) - 0.3 * meanUnfold(f));
  // ...and how far a kick can swing at all: the leg lift and the lean back, as a fraction
  // of a healthy kick, for the leg that kicks. Down to half with the leg and the protein
  // gone: at a third the limp leg never left the floor (the foot peaked 1.7 Å up at 90%
  // unfolded).
  const kickRange = f => Math.max(0.5, 1 - 0.5 * partDamage(f, limbOf(f, MOVES[f.action] ? f.action : 'roundhouse')) - 0.3 * meanUnfold(f));

  // Health is how folded the protein still is: 100 intact, 0 fully denatured. It is
  // read off the unfolding, not kept alongside it, so the bar, the colours and the
  // knockout always agree.
  const meanUnfold = f => f.unfold.reduce((s, v) => s + v, 0) / f.unfold.length;
  // Health is what the protein has left to lose: a body whose model came with loose
  // stretches (low pLDDT) starts whole, in its own natural state, and is knocked out
  // when everything it had folded has come apart. The built-in fighters start with
  // nothing loose, so for them it is simply how much is still folded.
  const health = f => { const lost = meanUnfold(f) - (f.initMean || 0), can = 1 - (f.initMean || 0); return Math.max(0, Math.round(100 * (1 - (can > 1e-6 ? lost / can : 1)))); };
  // pLDDT 100 is intact; fully denatured lands just under 50, AlphaFold's line for
  // disordered, so it reaches the orange band (the palette calls exactly 50 yellow).
  const toPlddt = d => 100 - 50.2 * d;

  // A hit unfolds `amount` percent of the protein, concentrated near the impact: a jab
  // nicks a small patch, a drop kick craters a wide one (the radius grows with the blow),
  // spread across the struck face rather than through the body (the far side is spared), and deepest where the
  // chain has already come loose, so a battered spot takes the next blow worst. Residues
  // that are fully unfolded pass their share on. A low hit unfolds the legs, until there
  // is no leg left to unfold.
  function wound(b, at, amount, legsOnly, dir = 0) {
    const { n: N, legs: LEGS } = b.form;
    let budget = amount / 100 * N;
    const weight = new Float32Array(N), radius = 18 + 1.6 * amount;
    for (let pass = 0; pass < 8 && budget > 1e-6; pass++) {
      const legsLeft = legsOnly && [...b.unfold].some((v, i) => LEGS[i] && v < 1);
      let sum = 0;
      for (let i = 0; i < N; i++) {
        if (b.unfold[i] >= 1 || (legsLeft && !LEGS[i])) { weight[i] = 0; continue; }
        const q = b.coords[i], r = Math.hypot(q[0] - at[0], q[1] - at[1], q[2] - at[2]);
        const deep = r > 1e-6 ? Math.max(0, (q[0] - at[0]) * dir / r) : 0;   // 1 straight on into the body from the contact, 0 across the struck face
        weight[i] = (Math.exp(-(r * r) / (2 * radius * radius)) * (1 - 0.5 * deep) + 0.005) * (1 + 0.4 * b.unfold[i]);
        sum += weight[i];
      }
      if (sum === 0) break;
      let used = 0;
      for (let i = 0; i < N; i++) {
        if (!weight[i]) continue;
        const add = Math.min(1 - b.unfold[i], budget * weight[i] / sum);
        b.unfold[i] += add; used += add;
      }
      budget -= used;
    }
    // The blow itself: unfolded residues near the impact are knocked along the strike
    // (and a little up) and shaken loose for a moment, so a battered stretch of chain
    // whips instead of just recolouring. The more of the protein has unfolded, the harder
    // and wider the blow throws it. Folded residues sit on their targets and barely notice.
    if (b.prev) {
      const mess = 1 + 1.2 * meanUnfold(b), reach = (radius + 8) * (1 + 0.5 * meanUnfold(b));
      const push = Math.min(11, amount * 1.4 * mess), lift = Math.min(5, amount * 0.5 * mess);
      for (let i = 0; i < N; i++) {
        const q = b.coords[i], r = Math.hypot(q[0] - at[0], q[1] - at[1], q[2] - at[2]);
        const w = Math.exp(-(r * r) / (2 * reach * reach)) * b.unfold[i];
        if (w < 0.02) continue;
        b.prev[i][0] -= dir * push * w;   // verlet: velocity is position minus previous
        b.prev[i][1] -= lift * w;
        // Knocked loose to whip out and swing under gravity before the pose gathers it
        // back; a heavy blow shakes it longer.
        b.shock[i] = Math.max(b.shock[i], Math.min(0.7, w * (0.25 + (mess - 1)) * 0.8));
      }
      b.shockDecay = 0.955 + 0.015 * clamp01(amount / 8);
    }
    b.hp = health(b);
    b.sinceHit = 0;
  }

  // The struck spot gives way: residues around it are pushed in along the blow, then
  // spring back through a couple of shrinking bounces, so it is plain where it landed.
  const DENT_RADIUS = 22, DENT_DECAY = 6, DENT_BOUNCE = 26, DENT_LIFE = 0.8;
  function dentWeights(b, at) {
    const N = b.form.n, w = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const q = b.coords[i], r = Math.hypot(q[0] - at[0], q[1] - at[1], q[2] - at[2]);
      w[i] = Math.exp(-(r * r) / (2 * DENT_RADIUS * DENT_RADIUS));
    }
    return w;
  }
  function dent(b, at, dir, power) {
    b.dents.push({ w: dentWeights(b, at), at, dir, amp: 4 + power * 0.45, t: 0 });
    if (b.dents.length > 4) b.dents.shift();
  }

  // ------------------------------------------------------------------- the scene
  let viewer, template;

  // Light: hand-drawn richardson cartoons on white. Dark: solid 3d shading on black.
  // Dark unless this browser has chosen light before.
  const THEME_KEY = 'protein-fighter-theme';
  let theme = (() => {
    try { if (localStorage.getItem(THEME_KEY) === 'light') return 'light'; } catch {}
    return 'dark';
  })();
  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    const b = $('theme'), other = theme === 'dark' ? 'light' : 'dark';
    b.textContent = theme === 'dark' ? '☾' : '☀';
    b.title = other + ' theme'; b.setAttribute('aria-label', 'Switch to the ' + other + ' theme');
  }
  // Colouring: pLDDT (damage, as AlphaFold would colour confidence) or a rainbow along
  // the chain, which shows how each protein is threaded. pLDDT unless chosen otherwise.
  const COLOUR_KEY = 'protein-fighter-colour';
  let colour = (() => {
    try { const v = localStorage.getItem(COLOUR_KEY); if (['rainbow', 'ss'].includes(v)) return v; } catch {}
    return 'plddt';
  })();
  function applyColour() {
    for (const b of document.querySelectorAll('[data-colour-choice]')) {
      const on = b.dataset.colourChoice === colour;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    if (viewer) viewer.setColor({ rainbow: 'rainbow', ss: 'ss' }[colour] || 'deepmind');   // deepmind: AlphaFold DB pLDDT colours
  }

  function pdbText(a, b) {
    // One chain per fighter, its residues numbered in order, with a number skipped at
    // every break in the chain: py2Dmol joins a residue only to the adjacent number, so a
    // gap is a break in the backbone as it draws it (a custom protein's chains and
    // missing loops, and the helix legs given to one, each a piece of its own).
    let s = '', n = 1;
    const write = (coords, chain, form) => {
      const breaks = form?.chainBreaks || new Set();
      let num = 0;
      coords.forEach((q, i) => {
        num++;
        s += `ATOM  ${String(n++).padStart(5)}  CA  GLY ${chain}${String(num).padStart(4)}    ` + q.map(v => v.toFixed(3).padStart(8)).join('') + '  1.00 90.00           C\n';
        if (breaks.has(i)) num++;
      });
      s += 'TER\n';
    };
    write(a, 'A', fighters?.[0]?.form || FORMS[pick[0]]);
    write(b, 'B', fighters?.[1]?.form || FORMS[pick[1]]);
    return s + 'END\n';
  }

  // Ribbons a third wider than the style's own default, so the fighters read at a glance.
  const RIBBON_WIDTH = 1.35;
  function startViewer(a, b) {
    // py2Dmol draws at the device's full pixel ratio unless told otherwise: on a phone,
    // capped at 1.5 as the cell canvases are, since a 3x screen would otherwise shade
    // four times the pixels, multisampled, for sharpness no one sees on a moving cartoon.
    if (PHONE) window.canvasDPR = Math.min(1.5, window.devicePixelRatio || 1);
    const style = theme === 'dark' ? '3d' : 'richardson';
    const presetWidth = window.py2dmolCartoon?.LOOK_DEFAULTS?.[style]?.width ?? 3;
    viewer = window.py2Dmol.show($('stage'), pdbText(a, b), {
      name: 'arena', style, orient: false, controls: false, play: false,
      select: false, box: false, biounit: false,
      // ortho under 0.5: a touch more perspective. detail: subdivisions per helix residue,
      // 4 py2Dmol's default; the mesh update costs in proportion, so a phone gets less.
      // gpuDirect (py2Dmol's default, said here so it is seen): its GL canvas sits in the
      // page under its own, rather than being copied into it every frame.
      rendering: { width: presetWidth * RIBBON_WIDTH, ortho: 0.4, detail: PHONE ? +(new URLSearchParams(location.search).get('detail') || 3) : 4, gpuDirect: true },
    });
    applyColour();
    // No ground of its own: the page's floor sits behind the proteins, not over them.
    viewer.setClearColor(true);
    // py2Dmol's fast path: a frame whose secondary structure is unchanged updates the
    // cartoon mesh in place instead of rebuilding it (a quarter off each draw here).
    window.py2dmolCartoonGPU?.setStationDraw?.(true);
    template = viewer.objectsData.arena.frames[0];
  }


  // The camera frames the fight. Left unset, py2Dmol centres on the running mean of
  // every frame it has been given, so the view would drift with the fight; instead it
  // is placed here every frame: between the two fighters, close when they are close and
  // pulled back as they part, never past the arena walls, and eased so it glides.
  // Straight on, so neither side looks to have the high ground, and tilted well down
  // onto the arena so the proteins' depth shows. The vertical extent is fixed, so on a
  // landscape screen the fight fills the height as it always did; on a narrow one the
  // width is what binds, and following the fighters is what keeps them on screen.
  // Tilted down enough to give the proteins depth, and no more, so the heads stand clear
  // of the shoulders rather than being looked down onto.
  const SIDE_PLATES = matchMedia('(max-height: 520px)'), UNDER_PLATES = matchMedia('(max-width: 640px) and (orientation: portrait)');   // where the menu's switches go
  const PHONE = matchMedia('(pointer: coarse)').matches;   // a touch screen: drawn at half rate, the cartoon coarser, the PAE rarer
  const SHOW_FPS = new URLSearchParams(location.search).has('fps');   // ?fps: frames, draws and their cost, under the timer, to measure on a device
  const CAMERA = { pitch: 0.5, yaw: 0, centerY: 70, x: 0, halfW: 240, minHalfW: 105, room: 80, halfH: 100, shake: 0, bx: 0, by: 0 };
  function frameCamera(dt) {
    const [a, b] = fighters, xa = barrelX(a), xb = barrelX(b);
    let want = Math.min(MAX_GAP / 2 + CAMERA.room, Math.max(CAMERA.minHalfW, Math.abs(xa - xb) / 2 + CAMERA.room));
    let mid = (xa + xb) / 2;
    // A knockout: push in on the loser as it comes apart.
    const loser = phase === 'ko' || phase === 'over' ? fighters.find(f => f.hp === 0) : null;
    if (loser) { want = CAMERA.minHalfW * 0.85; mid = barrelX(loser); }
    const k = 1 - Math.exp(-dt * 5), kz = 1 - Math.exp(-dt * 3);
    CAMERA.x += (mid - CAMERA.x) * k;
    CAMERA.halfW += (want - CAMERA.halfW) * kz;
    // A bump from a heavy blow: the view is knocked a few Å off and settles in a moment.
    CAMERA.shake *= Math.exp(-dt * 9);
    CAMERA.bx = (Math.random() - 0.5) * 2 * CAMERA.shake; CAMERA.by = (Math.random() - 0.5) * 2 * CAMERA.shake;
  }
  // py2Dmol fits the extent into 85% of the stage, whichever of width and height binds:
  // an aspect of halfW by halfH asks for that many Ångström each way.
  function pinCamera() {
    const cp = Math.cos(CAMERA.pitch), sp = Math.sin(CAMERA.pitch), cy = Math.cos(CAMERA.yaw), sy = Math.sin(CAMERA.yaw);
    const hx = 0.85 * CAMERA.halfW, hy = CAMERA.halfH, extent = Math.max(hx, hy);
    for (const v of [viewer.viewerState, viewer.objectsData.arena?.viewerState]) {
      if (!v) continue;
      v.center = { x: CAMERA.x + CAMERA.bx, y: CAMERA.centerY + CAMERA.by, z: 0 };
      v.extent = extent;
      v.extentAspect = { x: hx / extent, y: hy / extent };
      v.zoom = 1;
      v.rotation = [[cy, 0, sy], [sp * sy, cp, -sp * cy], [-cp * sy, sp, cp * cy]];   // pitch · yaw
    }
  }
  // The floor is drawn by the page, as a band: its far edge some way behind the feet,
  // its near edge in front. Where those lines fall on screen follows the camera, so the
  // feet stand on the floor at any size of screen.
  // The feet stand between 20 Å behind the pelvis and 25 Å in front of it.
  const FLOOR_FAR_Z = -30, FLOOR_NEAR_Z = 28, GRID = 20;   // Å between the floor's lines
  // py2Dmol's projection, so the page can draw to the same camera: a world point turned
  // into the camera's frame, then, with its partial perspective, scaled by focal / (focal
  // - depth). Returns [screen x, screen y, that scale factor] in stage pixels.
  function view() {
    const stage = $('stage'), W = stage.clientWidth, H = stage.clientHeight;
    const hx = 0.85 * CAMERA.halfW, hy = CAMERA.halfH;
    const scale = Math.min(0.85 * W / (2 * hx), 0.85 * H / (2 * hy));   // px per Å, as py2Dmol fits it
    const cp = Math.cos(CAMERA.pitch), sp = Math.sin(CAMERA.pitch);
    const fl = viewer.viewerState.focalLength || 200, ortho = viewer.viewerState.ortho;
    const cx = CAMERA.x + CAMERA.bx, cy = CAMERA.centerY + CAMERA.by;
    const project = (x, y, z) => {
      const dx = x - cx, dy = y - cy, ry = cp * dy - sp * z, rz = sp * dy + cp * z;
      const c = ortho < 1 ? fl / (fl - rz) : 1;
      return [W / 2 + dx * scale * c, H / 2 - ry * scale * c, c];
    };
    return { W, H, scale, project };
  }
  let floorShown = '';
  function placeFloor() {
    const { W, H, scale, project } = view();
    if (!W || !H) return;
    const line = z => project(CAMERA.x + CAMERA.bx, 0, z)[1];
    const far = line(FLOOR_FAR_Z), depth = line(FLOOR_NEAR_Z) - far;
    // The cell behind everything, and the effects over it, drawn to the same camera.
    window.Cell?.draw($('cell'), $('fx'), { camX: CAMERA.x, scale, project, floorFar: far, floorDepth: depth, theme, t: clock, dt: DT,
      bodies: fighters.map(f => ({ x: barrelX(f), y: f.y, w: 30 })) });
    // The floor's grid is drawn in the world: a line every GRID Å, scrolling with the camera.
    const step = GRID * scale, gridX = W / 2 - (CAMERA.x % GRID) * scale;
    const key = `${far.toFixed(1)}|${depth.toFixed(1)}|${step.toFixed(2)}|${gridX.toFixed(1)}`;
    if (key === floorShown) return;
    floorShown = key;
    const arena = document.querySelector('.arena');
    arena.style.setProperty('--floor-far', far.toFixed(1) + 'px');
    arena.style.setProperty('--floor-depth', depth.toFixed(1) + 'px');
    arena.style.setProperty('--grid-step', step.toFixed(2) + 'px');
    arena.style.setProperty('--grid-x', gridX.toFixed(1) + 'px');
  }

  let plddtBuf = null;   // the pLDDTs handed to py2Dmol, filled in place
  function draw() {
    const [a, b] = fighters;
    // replaceFrame draws the frame, and (py2Dmol's animation rule) keeps the camera
    // and the mesh where they are, so the cartoon is updated in place, not rebuilt.
    pinCamera();
    placeFloor();
    // Each residue's pLDDT as shown: its base (100 for the built-in fighters, the model's
    // own for a custom one) scaled by its lDDT against its stance, updated with the PAE.
    if (!plddtBuf || plddtBuf.length !== a.form.n + b.form.n) plddtBuf = new Array(a.form.n + b.form.n);
    for (let i = 0; i < a.form.n; i++) plddtBuf[i] = a.shown[i];
    for (let i = 0; i < b.form.n; i++) plddtBuf[a.form.n + i] = b.shown[i];
    viewer.replaceFrame({
      ...template,
      coords: a.coords.concat(b.coords),
      plddts: plddtBuf,
    }, 'arena');
  }

  // ------------------------------------------------------------------- the match
  const held = [new Set(), new Set()];   // directions each player is holding
  let mode = 1;                           // 1: you vs the CPU · 2: two players, one keyboard · 3: a remote challenger (net.js)
  // Remote play. Hosting: `link` streams state to the guest, who drives P2 through held[1].
  // A guest page (?join=…) runs no game of its own: it draws the host's state and sends keys.
  const net = { link: null, guest: !!window.Net?.joinId(), watch: !!window.Net?.watching(), events: [], seq: 0, lastUnfold: null, pkts: 0, bytes: 0, tick: 0, rtt: 0, dropped: false, watchers: 0 };
  const netEvent = (...e) => { if (net.link) net.events.push(e); };
  let fighters, wins = [0, 0], round = 1, time = 60, phase = 'ready', clock = 0, koTimer = 0, ai = 0, hitstop = 0;
  let tick = 0;   // game ticks, for effects that fire every few
  const names = () => [0, 1].map(i => fighters?.[i]?.form?.displayName || FORMS[pick[i]]?.displayName || (i ? 'P2' : 'P1'));

  function resetRound() {
    const old = fighters;
    const apart = phase !== 'ready' ? 80 : SIDE_PLATES.matches ? 112 : 100;   // warming up behind the menu they stand wider, clear of the settings between them; wider still on a phone on its side
    fighters = [newFighter(-apart, 1, FORMS[pick[0]]), newFighter(apart, -1, FORMS[pick[1]])];
    drawHalf = PHONE || fighters[0].form.n + fighters[1].form.n > BIG;
    CAMERA.x = 0;
    clearFinisher();
    netEvent('reset', pick.slice());
    time = 99; koTimer = 0; ai = 1.5; hitstop = 0;
    for (const h of held) h.clear();
    for (const f of fighters) { f.coords = body(f, clock); f.top = Math.max(...f.coords.map(q => q[1])); }   // the head's top, for the plate over it
    // The PAE reference is each fighter as it stands at the bell: healthy, in its stance.
    // Which pairs the lDDT scores (neighbours in the stance), and room for the pose's local
    // positions: both are measured against the undamaged pose each update, not the stance.
    for (const f of fighters) { f.paeLocal = new Float32Array(Math.ceil(f.form.n / f.form.stride) * f.form.n * 3); f.pae = new Float32Array(f.form.pb * f.form.pb); f.pairs = window.LDDT.prepare(f.coords, null); }
    // Then each body starts from wherever the last round left it, heap and all, and pulls
    // itself back together, rather than popping into place.
    if (old) fighters.forEach((f, i) => {
      if (old[i].form !== f.form) return;
      f.coords = old[i].coords.map(q => q.slice()); f.prev = old[i].coords.map(q => q.slice()); f.settle = 1;
    });
    if (viewer && old && (old[0].form !== fighters[0].form || old[1].form !== fighters[1].form)) startViewer(fighters[0].coords, fighters[1].coords);
  }

  // button: the one way on (resume, next round), or none to offer a choice of mode.
  function overlay(title, msg, button) {
    $('qr').hidden = true; $('joinbox').hidden = true;   // only the REMOTE code shows these
    $('title').textContent = title; $('title').hidden = !title;
    $('msg').textContent = msg; $('msg').hidden = !msg;
    $('go').hidden = !button;
    if (button) $('go').textContent = button;
    $('modes').hidden = !!button;
    $('overlay').hidden = false;
  }

  function start(newMode) {
    startMusic();
    if (phase === 'paused' && !newMode) {
      phase = 'playing';
      $('overlay').hidden = true;
      if (net.link) sendState();
      return;
    }
    if (newMode === 3 && !net.link) return hostRemote();   // show the code; the fight starts when the challenger arrives
    if (newMode && newMode !== 3 && net.link) { window.Net.stop(); net.link = null; }
    if (newMode) { mode = newMode; wins = [0, 0]; round = 1; }
    if (phase !== 'ready' || newMode) resetRound();
    phase = 'playing'; $('overlay').hidden = true; $('overlay').classList.remove('ended');
    announce(`ROUND ${Math.min(round, 3)} · FIGHT!`);
    if (net.link) sendState();
    sfx.round();
  }

  // Behind the menu the fighters warm up: bouncing on the balls of the feet, and every
  // second or two a punch or a kick thrown at the air, a hop, a squat. Nothing lands:
  // there is no contact check here, and the CPU is not thinking. A guest sees the host's
  // fighters as the packets put them, so it runs none of this.
  function warmUp(dt) {
    for (const f of fighters) {
      if (net.guest) break;
      f.warm = 1; f.crouch = false;
      f.t += dt;
      physics(f, dt);
      if (MOVES[f.action] && f.t >= MOVES[f.action].duration) { f.action = 'idle'; f.t = 0; f.cooldown = 0; }
      if (f.squat > 0 && (f.squat -= dt) <= 0) { f.squat = 0; jump(f, 0); }
      f.warmNext = (f.warmNext ?? 0.6 + Math.random()) - dt;
      if (f.warmNext <= 0 && f.action === 'idle' && f.y === 0 && !f.squat) {
        f.warmNext = 0.9 + Math.random() * 1.6;
        const r = Math.random();
        if (r < 0.7) shadow(f, r < 0.4 ? 'punch' : 'kick');
        else { f.squat = SQUAT; f.jumpDir = 0; f.upReleased = true; }   // a short hop
      }
    }
    for (const f of fighters) f.coords = body(f, clock);
  }
  // A blow at nothing: the move and its whoosh, no cooldown, so the next can follow.
  function shadow(f, move) {
    Object.assign(f, { action: move, t: 0, hit: false, cooldown: 0 });
    sfx.swing(move === 'punch' ? 'punch' : 'kick');
  }
  // The switches over the fighters' heads while the menu is up, following the heads.
  function placePlates() {
    const wrap = document.querySelector('.picks');
    const show = phase === 'ready' && !net.watch && (!$('modes').hidden || net.guest);
    if (wrap.hidden !== !show) wrap.hidden = !show;
    if (!show) return;
    // Under where the fighter stands, on the floor line, from its standing x rather than
    // its body, so nothing it does warming up (a bounce, a hop, a swing) moves them;
    // beside the shoulders on a phone on its side, where the pad has the floor.
    const at = SIDE_PLATES.matches ? 'side' : 'under';
    if (wrap.dataset.at !== at) wrap.dataset.at = at;
    const { W, project } = view();
    for (const el of wrap.children) {
      if (el.hidden) continue;
      const f = fighters[+el.dataset.player];
      let [sx, sy] = at === 'side' ? project(f.x - f.facing * 26, f.top - 14, 0) : project(f.x, -2, 0);
      // Kept on the screen: a fighter can stand near the edge.
      const w = el.offsetWidth, lo = at === 'side' && f.facing > 0 ? w + 4 : w / 2 + 4, hi = at === 'side' && f.facing < 0 ? W - w - 4 : W - w / 2 - 4;
      sx = Math.max(lo, Math.min(hi, sx));
      el.style.left = sx.toFixed(1) + 'px'; el.style.top = sy.toFixed(1) + 'px';
    }
  }

  function endRound() {
    const [p, c] = fighters;
    const winner = p.hp === c.hp ? -1 : p.hp > c.hp ? 0 : 1;
    if (winner >= 0) wins[winner]++;
    phase = 'over';
    const match = wins.includes(2);
    overlay(winner < 0 ? 'DRAW' : `${names()[winner]} WINS`, '', match ? null : 'REFOLD');
    $('overlay').classList.add('ended');   // no veil: the heap keeps settling behind it
    duckMusic(0.12);
    round++;
  }

  function walk(f, dir, dt, speed = 1) {
    if (f.stun > 0 || f.blockStun > 0 || MOVES[f.action] || f.action === 'thrown' || f.y > 0) return;
    const pace = (dir === -f.facing ? 0.6 : 1) * mobility(f) * speed;   // backing off is slower; bad legs slower still
    const dx = dir * WALK * pace * dt;
    f.x += dx;
    f.action = dir ? 'walk' : 'idle';
  }

  function jump(f, dir) {
    const legs = mobility(f);   // unfolded legs jump lower and shorter
    f.vy = JUMP_V * (0.55 + 0.45 * legs); f.vx = dir * JUMP_VX * legs; f.y = 0.01; f.crouch = false;
    sfx.jump();
  }

  // Gravity in the air; on the ground, knockback slides out under friction.
  // Landing ends an air attack.
  function physics(f, dt) {
    f.landing = Math.max(0, f.landing - dt);
    if (f.y > 0 || f.vy > 0) {
      if (f.upReleased && f.vy > JUMP_V * SHORT_HOP) f.vy = JUMP_V * SHORT_HOP;   // let go early: a short hop
      f.vy -= GRAVITY * (f.vy < 0 ? FALL_BOOST : 1) * dt;                          // falls faster than it rises
      f.vx *= Math.exp(-AIR_DRAG * dt);
      f.y = Math.max(0, f.y + f.vy * dt);
      if (f.y === 0) {
        f.landPower = clamp01(-f.vy / JUMP_V); f.landing = LANDING; f.vy = 0;
        if (f.landPower > 0.3) sfx.land(f.landPower);
        if (MOVES[f.action]?.air) { f.action = 'idle'; f.t = 0; f.cooldown = 0; }
        if (f.action === 'thrown' && f.heldBy == null) { f.action = 'hurt'; f.t = 0; f.stun = Math.max(f.stun, 0.45); f.lastLow = true; f.landPower = 1; f.tumble = null; sfx.land(1); CAMERA.shake = 4; window.Cell?.ripple(f.x, 1.6); }   // down in a heap, knees given
      }
    } else f.vx *= Math.exp(-FRICTION * dt);
    f.x += f.vx * dt;
  }

  // A player's held directions become movement: walk, down to crouch, up to jump the way
  // you are heading.
  function control(f, h, dt) {
    const dir = h.has('block') ? 0 : (h.has('right') ? 1 : 0) - (h.has('left') ? 1 : 0);   // holding block roots the feet
    const free = f.stun <= 0 && f.blockStun <= 0 && !MOVES[f.action] && f.action !== 'thrown' && f.y === 0 && !f.squat;
    f.crouch = (free || f.blockStun > 0) && h.has('down');
    walk(f, f.crouch || f.squat ? 0 : dir, dt);
    if (h.has('up') && free) { f.squat = SQUAT; f.jumpDir = dir; f.upReleased = false; h.delete('up'); }
    if (f.queued) {   // an attack pressed with the jump comes out once airborne
      if (clock > f.queued.until) f.queued = null;
      else if (f.y > 0 && attack(f, f.queued.move)) f.queued = null;
    }
  }

  // How hard the CPU fights: how often it thinks, and how ready it is to attack, jump
  // in, strike from the air, and brace against a blow it sees coming.
  // punish: seeing the player's move in its recovery, the chance each tick to hit back;
  // antiair: seeing the player jump in, the chance each tick to kick them out of the air.
  const LEVELS = {
    easy:   { think: [0.7, 0.6], attack: 0.25, jump: 0.1, air: 0.04, block: 0.006, punish: 0.01, antiair: 0.005, chase: 0.35, special: 0.05 },
    normal: { think: [0.4, 0.4], attack: 0.45, jump: 0.2, air: 0.1,  block: 0.02,  punish: 0.05, antiair: 0.03,  chase: 0.5,  special: 0.12 },
    hard:   { think: [0.15, 0.2], attack: 0.8, jump: 0.3, air: 0.2,  block: 0.35,  punish: 0.6,  antiair: 0.25,  chase: 0.8,  special: 0.25 },
  };
  const LEVEL_KEY = 'protein-fighter-cpu';
  let level = (() => { try { const v = localStorage.getItem(LEVEL_KEY); if (LEVELS[v]) return v; } catch {} return 'normal'; })();
  function showLevel() {
    for (const b of document.querySelectorAll('[data-level]')) b.classList.toggle('on', b.dataset.level === level);
  }
  // The CPU thinks a couple of times a second, commits to an attack only some of the
  // time, sometimes jumps in, and sits out the round-start callout.
  function cpu(c, p, dt) {
    const L = LEVELS[level];
    // Spacing is read off the barrels as drawn (the gap between them, last tick), put
    // back on the old centre-to-centre scale the thresholds below were tuned on.
    const gap = (c.barrelGap ?? Math.abs(p.x - c.x) - BARREL_SPAN) + BARREL_SPAN;
    const toward = Math.sign(barrelX(p) - barrelX(c)) || 1;
    ai -= dt;
    if (ai <= 0) {
      ai = L.think[0] + Math.random() * L.think[1];
      const free = c.stun <= 0 && !MOVES[c.action] && c.y === 0 && !c.squat;
      if (free && gap > 90 && gap < 160 && Math.random() < L.jump) { c.squat = SQUAT; c.jumpDir = toward; c.upReleased = false; }
      else if (free && gap < 75 && Math.random() < L.attack) {
        const r = Math.random();
        if (THROWS && gap < 48 && p.y === 0 && r < 0.3) attack(c, 'throw');
        else if (gap > (SPECIAL[c.form.name] === 'roll' ? 60 : 30) && gap < (SPECIAL[c.form.name] === 'roll' ? 170 : 70) && p.y === 0 && r < L.special) attack(c, SPECIAL[c.form.name]);
        else if (gap < 60 && r < 0.25) attack(c, Math.random() < 0.5 ? 'roundhouse' : 'straight');
        else attack(c, r < 0.4 ? 'punch' : r < 0.7 ? 'kick' : r < 0.85 ? 'lowkick' : 'lowpunch');
      }
    }
    if (c.y > 30 && gap < 70 && Math.random() < L.air) attack(c, Math.random() < 0.6 ? 'airkick' : 'airpunch');
    // Sees a strike coming: some of the time it braces, crouching for a low one, standing
    // for one from the air, and holds the guard a little past the blow.
    const pm = MOVES[p.action];
    if (pm && p.t < pm.active && gap < 85 && c.blockHold <= 0 && c.y === 0 && c.stun <= 0 && !MOVES[c.action] && Math.random() < L.block) {
      c.blockHold = 0.45; c.crouch = !!pm.low;
    }
    if (c.blockHold > 0) { if (c.crouch && !(pm && pm.low)) c.crouch = false; }
    else if (c.crouch && c.blockStun <= 0) c.crouch = false;
    // The player's move has come and gone and it is still recovering: hit back now, a
    // throw if it is right there. And a player sailing in through the air is kicked out
    // of it. This is what makes a strike thrown over and over a bad idea.
    const free = c.stun <= 0 && c.blockStun <= 0 && !MOVES[c.action] && c.action !== 'thrown' && c.y === 0 && !c.squat;
    if (free && pm && !pm.air && p.t > pm.active + pm.window && gap < 80 && Math.random() < L.punish) {
      c.crouch = false;
      attack(c, THROWS && gap < 48 ? 'throw' : Math.random() < 0.5 ? 'kick' : 'punch');
    } else if (free && p.y > 25 && gap < 95 && (p.vx * toward < 0 || Math.abs(p.vx) < 30) && Math.random() < L.antiair) {
      c.crouch = false; attack(c, 'kick');
    }
    // Footwork with a margin. It closes in at half a walk until it reaches its spacing, then
    // holds until the gap has opened 18 Å past that, and never sets off again within 0.4 s
    // of stopping. On a single threshold it flipped between walking and standing every few
    // frames, as its own breathing moved the barrel back and forth across the line: a twitch.
    const B = c.brain ??= { approach: true, since: 1 };
    const spacing = 62;
    B.since += dt;
    if (B.approach && gap <= spacing) { B.approach = false; B.since = 0; }
    else if (!B.approach && gap > spacing + 18 && B.since > 0.4) { B.approach = true; B.since = 0; }
    // Half a walk to close in, but a full one to catch up, and to run down a player who
    // keeps backing off (backing off is the slower walk, so it is caught).
    const fleeing = p.action === 'walk' && held[0].has(toward > 0 ? 'right' : 'left');
    walk(c, B.approach ? toward : 0, dt, fleeing || gap > 130 ? 1 : L.chase);
  }

  // Bodies push each other only where they actually touch: the two torsos (the β-barrel,
  // the helix bundle) as they are drawn this tick, leaning, lunging and all. Arms and
  // legs pass by each other (a strike is judged by contact() instead), and a jump clears
  // the other fighter because its torso is higher, not because of a height rule.
  const TOUCH = 7;   // Å: nearest CA of one torso to the other's, at which they are in contact
  // The CPU's spacing thresholds were tuned as centre distances with contact forced at
  // 42 Å; adding this to the barrel gap keeps each one the same distance from contact.
  const BARREL_SPAN = 42 - TOUCH;
  const barrelX = f => f.form.torso.reduce((s, i) => s + f.coords[i][0], 0) / f.form.torso.length;
  // The closest two torso residues come, one body to the other. Every pair on the
  // built-in fighters (a few thousand); on a big custom protein a torso can be two
  // thousand residues and every pair four million, so past a size it is every k-th
  // residue against every k-th, then the k around the nearest pair exactly.
  function barrelGap(a, b) {
    const A = a.form.torso, B = b.form.torso, ka = Math.max(1, Math.ceil(A.length / 120)), kb = Math.max(1, Math.ceil(B.length / 120));
    let best = Infinity, bi = 0, bj = 0;
    for (let ii = 0; ii < A.length; ii += ka) {
      const q = a.coords[A[ii]];
      for (let jj = 0; jj < B.length; jj += kb) {
        const r = b.coords[B[jj]], dx = q[0] - r[0], dy = q[1] - r[1], dz = q[2] - r[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) { best = d; bi = ii; bj = jj; }
      }
    }
    if (ka > 1 || kb > 1) for (let ii = Math.max(0, bi - ka); ii < Math.min(A.length, bi + ka + 1); ii++) {
      const q = a.coords[A[ii]];
      for (let jj = Math.max(0, bj - kb); jj < Math.min(B.length, bj + kb + 1); jj++) {
        const r = b.coords[B[jj]], dx = q[0] - r[0], dy = q[1] - r[1], dz = q[2] - r[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  }
  // Move a whole body along x, velocity untouched.
  function slide(f, dx) {
    f.x += dx;
    for (let i = 0; i < f.form.n; i++) { f.coords[i][0] += dx; f.prev[i][0] += dx; }
    return Math.abs(dx);
  }
  // Neither fighter can back away beyond the frame: the one moving off past MAX_GAP is
  // stopped there, as by a wall, while the other can still close in.
  function keepTogether() {
    for (const f of fighters) {
      const o = fighters[1 - fighters.indexOf(f)], d = f.x - o.x;
      if (Math.abs(d) > MAX_GAP) f.x = o.x + Math.sign(d) * MAX_GAP;
    }
  }
  function collide(a, b) {
    for (let it = 0; it < 4; it++) {
      const gap = barrelGap(a, b);
      a.barrelGap = b.barrelGap = gap;
      if (gap >= TOUCH) return;
      // Apart along x, each giving half; one against the wall leaves the other the rest.
      const s = barrelX(a) <= barrelX(b) ? 1 : -1, need = TOUCH - gap + 0.2;
      const moved = slide(a, -s * need / 2) + slide(b, s * need / 2);
      if (moved < need - 1e-6) slide(a, -s * (need - moved)), slide(b, s * (need - moved));
    }
  }

  function step(dt) {
    const [p, c] = fighters;
    tick++;
    time = Math.max(0, time - dt);
    for (const f of fighters) {
      f.warm = 0;
      f.t += MOVES[f.action] ? dt / strikeSlow(f) : dt;   // a battered limb strikes slower
      f.stun = Math.max(0, f.stun - dt); f.cooldown = Math.max(0, f.cooldown - dt);
      f.blockStun = Math.max(0, f.blockStun - dt); f.blockHold = Math.max(0, f.blockHold - dt);
      f.fatigue = Math.max(0, f.fatigue - dt * 0.08);
      physics(f, dt);
      f.dents = f.dents.filter(hit => (hit.t += dt) < DENT_LIFE);
      if (f.squat > 0 && (f.squat -= dt) <= 0) { f.squat = 0; jump(f, f.jumpDir); }
      if (MOVES[f.action] && f.t >= MOVES[f.action].duration) { f.action = 'idle'; f.t = 0; }
      f.sinceHit += dt;
      if (f.hp > 0 && f.sinceHit > REFOLD_DELAY) {
        let changed = false;
        for (let i = 0; i < f.form.n; i++) {
          const minU = f.initUnfold ? f.initUnfold[i] : 0;
          if (f.unfold[i] > minU) { f.unfold[i] = Math.max(minU, f.unfold[i] - REFOLD * dt); changed = true; }
        }
        if (changed) f.hp = health(f);
      }
    }

    flushBuffered();
    control(p, held[0], dt);
    if (mode === 2 || mode === 3) control(c, held[1], dt);
    else cpu(c, p, dt);
    // The guard shows as a pose: arms tight over the head, the front knee up.
    fighters.forEach((f, i) => { f.guard = f.y === 0 && f.stun <= 0 && !MOVES[f.action] && f.action !== 'thrown' && f.hp > 0 && (held[i].has('block') || f.blockHold > 0); });
    for (const f of fighters) if (f.action === 'thrown' && f.heldBy != null) holdThrown(f);
    // The barrel roll travels: along the membrane at a run for the rolling part, kicking
    // up lipids behind it, and a ripple with each turn.
    for (const f of fighters) if (f.action === 'roll') {
      const m = MOVES.roll, rolling = f.t > m.active && f.t < m.active + m.window;
      if (rolling) {
        f.x += f.facing * ROLL_SPEED * dt;
        if (tick % 4 === 0) window.Cell?.spark([barrelX(f) - f.facing * 18, 2, 0], -f.facing, 2, 'block');
        const turns = Math.floor((f.t - m.active) / m.window * 2);
        if (turns !== f.rollTurns) { f.rollTurns = turns; window.Cell?.ripple(barrelX(f), 1.1); }
      } else f.rollTurns = -1;
    }
    for (const f of fighters) if (f.action === 'special') { const w = waveAt(f); if (w != null && (net.seq & 1) === 0) window.Cell?.wave(w, f.facing); }
    // The helix spin flings ligands off the tips of its paddles as they whirl; the heat
    // shock throws them from the hands as they drive down, before the wave takes over.
    for (const f of fighters) {
      const m = MOVES[f.action], live = m && f.t > m.active && f.t < m.active + m.window;
      if (f.action === 'spin' && live && tick % 3 === 0) for (const tip of [f.form.fist, f.form.fistL]) { const at = f.coords[tip[tip.length - 1]], c = f.coords[f.form.mid]; window.Cell?.fling(at, Math.sign(at[0] - c[0]) || f.facing, 1.2); }
      if (f.action === 'special' && f.t > m.active * 0.5 && f.t < m.active + 0.12 && tick % 3 === 0) for (const tip of [f.form.fist, f.form.fistL]) window.Cell?.fling(f.coords[tip[tip.length - 1]], f.facing, 1);
    }

    keepTogether();

    // Bodies, then contact between them, then hits against the bodies as they are now
    for (const f of fighters) f.coords = body(f, clock);
    collide(p, c);
    // Facing only turns on the ground, so a cross-up hits from the far side, and only once
    // the other barrel is clearly past, so two barrels level with each other cannot flip it.
    for (const [f, o] of [[p, c], [c, p]]) {
      if (f.y === 0 && !MOVES[f.action] && (barrelX(o) - barrelX(f)) * f.facing < -3) f.facing = -f.facing;
    }
    // Hits are the host's call: a guest replays them from its events.
    if (!net.guest) fighters.forEach((a, i) => {
      const m = MOVES[a.action], b = fighters[1 - i];
      // Live from most of the way out, so a strike thrown point-blank lands where it meets
      // the body instead of passing through it before the active frame.
      if (!m || b.hp === 0 || a.t < m.active * 0.6) return;
      if (a.hit && !(m.multi && a.hits < m.multi && a.t - a.hitAt > 0.2)) return;   // a spin may land again, a moment on
      if (m.wave && !m.spin && !m.roll) {   // the shock wave: reaching the other, low along the floor
        const w = waveAt(a);
        if (w == null || Math.abs(w - barrelX(b)) > 24 || b.y > 30) return;
        const at = b.coords[b.form.mid].slice(); at[1] = Math.min(at[1], 30);
        const power = strikePower(a, 'special');
        if (canBlock(b, 1 - i, m)) { blockHit(i, 'special', at, power); netEvent('block', i, 'special', at, power); flash(at, 'BLOCK'); sfx.block(); return; }
        landHit(i, 'special', at, power); netEvent('hit', i, 'special', at, power); flash(at, m.text); sfx.hit(m.damage * power / 13);
        return;
      }
      if (m.throw) {   // a grab: the other must be on the ground and against this one
        if (a.t < m.active) return;
        if (b.y === 0 && b.action !== 'thrown' && barrelGap(a, b) < GRAB) { grab(i); netEvent('throw', i); flash(b.coords[b.form.mid], m.text); sfx.grab(); }
        else { a.hit = true; sfx.whiff(); }
        return;
      }
      if (a.t > m.active + m.window) { if (!a.hit) sfx.whiff(); a.hit = true; return; }   // whiffed: the window closed
      const at = contact(a, b);
      if (!at) return;
      // A strike is only as strong as the part throwing it (unfolded arms punch weaker,
      // unfolded legs kick weaker) and weakens further as the whole protein comes apart.
      // Everything a blow does follows its strength: the damage, and also how far it
      // shoves, how deep it dents, how long it stuns and how hard it lands on screen.
      const power = strikePower(a, a.action) * (m.multi && a.hits ? 0.8 : 1);
      a.hits = (a.hits || 0) + 1; a.hitAt = a.t;
      if (canBlock(b, 1 - i, m)) {
        blockHit(i, a.action, at, power);
        netEvent('block', i, a.action, at, power);
        flash(at, 'BLOCK');
        sfx.block();
        return;
      }
      landHit(i, a.action, at, power);
      netEvent('hit', i, a.action, at, power);
      flash(at, m.text);
      sfx.hit(m.damage * power / 13);
    });

    if (fighters.some(f => f.hp === 0) || time === 0) {
      phase = 'ko'; koTimer = 0; finished = false;
      for (const f of fighters) if (f.hp === 0) denature(f);
      if (!fighters.some(f => f.hp === 0)) announce('TIME');
      sfx.ko();
    }
  }

  // Blocking, as Street Fighter has it: hold back (away from the attacker) on the ground,
  // not in the middle of anything, and the blow is taken on the guard - or, as Mortal
  // Kombat has it, hold the block key (H, or , for P2), which also roots the feet. A low blow gets
  // under a standing guard and must be blocked crouching; one from the air comes over a
  // crouching guard and must be blocked standing. The CPU holds back for a moment of its
  // own accord now and then (blockHold).
  function canBlock(b, j, m) {
    if (b.y > 0 || b.stun > 0 || MOVES[b.action] || b.hp === 0) return false;
    const back = b.facing > 0 ? 'left' : 'right';
    if (!(b.blockHold > 0 || held[j].has(back) || held[j].has('block'))) return false;
    return m.low ? b.crouch : m.overhead ? !b.crouch : true;
  }
  // A blocked blow: no damage, a short brace, a shove back, and the guard arms jolted.
  function blockHit(i, move, at, power) {
    const a = fighters[i], b = fighters[1 - i], m = MOVES[move];
    a.hit = true;
    // A battered arm cannot hold the guard up: the worse arm lets a share of the blow
    // through (up to 60% of it with the arm gone), unfolding around the guard.
    const leak = 0.6 * Math.max(armDamage(b, 'l'), armDamage(b, 'r'));
    if (leak > 0.02) wound(b, at, m.damage * DAMAGE_SCALE * power * leak, m.low, a.facing);
    b.vx = a.facing * m.push * 0.55 * power;
    b.blockStun = m.stun * 0.75; b.lastHit = at;
    b.form.motion.jolt(b, { arms: (a.facing * b.facing < 0 ? -1 : 1) * 3 * power, head: 0, legs: m.low ? 3 : 1 });
    hitstop = 0.03;
    window.Cell?.spark(at, a.facing, m.damage * power * 0.5, 'block');
    CAMERA.shake = Math.min(3, 0.8 + m.damage * power * 0.15);
  }

  // Where the heat shock's wave is now: from the hands out along the floor over its
  // window, or nowhere.
  function waveAt(a) {
    const m = MOVES.special, u = (a.t - m.active) / m.window;
    return u < 0 || u > 1 ? null : a.x + a.facing * (22 + m.reach * u);
  }

  // The throw. Taking hold: the other stops what it is doing and is carried. Then, over
  // the hold, it is lifted up and over the thrower's head and flung, and only at the
  // release does the damage land: it comes down some way off, tumbling, and the lift
  // and the fall are its own.
  function grab(i) {
    const a = fighters[i], b = fighters[1 - i];
    a.hit = true;
    b.action = 'thrown'; b.t = 0; b.heldBy = i; b.heldProg = 0; b.tumble = null; b.stun = 0; b.blockStun = 0; b.squat = 0; b.crouch = false; b.queued = null; b.buffered = null; b.vx = 0; b.vy = 0;
    b.facing = -a.facing; b.combo = 0;
  }
  function holdThrown(b) {
    const a = fighters[b.heldBy], m = MOVES.throw;
    if (a.action !== 'throw') { b.heldBy = null; b.action = 'idle'; return; }   // the thrower was interrupted
    const prog = clamp01((a.t - m.active) / m.hold);
    b.heldProg = prog;
    b.x = a.x + a.facing * (26 - 44 * prog);   // carried in, up, and over the head
    b.y = 58 * Math.sin(prog * Math.PI * 0.5);
    if (prog < 1) return;
    // The release: flung backward over the thrower, damage at the torso, and a tumble.
    const power = strikePower(a, 'throw'), at = b.coords[b.form.mid].slice();
    b.heldBy = null; b.heldProg = 0; b.vx = -a.facing * m.push * power; b.vy = 330; b.y = Math.max(b.y, 1); b.tumble = -2.6;
    wound(b, at, m.damage * DAMAGE_SCALE * power, false, -a.facing);
    dent(b, at, -a.facing, m.damage * power);
    b.lastHit = at; b.stun = m.stun; b.lastLow = false;
    a.combo = (a.combo || 0) + 1; damageNumber(at, Math.round(m.damage * DAMAGE_SCALE * power * 10) / 10, a.combo);
    b.form.motion.jolt(b, { head: 14 * power, arms: 6 * power, legs: 6 * power });
    window.Cell?.spark(at, -a.facing, m.damage * power, 'hit');
    CAMERA.shake = 5;
    hitstop = 0.06;
    sfx.hit(1);
    if (b.hp === 0) { b.action = 'ko'; b.t = 0; }
  }

  // A blow from fighter i's `move` landing at `at` with this much of its strength.
  function landHit(i, move, at, power) {
    const a = fighters[i], b = fighters[1 - i], m = MOVES[move];
    a.hit = true;
    // Knocked back harder the more of it has come apart, and a fighter on bad legs is
    // shoved a stumble further; how soft the struck patch already is (the mean unfolding
    // within 25 Å) throws the parts about more, with nothing rigid there to take the blow.
    const legsGone = worstLeg(b), soft = localUnfold(b, at, 25);
    b.vx = a.facing * m.push * power * (1 + 0.8 * meanUnfold(b) + 0.6 * legsGone);
    wound(b, at, m.damage * DAMAGE_SCALE * power, m.low, a.facing);
    dent(b, at, a.facing, m.damage * power);
    b.lastHit = at;
    // The blow throws the parts about: struck in the head, the head whips on its neck
    // away from the blow (a hit from behind snaps it forward); struck anywhere, the
    // arms fly and the legs buckle, a low blow most of all.
    const high = at[1] > b.motion.hip[1] + b.form.motion.NECK_HEIGHT - 8;
    const away = a.facing * b.facing < 0 ? -1 : 1;
    const throwAbout = power * (1 + 1.2 * soft);
    b.form.motion.jolt(b, { head: away * (high ? 24 : 8) * throwAbout, arms: away * 5 * throwAbout, legs: (m.low ? 6 : 2.5) * throwAbout * (1 + legsGone) });
    // A hit on a fighter still reeling from the last, or still in the air from it, runs
    // the combo on; the count shows over the one taking it, with each hit's damage.
    a.combo = (b.stun > 0 || b.comboAir) ? (a.combo || 0) + 1 : 1;
    b.comboAir = b.y > 0;
    const dmg = Math.round(m.damage * DAMAGE_SCALE * power * 10) / 10;
    damageNumber(at, dmg, a.combo);
    b.stun = m.stun * (0.4 + 0.6 * power) * (1 + 0.6 * legsGone); b.action = 'hurt'; b.t = 0; b.squat = 0; b.lastLow = !!m.low;   // slower to gather itself on bad legs
    if (b.y > 0) b.vy = Math.max(b.vy, 260);   // hit in the air: popped up, then falls
    // Run over by the barrel roll, the other is tripped: flung into a tumble, to land in a
    // heap and get up (the flung throw's own fall), rather than merely staggered.
    if (m.roll && b.hp > 0) { b.action = 'thrown'; b.heldBy = null; b.heldProg = 0; b.tumble = -0.4; b.stun = 0; b.vy = 230; b.y = Math.max(b.y, 1); b.vx = a.facing * 200 * power; }
    hitstop = 0.05 + m.damage * 0.004 * power;
    window.Cell?.spark(at, a.facing, m.damage * power, 'hit');
    CAMERA.shake = Math.min(7, 1.5 + m.damage * power * 0.4);
    if (b.hp === 0) { b.action = 'ko'; b.t = 0; }
  }

  // Denaturing, in two acts. First the collapse: the knees give and the body drops into a
  // heap under its own weight, the chain still loosely holding the pose. Then the
  // unfolding: from where the last blow landed, a wave runs out along the chain, and each
  // residue it reaches lets go of the heap, with a shove outward as the fold breaks,
  // until a tangle lies spread on the floor.
  const COLLAPSE = 0.45, UNFOLD = 1.6, KO_HOLD = 3.4;   // seconds
  let finished = false;   // the finisher has been called this knockout
  function denature(f) {
    const N = f.form.n, at = f.lastHit || f.coords[f.form.mid];
    let brk = 0, bestD = Infinity;
    for (let i = 0; i < N; i++) {
      const q = f.coords[i], d = Math.hypot(q[0] - at[0], q[1] - at[1], q[2] - at[2]);
      if (d < bestD) { bestD = d; brk = i; }
    }
    f.koBrk = brk;
    f.koWave = Float32Array.from({ length: N }, (_, i) => Math.abs(i - brk) / N);   // 0 at the break, further along the chain after
    f.koLoose = new Float32Array(N);
    f.koBurst = false;
  }
  function letGo(f) {
    const c = f.coords, N = f.form.n;
    let cx = 0, cy = 0, cz = 0;
    for (const q of c) { cx += q[0] / N; cy += q[1] / N; cz += q[2] / N; }
    for (let i = 0; i < N; i++) {
      const q = c[i], dx = q[0] - cx, dy = q[1] - cy, dz = q[2] - cz, l = Math.hypot(dx, dy, dz) || 1;
      const s = 3.5 / Math.sqrt(l / 10 + 1);
      f.prev[i][0] -= dx / l * s; f.prev[i][1] -= dy / l * s + 1; f.prev[i][2] -= dz / l * s;   // verlet: velocity is position minus previous
    }
  }

  function stepKO(dt) {
    koTimer += dt;
    for (const f of fighters) {
      f.t += dt;
      physics(f, dt);   // a finishing blow still carries the loser
      f.dents = f.dents.filter(hit => (hit.t += dt) < DENT_LIFE);
      if (f.hp === 0 && f.koWave) {
        if (koTimer > COLLAPSE && !f.koBurst) { f.koBurst = true; letGo(f); }
        const front = (koTimer - COLLAPSE) / UNFOLD;   // how far the wave has run, in chain lengths
        for (let i = 0; i < f.form.n; i++) {
          f.unfold[i] = Math.min(1, f.unfold[i] + dt * 0.55);
          f.koLoose[i] = clamp01((front - f.koWave[i]) * 2.5);
        }
      }
      if (f.hp > 0) {   // the one still standing lets its guard down and rests
        f.stun = Math.max(0, f.stun - dt);
        if (!MOVES[f.action] || f.t >= MOVES[f.action].duration) f.action = 'rest';
        f.crouch = false; f.squat = 0; f.queued = null; f.buffered = null;
      }
      f.coords = body(f, clock);
    }
    if (net.guest) return;   // the word and the round's end come from the host
    // Once the loser has dropped into its heap, the word.
    if (phase === 'ko' && !finished && koTimer > COLLAPSE + 0.1 && fighters.some(f => f.hp === 0)) { finished = true; finisher('DENATURED'); }
    if (phase === 'ko' && koTimer > KO_HOLD) endRound();
  }

  // ------------------------------------------------------------------------ HUD
  function flash(at, text) {
    netEvent('flash', at[0], text);
    const el = $('impact');
    el.textContent = text;
    el.style.left = 50 + at[0] * 0.28 + '%';
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }
  const announce = text => flash([0, 0, 0], text);
  // A small number floating up from the impact, and past two hits the combo's count.
  function damageNumber(at, dmg, combo) {
    const box = $('nums'), { project } = view(), [X, Y] = project(at[0], at[1], at[2]);
    const el = document.createElement('span');
    el.className = 'num'; el.textContent = `-${dmg}`;
    el.style.left = X + 'px'; el.style.top = Y + 'px';
    box.appendChild(el); setTimeout(() => el.remove(), 900);
    if (combo >= 2) {
      const c = document.createElement('span');
      c.className = 'num combo'; c.textContent = `${combo} HITS`;
      c.style.left = X + 'px'; c.style.top = (Y - 28) + 'px';
      box.appendChild(c); setTimeout(() => c.remove(), 1100);
    }
  }
  // The finisher, Mortal Kombat style: the word slams in a letter at a time over the
  // collapsing loser, the arena shakes, and the announcer growls it.
  function finisher(text, silent = false) {
    netEvent('finish', text);
    const el = $('finish');
    el.innerHTML = '';
    [...text].forEach((ch, i) => {
      const s = document.createElement('span');
      s.textContent = ch; s.style.animationDelay = (i * 0.075) + 's';
      el.appendChild(s);
    });
    el.hidden = false; el.classList.remove('settle');
    setTimeout(() => el.classList.add('settle'), text.length * 75 + 350);
    const arena = document.querySelector('.arena');
    arena.classList.remove('shake'); void arena.offsetWidth; arena.classList.add('shake');
    if (!silent) sfx.denatured();
  }
  const clearFinisher = () => { const el = $('finish'); el.hidden = true; el.innerHTML = ''; el.classList.remove('settle'); };

  // The health bar is the average pLDDT, in the same AlphaFold bands as the protein.
  const bandColor = plddt => plddt >= 90 ? '#0d57d3' : plddt >= 70 ? '#6acbf1' : plddt >= 50 ? '#fed936' : '#fd7d4d';

  // ------------------------------------------------------------------------ PAE
  // A predicted aligned error map for each fighter, computed the way AlphaFold defines
  // the error it predicts: superpose the structure on residue i, then measure how far
  // residue j sits from where it belongs. AlphaFold aligns on each residue's backbone
  // frame (N, CA, C); a C-alpha trace has only the alpha carbons, so residue i's frame is
  // built from CA i-1, i and i+1, with its origin on i. Where j belongs is where it sat
  // in i's frame at the bell, so cell (i, j) is
  //     | R_i (x_j - o_i)  -  R0_i (x0_j - o0_i) |
  // with R, o residue i's frame now and R0, o0 its frame at the start of the round.
  // Moving the whole protein changes nothing; an arm swinging lights up arm against body
  // and body against arm; a stretch that unfolds scrambles its own frames, so its rows go
  // white against everything. Every residue against every residue, averaged four by four
  // into a map a pixel per PAE_BIN residues each way: the row is the residue aligned on,
  // the column the one scored.
  const PAE_MAX = 30;
  // Residue i's frame, twelve numbers: the origin, then three orthonormal axes.
  function localFrames(coords, F) {
    const N = coords.length;
    for (let i = 0; i < N; i++) {
      const c = Math.min(N - 2, Math.max(1, i));   // the two chain ends borrow their neighbour's frame
      const a = coords[c - 1], o = coords[c], b = coords[c + 1];
      let x1 = b[0] - o[0], y1 = b[1] - o[1], z1 = b[2] - o[2];
      let l = Math.hypot(x1, y1, z1) || 1; x1 /= l; y1 /= l; z1 /= l;
      let x2 = a[0] - o[0], y2 = a[1] - o[1], z2 = a[2] - o[2];
      const d = x2 * x1 + y2 * y1 + z2 * z1; x2 -= d * x1; y2 -= d * y1; z2 -= d * z1;
      l = Math.hypot(x2, y2, z2) || 1; x2 /= l; y2 /= l; z2 /= l;
      const k = i * 12;
      F[k] = o[0]; F[k + 1] = o[1]; F[k + 2] = o[2];
      F[k + 3] = x1; F[k + 4] = y1; F[k + 5] = z1;
      F[k + 6] = x2; F[k + 7] = y2; F[k + 8] = z2;
      F[k + 9] = y1 * z2 - z1 * y2; F[k + 10] = z1 * x2 - x1 * z2; F[k + 11] = x1 * y2 - y1 * x2;
    }
    return F;
  }
  // Every residue's position in every sampled residue's frame, rows x N x 3, into L.
  function localPositions(coords, stride = 1, L, F0) {
    const N = coords.length, F = localFrames(coords, F0 || new Float64Array(N * 12)), rows = Math.ceil(N / stride);
    L = L || new Float32Array(rows * N * 3);
    for (let r = 0; r < rows; r++) {
      const i = r * stride, k = i * 12;
      for (let j = 0, m = r * N * 3; j < N; j++, m += 3) {
        const q = coords[j], vx = q[0] - F[k], vy = q[1] - F[k + 1], vz = q[2] - F[k + 2];
        L[m] = F[k + 3] * vx + F[k + 4] * vy + F[k + 5] * vz;
        L[m + 1] = F[k + 6] * vx + F[k + 7] * vy + F[k + 8] * vz;
        L[m + 2] = F[k + 9] * vx + F[k + 10] * vy + F[k + 11] * vz;
      }
    }
    return L;
  }
  const LDDT_EASE = 0.3;   // per update: about a third of the way each time, a few updates to settle
  function updatePAE(f) {
    if (!f.paeLocal) return;
    const { n: N, pb: PB, paeBin, stride, paeCount: PAE_COUNT, paeSum, paeFrames, paeBase } = f.form;
    // The reference is the body's undamaged pose this frame: a limb that swung, a loop
    // that bent with it, score nothing; what a blow moved off the pose is the error.
    const P = f.coords, F = localFrames(P, paeFrames), L = localPositions(f.poseRef || P, stride, f.paeLocal, f.form.refFrames);
    paeSum.fill(0);
    for (let i = 0, r = 0; i < N; i += stride, r++) {
      const k = i * 12, row = (i / paeBin | 0) * PB;
      const ox = F[k], oy = F[k + 1], oz = F[k + 2];
      const ax = F[k + 3], ay = F[k + 4], az = F[k + 5];
      const bx = F[k + 6], by = F[k + 7], bz = F[k + 8];
      const cx = F[k + 9], cy = F[k + 10], cz = F[k + 11];
      for (let j = 0, m = r * N * 3; j < N; j++, m += 3) {
        const q = P[j], vx = q[0] - ox, vy = q[1] - oy, vz = q[2] - oz;
        const dx = ax * vx + ay * vy + az * vz - L[m];
        const dy = bx * vx + by * vy + bz * vz - L[m + 1];
        const dz = cx * vx + cy * vy + cz * vz - L[m + 2];
        paeSum[row + (j / paeBin | 0)] += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
    }
    for (let b = 0; b < PB * PB; b++) {
      const live = PAE_COUNT[b] ? paeSum[b] / PAE_COUNT[b] : 0;   // a pixel no sampled row falls in (the last, on a big protein) shows the model's own error alone
      const e = Math.min(PAE_MAX, Math.max(live, paeBase ? paeBase[b] : 0));   // the model's own error is the floor
      f.pae[b] = f.pae[b] * 0.5 + e * 0.5;   // barely smoothed, so one frame's twitch does not flicker
    }
    // ...and the lDDT on the same cadence: what each residue's surroundings within its
    // rigid part still measure as they did at the bell, and from it the pLDDT shown.
    if (f.pairs) {
      // Scored raw, then smoothed two ways so the colours do not flicker: along the
      // chain (1-2-1 over a residue and its bonded neighbours, never across a break),
      // since a residue in a few pairs steps in quarters as one pair crosses a
      // threshold; and over time, each residue's shown score easing toward the raw one.
      const raw = f.lddtRaw || (f.lddtRaw = new Float32Array(N)), sm = f.lddtSmooth || (f.lddtSmooth = new Float32Array(N)), BREAK = f.form.breakAt;
      window.LDDT.score(f.pairs, P, raw, f.poseRef);
      for (let i = 0; i < N; i++) {
        let v = 2 * raw[i], w = 2;
        if (i > 0 && !BREAK[i - 1]) { v += raw[i - 1]; w++; }
        if (i < N - 1 && !BREAK[i]) { v += raw[i + 1]; w++; }
        sm[i] = v / w;
      }
      for (let i = 0; i < N; i++) f.lddt[i] += (sm[i] - f.lddt[i]) * LDDT_EASE;
      // A residue the model itself had loose (low pLDDT) hangs off the pose by nature,
      // which its base already says: it shows its base, and only a folded residue is
      // marked down by what has come away from the pose. A body still gathering itself
      // up at a round's start (f.settle, held loosely in body()) is not damaged either,
      // so what it lags the pose by while it gathers is excused the same way.
      const base = f.basePlddt, u0 = f.initUnfold, gather = 0.96 * Math.sqrt(f.settle || 0);
      for (let i = 0; i < N; i++) { const loose = Math.max(gather, u0 ? u0[i] : 0); f.shown[i] = (base ? base[i] : 100) * (f.lddt[i] * (1 - loose) + loose); }
    }
  }
  function drawPAE(f, i) {
    const canvas = $('pae' + i), PB = f.form.pb;
    if (!canvas || !f.pae) return;
    if (canvas.width !== PB) canvas.width = canvas.height = PB;   // a pixel per PAE_BIN residues, whatever the protein's length
    const g = canvas.getContext('2d'), img = g.createImageData(PB, PB), px = img.data;
    for (let k = 0; k < PB * PB; k++) {
      const t = f.pae[k] / PAE_MAX, o = k * 4;   // dark green (confident) → white
      px[o] = 30 + 225 * t; px[o + 1] = 110 + 145 * t; px[o + 2] = 50 + 205 * t; px[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }

  // A click on a PAE map picks out the residues that pixel scores: the row's residues
  // (aligned on) and the column's (measured), lit on the body for a moment.
  let unpick = 0;
  function pickPAE(i, e) {
    const f = fighters[i], canvas = $('pae' + i), r = canvas.getBoundingClientRect();
    const bx = Math.floor((e.clientX - r.left) / r.width * f.form.pb), by = Math.floor((e.clientY - r.top) / r.height * f.form.pb);
    const base = i ? fighters[0].form.n : 0, idx = [];
    const B = f.form.paeBin;
    for (const bin of [by, bx]) for (let k = bin * B; k < Math.min(f.form.n, (bin + 1) * B); k++) idx.push(base + k);
    try { viewer.select(idx); } catch (err) { console.warn('selection', err); return; }
    clearTimeout(unpick); unpick = setTimeout(() => { try { viewer.unselect(idx); } catch {} }, 1500);
    const err = f.pae[by * f.form.pb + bx];
    flash([f.x, 0, 0], `${by * B + 1}–${Math.min(f.form.n, by * B + B)} on ${bx * B + 1}–${Math.min(f.form.n, bx * B + B)}: ${err.toFixed(0)} Å`);
  }
  for (const i of [0, 1]) { const c = $('pae' + i); c.style.pointerEvents = 'auto'; c.style.cursor = 'crosshair'; c.onclick = e => pickPAE(i, e); }

  // Only what changed is written, so the page isn't restyled every frame for nothing.
  const shown = {};
  const setText = (id, v) => { if (shown[id] !== v) { shown[id] = v; $(id).textContent = v; } };
  const setStyle = (id, k, v) => { if (shown[id + k] !== v) { shown[id + k] = v; $(id).style[k] = v; } };
  function hud() {
    fighters.forEach((f, i) => {
      let plddt = 0; for (let k = 0; k < f.shown.length; k++) plddt += f.shown[k]; plddt /= f.shown.length;
      setStyle('hp' + i, 'width', f.hp + '%');
      setStyle('hp' + i, 'background', bandColor(plddt));
      setText('fold' + i, `pLDDT ${Math.round(plddt)}`);
      // The special meter: the cooldown coming back, full and lit when the special is ready.
      const spMove = SPECIAL[f.form.name] || 'spin';
      const again = MOVES[spMove]?.again || 4, charge = clamp01((clock - f.specialAt) / again);
      setStyle('sp' + i, 'width', Math.round(charge * 100) + '%');
      const meter = $('meter' + i); if (meter.classList.contains('ready') !== (charge >= 1)) meter.classList.toggle('ready', charge >= 1);
      setText('wins' + i, [0, 1].map(n => (wins[i] > n ? '●' : '○')).join(' '));
    });
    const nm = names(); setText('name0', nm[0]); setText('name1', nm[1]);
    if ($('p2pad').hidden !== (mode !== 2)) $('p2pad').hidden = mode !== 2;
    setText('timer', String(Math.ceil(time)).padStart(2, '0'));
    setText('round', 'ROUND ' + String(Math.min(round, 3)).padStart(2, '0'));
  }

  // ---------------------------------------------------------------------- sound
  // Synthesised, nothing to download: noise bursts and falling tones through a short
  // reverb and a compressor, so hits land heavy. On by default; browsers start the
  // audio at the first click or key press.
  let audio, bus, noiseBuf, sound = true;
  function out() {
    if (!sound) return null;
    try {
      if (!audio) {
        audio = new AudioContext();
        const comp = audio.createDynamicsCompressor();
        comp.threshold.value = -18; comp.ratio.value = 6;
        const len = audio.sampleRate * 1.4, ir = audio.createBuffer(2, len, audio.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
          const d = ir.getChannelData(ch);
          for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
        }
        const verb = audio.createConvolver(), wet = audio.createGain();
        verb.buffer = ir; wet.gain.value = 0.25;
        bus = audio.createGain(); bus.gain.value = 0.9;
        bus.connect(comp); bus.connect(verb).connect(wet).connect(comp);
        comp.connect(audio.destination);
      }
      if (audio.state === 'suspended') audio.resume();
      return audio;
    } catch { return null; }
  }
  function tone(freq, to, dur, { type = 'sine', gain = 0.3, delay = 0, dest = null } = {}) {
    const a = out(); if (!a || !(gain > 1e-4)) return;   // a silent voice is no voice: a ramp to zero throws
    dest = dest || bus;   // the bus exists once out() has run, which may be only now (a guest hears sounds before it has touched anything)
    const t = a.currentTime + delay, o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest); o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, from, to, { gain = 0.3, filter = 'lowpass', delay = 0, dest = null } = {}) {
    const a = out(); if (!a || !(gain > 1e-4)) return;
    dest = dest || bus;
    if (!noiseBuf) {   // one shared two seconds of noise, each burst starting somewhere in it
      noiseBuf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = a.currentTime + delay;
    const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = noiseBuf; f.type = filter;
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest); src.start(t, Math.random() * Math.max(0, 1.95 - dur)); src.stop(t + dur + 0.02);
  }

  // Battle music: a driving theme in D minor, synthesised like the effects and scheduled
  // a little ahead on the audio clock. Drums, a galloping bass and string chords under
  // Dm–B♭–F–C; every other four bars a brass-like lead comes in over the top.
  // The theme, in the spirit of an arcade fighter's techno: a driving four-on-the-floor
  // with a clap, open hats off the beat, a sawtooth bass hammering sixteenths on the root
  // with octave jumps, orchestral-hit stabs on the downbeats, and an arpeggiated riff in
  // A minor over the second half of the loop. i - VI - VII - i, sixteen bars.
  const BPM = 132, STEP16 = 60 / BPM / 4;
  const CHORDS = [[45, 48, 52], [41, 45, 48], [43, 47, 50], [45, 48, 52]];   // Am F G Am
  // The riff: sixteen steps a bar (0 = rest), transposed to each bar's chord root.
  const RIFF = [
    [12, 0, 12, 15, 12, 0, 19, 0, 12, 0, 15, 0, 17, 15, 12, 0],
    [12, 0, 12, 15, 12, 0, 19, 0, 24, 0, 22, 19, 17, 0, 15, 0],
  ];
  // The bass line: which sixteenths sound, and the octave (0 root, 1 up) on each.
  const BASS = [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0].map((up, i) => ({ on: i % 4 !== 3 || i === 7 || i === 15, up }));
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  let musicBus = null, musicTimer = 0, musicStep = 0, musicAt = 0;
  function voice(m, t, dur, { type = 'sawtooth', gain = 0.1, cutoff = 1800, attack = 0.01, detune = 0 } = {}) {
    if (!(gain > 1e-4)) return;
    const o = audio.createOscillator(), lp = audio.createBiquadFilter(), g = audio.createGain();
    o.type = type; o.frequency.value = mtof(m); o.detune.value = detune;
    lp.type = 'lowpass'; lp.frequency.value = cutoff;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(gain * 0.6, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(g).connect(musicBus); o.start(t); o.stop(t + dur + 0.05);
  }
  // An orchestral hit: the chord slammed in three octaves through a fast decay, with a
  // burst of noise on the front.
  function stab(chord, t, gain = 1) {
    for (const n of chord) for (const [oct, g, cut] of [[-12, 0.16, 900], [0, 0.11, 2600], [12, 0.05, 5000]])
      voice(n + oct, t, 0.22, { type: 'sawtooth', gain: g * gain, cutoff: cut, attack: 0.004, detune: (oct + 12) * 0.4 - 4 });
    noise(0.14, 5000, 700, { gain: 0.35 * gain, delay: t - audio.currentTime, dest: musicBus });
  }
  function bar16(i, t) {
    const bar = Math.floor(i / 16) % 16, s = i % 16, chord = CHORDS[bar % 4], root = chord[0];
    const at = { delay: t - audio.currentTime, dest: musicBus };
    const drop = bar === 7 || bar === 15;   // a bar before the top: the drums drop out for the fill
    if (s % 4 === 0 && !(drop && s >= 8)) tone(150, 40, 0.28, { gain: 0.95, ...at });   // kick, four on the floor
    if ((s === 4 || s === 12) && !drop) { noise(0.16, 6000, 1500, { gain: 0.5, ...at }); noise(0.05, 3000, 2500, { gain: 0.3, delay: at.delay + 0.012, dest: musicBus }); }   // clap
    if (s % 4 === 2) noise(0.12, 9000, 7000, { gain: 0.1, filter: 'highpass', ...at });   // open hat off the beat
    else if (s % 2 === 0) noise(0.03, 9000, 6000, { gain: 0.05, filter: 'highpass', ...at });
    if (drop && s >= 8 && s % 2 === 0) tone(220 - (s - 8) * 18, 70, 0.18, { gain: 0.55, ...at });   // the tom fill
    if (bar % 8 === 0 && s === 0) noise(1.4, 9000, 2500, { gain: 0.22, filter: 'highpass', ...at });   // crash on the top
    const bs = BASS[s];
    if (bs.on) voice(root - 12 + 12 * bs.up, t, STEP16 * 0.9, { gain: 0.2, cutoff: 500 + 700 * bs.up, attack: 0.004 });   // the ostinato
    if (s === 0 || (bar % 2 === 1 && s === 6)) stab(chord, t, s === 0 ? 1 : 0.7);   // the hits
    if (s === 0) for (const n of chord) for (const detune of [-7, 7])   // a pad under it
      voice(n + 12, t, STEP16 * 15, { gain: 0.025, cutoff: 1800, attack: 0.1, detune });
    if (bar >= 8 && bar < 15) {   // the riff, over the second half of the loop
      const n = RIFF[(bar >> 1) & 1][s];
      if (n) {
        const next = RIFF[(bar >> 1) & 1][(s + 1) % 16], dur = STEP16 * (next ? 1 : 2) * 0.9;
        voice(root + 12 + n, t, dur, { gain: 0.07, cutoff: 3200, type: 'square', attack: 0.005 });
        voice(root + n, t, dur, { gain: 0.045, cutoff: 2200, detune: 6 });
      }
    }
  }
  // Starts the theme, or brings it back up to full; `duckMusic` lowers it between rounds.
  function startMusic() {
    if (!out()) return;
    if (!musicBus) { musicBus = audio.createGain(); musicBus.gain.value = 0; musicBus.connect(bus); }
    musicBus.gain.setTargetAtTime(0.3, audio.currentTime, 0.3);
    if (musicTimer) return;
    musicAt = audio.currentTime + 0.1;
    musicTimer = setInterval(() => {
      if (musicAt < audio.currentTime) musicAt = audio.currentTime + 0.05;   // after the tab slept, pick up from now
      while (musicAt < audio.currentTime + 0.2) { bar16(musicStep++, musicAt); musicAt += STEP16; }
    }, 50);
  }
  function stopMusic() { clearInterval(musicTimer); musicTimer = 0; }
  const duckMusic = level => { if (musicBus) musicBus.gain.setTargetAtTime(level, audio.currentTime, 0.5); };
  const sfx = {
    hit(p) {   // p: 0 light … 1+ heavy
      tone(140, 38, 0.28, { gain: 0.5 * p + 0.2 });
      noise(0.18, 3000, 200, { gain: 0.45 * p + 0.15 });
      tone(900, 180, 0.07, { type: 'square', gain: 0.08 });
    },
    block() { tone(1500, 900, 0.09, { type: 'triangle', gain: 0.18 }); noise(0.05, 4000, 2000, { gain: 0.12, filter: 'highpass' }); },
    whiff() { noise(0.12, 700, 2400, { gain: 0.06, filter: 'bandpass' }); },
    swing(kind) { kind === 'punch' ? noise(0.11, 2200, 600, { gain: 0.05, filter: 'bandpass' }) : noise(0.2, 1100, 260, { gain: 0.08, filter: 'bandpass' }); },
    jump() { noise(0.16, 300, 1400, { gain: 0.07, filter: 'bandpass' }); },
    land(p) { tone(110, 35, 0.14, { gain: 0.35 * p }); noise(0.1, 600, 120, { gain: 0.15 * p }); },
    round() {   // a rising sting, then a boom on FIGHT
      [220, 277, 330, 440].forEach((f, i) => tone(f, f * 0.98, 0.35, { type: 'sawtooth', gain: 0.07, delay: i * 0.09 }));
      tone(55, 40, 0.9, { gain: 0.35, delay: 0.36 });
      noise(0.5, 5000, 300, { gain: 0.2, delay: 0.36 });
    },
    grab() { noise(0.12, 800, 3000, { gain: 0.2, filter: 'bandpass' }); tone(300, 90, 0.18, { type: 'triangle', gain: 0.15 }); },
    shock() { tone(80, 400, 0.5, { type: 'sawtooth', gain: 0.2 }); noise(0.6, 200, 2500, { gain: 0.25, filter: 'bandpass' }); tone(45, 30, 0.7, { gain: 0.4 }); },
    roll() {   // a rumble along the membrane, two thumps as it turns over
      noise(0.75, 90, 400, { gain: 0.3, filter: 'bandpass', delay: 0.1 });
      for (const d of [0.15, 0.42]) { tone(70, 30, 0.22, { gain: 0.5, delay: d }); noise(0.08, 600, 150, { gain: 0.2, delay: d }); }
    },
    spin() { for (let i = 0; i < 4; i++) noise(0.14, 400, 2200, { gain: 0.16, filter: 'bandpass', delay: i * 0.15 }); tone(180, 320, 0.6, { type: 'triangle', gain: 0.1 }); },
    denatured() {   // the announcer: three low, rough syllables, DE-NA-TURED, and a hit under the last
      for (const [f0, f1, dur, delay, g] of [[112, 84, 0.22, 0, 0.5], [100, 78, 0.22, 0.26, 0.5], [92, 46, 0.7, 0.52, 0.6]]) {
        tone(f0, f1, dur, { type: 'sawtooth', gain: g * 0.55, delay });
        tone(f0 * 1.5, f1 * 1.5, dur, { type: 'square', gain: g * 0.12, delay });
        tone(f0 / 2, f1 / 2, dur, { gain: g * 0.7, delay });
        noise(dur, 900, 250, { gain: g * 0.25, filter: 'bandpass', delay });
      }
      tone(50, 30, 1.2, { gain: 0.6, delay: 0.55 });
      noise(0.6, 2500, 120, { gain: 0.35, delay: 0.55 });
    },
    ko() {     // a long collapse, and a second impact as it hits the floor
      tone(260, 28, 1.4, { type: 'sawtooth', gain: 0.18 });
      tone(60, 25, 1.8, { gain: 0.5 });
      noise(1.2, 1500, 60, { gain: 0.35 });
      noise(0.5, 3000, 200, { gain: 0.3, delay: 0.45 });
      tone(90, 30, 0.8, { gain: 0.4, delay: 0.45 });
    },
  };

  for (const k of Object.keys(sfx)) { const fn = sfx[k]; sfx[k] = (...a) => { fn(...a); netEvent('sfx', k, ...a); }; }

  // ---------------------------------------------------------------------- input
  // One keyboard, two players, as Street Fighter on a PC: P1 on the left hand side,
  // P2 on the right. Playing the CPU, every key drives P1, and J/K punch and kick too.
  const BINDINGS = [
    { w: 'up', a: 'left', s: 'down', d: 'right', f: 'punch', g: 'kick', h: 'block' },
    { arrowup: 'up', arrowleft: 'left', arrowdown: 'down', arrowright: 'right', '.': 'punch', '/': 'kick', ',': 'block', 1: 'punch', 2: 'kick', 3: 'block' },
  ];
  const SOLO = { j: 'punch', k: 'kick', l: 'block' };
  function route(k) {
    if (BINDINGS[0][k]) return [0, BINDINGS[0][k]];
    if (mode !== 2 && SOLO[k]) return [0, SOLO[k]];
    if (BINDINGS[1][k]) return [mode === 2 ? 1 : 0, BINDINGS[1][k]];
    return null;
  }

  // Buttons pressed together are read together: an attack pressed with or just after
  // up waits for take-off and comes out in the air, and one pressed a moment before up
  // is cancelled into the jump. So up + forward + kick is a jump kick in whatever
  // order the fingers land. J/K (or F/G) crouching are low attacks.
  // An attack pressed while the fighter cannot act (reeling from a blow, braced behind a
  // block, still recovering from its own move, or held in the hit freeze) is kept for a
  // moment and comes out as soon as it is free, as a fighting game's input buffer has
  // it, so a press timed a little early is not thrown away. It is read then, with the
  // directions held then: forward makes it a straight or roundhouse, down a low attack.
  const BUFFER = 0.3, HOLD = 0.5, CANCEL = 0.12;   // the jump buffer, the attack buffer (a kick's recovery is 0.4), the cancel window
  const canAct = f => f.stun <= 0 && f.blockStun <= 0 && f.cooldown <= 0 && !MOVES[f.action] && f.action !== 'thrown' && hitstop <= 0;
  function strike(i, kind, fromBuffer = false) {
    const f = fighters[i], h = held[i];
    if (f.y === 0 && (h.has('up') || f.squat > 0)) { f.queued = { move: 'air' + kind, until: clock + BUFFER }; return true; }
    // The other attack key within a twelfth of a second of the first: the heat shock.
    if (f.y === 0 && MOVES[f.action] && !MOVES[f.action].wave && f.t < 0.09 && (f.action.endsWith(kind === 'punch' ? 'kick' : 'punch') || f.action === (kind === 'punch' ? 'roundhouse' : 'straight'))) return attack(f, SPECIAL[f.form.name]);
    if (!canAct(f)) { if (!fromBuffer) f.buffered = { kind, until: clock + HOLD }; return false; }
    const o = fighters[1 - i], forward = f.facing > 0 ? 'right' : 'left';
    if (THROWS && kind === 'punch' && f.y === 0 && !h.has('down') && h.has(forward) && o.y === 0 && barrelGap(f, o) < GRAB) return attack(f, 'throw');
    if (f.y === 0 && !h.has('down') && h.has(forward)) return attack(f, kind === 'punch' ? 'straight' : 'roundhouse');
    return attack(f, f.y > 0 ? 'air' + kind : h.has('down') ? 'low' + kind : kind);
  }
  // The buffered press, tried each tick until it comes out or goes stale.
  function flushBuffered() {
    fighters.forEach((f, i) => {
      if (!f.buffered) return;
      if (clock > f.buffered.until) { f.buffered = null; return; }
      if (net.guest && i === 0) return;
      if (strike(i, f.buffered.kind, true)) f.buffered = null;
    });
  }
  function jumpCancel(i) {
    const f = fighters[i], m = MOVES[f.action];
    if (!m || m.air || f.y > 0 || f.t > Math.max(CANCEL, m.active) || f.hit) return;   // any time before it comes out
    f.queued = { move: 'air' + (f.action.endsWith('punch') ? 'punch' : 'kick'), until: clock + BUFFER };
    f.action = 'idle'; f.t = 0; f.cooldown = 0;
  }

  function press(k) {
    if (net.guest) return guestPress(k);   // acts here at once, and tells the host
    if (k === 'escape') {
      if (phase === 'playing') {
        phase = 'paused';
        for (const h of held) h.clear();
        overlay('PAUSED', '', 'RESUME');
        duckMusic(0.08);
        if (net.link) sendState();
      }
      else if (phase === 'paused') start();
      return;
    }
    if (phase !== 'playing') {
      if (k === ' ' || k === 'enter') start(phase === 'over' && !wins.includes(2) ? undefined : mode);
      return;
    }
    const r = route(k);
    if (!r) return;
    const [i, act] = r;
    if (act === 'punch' || act === 'kick') return strike(i, act);
    if (act === 'up') jumpCancel(i);
    held[i].add(act);
  }

  // The on-screen keycaps light up with the keyboard and double as touch controls.
  const light = (k, on) => { for (const el of document.querySelectorAll(`[data-key="${CSS.escape(k)}"]`)) el.classList.toggle('down', on); };
  function release(k) {
    light(k, false);
    const r = route(k);
    if (!r) return;
    const i = net.guest ? 1 : r[0];
    if (net.guest && r[1] !== 'punch' && r[1] !== 'kick') net.send?.({ t: 'in', d: 0, a: r[1] });
    held[i].delete(r[1]);
    if (r[1] === 'up' && fighters) fighters[i].upReleased = true;   // a tap is a short hop
  }
  const keyName = e => e.key.toLowerCase();
  addEventListener('keydown', e => {
    const k = keyName(e);
    if (!route(k) && !['escape', ' ', 'enter'].includes(k)) return;
    e.preventDefault();
    light(k, true);
    if (!e.repeat) press(k);
  });
  addEventListener('keyup', e => release(keyName(e)));
  addEventListener('blur', () => {
    for (const h of held) h.clear();
    for (const el of document.querySelectorAll('.cap.down')) el.classList.remove('down');
    if (phase === 'playing' && !net.guest) press('escape');
  });
  for (const b of document.querySelectorAll('[data-key]')) {
    b.onpointerdown = e => { e.preventDefault(); light(b.dataset.key, true); press(b.dataset.key); };
    b.onpointerup = b.onpointercancel = b.onpointerleave = () => release(b.dataset.key);
  }
  // A guest's RESUME asks the host, whose fight it is; the state comes back.
  $('go').onclick = () => { if (net.guest) { if (phase === 'paused') net.send?.({ t: 'in', a: 'escape' }); return; } start(); };
  $('one').onclick = () => start(mode);
  // The protein picks: each is a two-way switch; a change on the title screen swaps the
  // body at once, mid-match it takes effect at the next round.
  function showPicks() {
    for (const b of document.querySelectorAll('[data-pick]')) {
      const [i, form] = b.dataset.pick.split(':');
      b.classList.toggle('on', pick[+i] === form);
    }
  }
  for (const b of document.querySelectorAll('[data-pick]')) {
    b.onclick = () => {
      const [i, form] = b.dataset.pick.split(':');
      if (net.guest && +i !== 1) return;
      if (form.startsWith('custom') && (!FORMS[form] || pick[+i] === form)) { if (!net.guest || +i === 1) openCustomModal(+i); return; }   // none yet, or the one fought as clicked again: choose another
      pick[+i] = form; showPicks();
      if (net.guest) { net.send?.({ t: 'pick', form }); return; }
      if (phase === 'ready') { resetRound(); fighters[+i].warmNext = 0.2; }   // the new fighter shows what it has
    };
  }

  // ------------------------------------------------------------- custom proteins
  // Any structure as P2 (Ian Anderson's addition): a file dropped or browsed, one of the
  // presets, or a model fetched from the AlphaFold DB by UniProt accession, read and
  // rigged by custom_pdb.js. What it found is shown before the fight is accepted.
  let pendingCustom = null, customFor = 1;   // the last analysed structure, and which player it is for
  const customSpec = [null, null];             // what each player fights as, for a guest joining
  function openCustomModal(player = 1) {
    customFor = player;
    $('btn-load-custom').textContent = `FIGHT AS P${player + 1}`;
    $('custom-modal').hidden = false;
    $('custom-status').hidden = !pendingCustom;
    $('btn-load-custom').disabled = !pendingCustom;
    showPreview(pendingCustom);
  }
  function closeCustomModal() { $('custom-modal').hidden = true; }
  // The fighter as it will stand, in a viewer of its own in the card: the built body
  // (limbs grown, legs on the floor) with the model's own pLDDT, in the game's colours,
  // turning slowly until dragged. One viewer, made the first time and reloaded after.
  let preview = null;
  function previewText(res) {
    const breaks = new Set(res.rigData.chain_breaks || []), pl = res.rigData.base_plddt || [];
    let s = '', num = 0;
    res.rigData.ca_xyz.forEach((q, i) => {
      num++;
      s += `ATOM  ${String(i + 1).padStart(5)}  CA  GLY A${String(num).padStart(4)}    ` + q.map(v => v.toFixed(3).padStart(8)).join('') + `  1.00${(pl[i] ?? 90).toFixed(2).padStart(6)}           C\n`;
      if (breaks.has(i)) num++;
    });
    return s + 'TER\nEND\n';
  }
  function showPreview(res) {
    const el = $('custom-preview');
    if (!res) { el.hidden = true; return; }
    el.hidden = false;
    const text = previewText(res), mode = { rainbow: 'rainbow', ss: 'ss' }[colour] || 'deepmind';
    try {
      if (!preview) {
        // Drawn at one device pixel per CSS pixel and with a coarse cartoon: it is a
        // small picture that turns, and the pixel ratio is read once when the viewer
        // is made (parts/viewport.js), so the arena's own is not touched.
        const style = theme === 'dark' ? '3d' : 'richardson', presetWidth = window.py2dmolCartoon?.LOOK_DEFAULTS?.[style]?.width ?? 3;
        const dpr = window.canvasDPR; window.canvasDPR = 1;
        try {
          preview = window.py2Dmol.show(el, text, { name: 'preview', style, orient: false, controls: false, play: false, select: false, box: false, biounit: false, display: { rotate: true },
            rendering: { width: presetWidth * RIBBON_WIDTH, ortho: 0.4, detail: 2 } });
        } finally { if (dpr === undefined) delete window.canvasDPR; else window.canvasDPR = dpr; }
        preview.setClearColor(true);
      } else preview.load(text, 'preview', false, { biounit: false });
      preview.setColor(mode);
      // Fitted to its arm span it stands small in the box: a little closer, and the
      // fingertips may leave the frame as it turns. A zoom, so a drag's own zoom stands.
      preview.viewerState.zoom = 1.35; preview.render?.();
    } catch (e) { console.warn('preview', e); el.hidden = true; }
  }
  const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  // One line: what it is, what it has, what it does.
  function describeCustom(res) {
    return `<strong>${esc(res.name)}</strong> · ${res.residues} residues · ${res.hasPlddt ? `pLDDT ${res.meanPlddt}` : 'no pLDDT in the file'} · <strong>${esc(res.special.title)}</strong>`;
  }
  function analyseCustom(name, text, extra = {}) {
    const statusEl = $('custom-status');
    statusEl.hidden = false; statusEl.textContent = 'reading…';
    try {
      const res = window.CustomPdb.buildCustomFighter(name, text, { pae: extra.pae || null });
      res.title = extra.title || '';
      pendingCustom = res;
      statusEl.innerHTML = describeCustom(res);
      $('btn-load-custom').disabled = false;
      showPreview(res);
    } catch (err) {
      statusEl.innerHTML = `<span style="color:#e55">${esc(err.message)}</span>`;
      $('btn-load-custom').disabled = true;
      pendingCustom = null;
      showPreview(null);
    }
  }
  // The custom fighter as a form, from what buildCustomFighter returned (or what a guest
  // or host sent over the link: the same object).
  // ...as player i's form, custom0 or custom1: each player may have its own.
  function installCustom(spec, i) {
    const key = 'custom' + i;
    FORMS[key] = makeForm(key, { ...spec.rigData, pae_flat: spec.pae || null });
    FORMS[key].displayName = String(spec.name).toUpperCase();
    SPECIAL[key] = spec.special.special;
    customSpec[i] = spec;
    $('pick-custom-' + i).textContent = String(spec.name).toUpperCase().slice(0, 10);
  }
  const customWire = spec => ({ name: spec.name, rigData: spec.rigData, special: spec.special, pae: spec.pae ? Array.from(spec.pae) : null, roles: spec.roles, legsAdded: spec.legsAdded, residues: spec.residues, hasPlddt: spec.hasPlddt, meanPlddt: spec.meanPlddt });
  $('btn-cancel-custom').onclick = () => closeCustomModal();

  // A few to try, by accession: the presets fill the field and fetch, so they work from
  // any page that reaches the archives, a file opened straight from disk included.
  const PRESETS = { gfp: 'P42212', hba: 'P69905', insulin: 'P01308', ubq: '1UBQ' };   // three from the AlphaFold DB, one from the PDB
  for (const b of document.querySelectorAll('[data-preset]')) b.onclick = () => { $('uniprot-input').value = PRESETS[b.dataset.preset] || b.dataset.preset; $('btn-fetch-af').click(); };
  // A PDB id or a UniProt accession, as py2Dmol's own fetch box takes them (custom_pdb.js).
  $('btn-fetch-af').onclick = async () => {
    const val = $('uniprot-input').value.trim(); if (!val) return;
    const statusEl = $('custom-status'); statusEl.hidden = false; statusEl.textContent = `fetching ${val.toUpperCase()}…`;
    try {
      const got = await window.CustomPdb.fetchStructure(val);
      analyseCustom(got.name, got.text, { pae: got.pae, title: [got.title, got.organism].filter(Boolean).join(', ') });
    } catch (err) { statusEl.innerHTML = `<span style="color:#e55">${esc(err.message)}</span>`; }
  };
  $('uniprot-input').onkeydown = e => { if (e.key === 'Enter') $('btn-fetch-af').click(); };
  // A file, dropped or browsed.
  const readFile = file => {
    if (!file) return;
    const name = file.name.replace(/\.(pdb|ent|cif|mmcif|mcif|txt)$/i, '');
    const reader = new FileReader();
    reader.onload = ev => analyseCustom(name, ev.target.result);
    reader.readAsText(file);
  };
  $('btn-browse').onclick = () => $('file-input').click();
  const dropZone = $('drop-zone');
  dropZone.ondragover = e => { e.preventDefault(); dropZone.classList.add('dragover'); };
  dropZone.ondragleave = () => dropZone.classList.remove('dragover');
  dropZone.ondrop = e => { e.preventDefault(); dropZone.classList.remove('dragover'); readFile(e.dataTransfer.files?.[0]); };
  $('file-input').onchange = e => { readFile(e.target.files?.[0]); e.target.value = ''; };
  // Fight it: installed here, and, over a link, on the other side too.
  $('btn-load-custom').onclick = () => {
    if (!pendingCustom) return;
    const i = net.guest ? 1 : customFor, wire = customWire(pendingCustom);
    installCustom(wire, i);
    pick[i] = 'custom' + i;
    showPicks();
    closeCustomModal();
    if (net.guest) { net.send?.({ t: 'custom', spec: wire }); return; }   // the host installs it, and its reset comes back with the pick
    netEvent('custom', i, wire);
    if (phase === 'ready') { resetRound(); fighters[i].warmNext = 0.2; }
  };
  for (const b of document.querySelectorAll('[data-level]')) {
    b.onclick = () => { level = b.dataset.level; showLevel(); try { localStorage.setItem(LEVEL_KEY, level); } catch {} };
  }
  showLevel();
  for (const b of document.querySelectorAll('[data-players]')) {
    b.onclick = () => {
      mode = +b.dataset.players;
      document.querySelector('.levels').hidden = mode !== 1;
      showPicks();
      for (const o of document.querySelectorAll('[data-players]')) o.classList.toggle('on', o === b);
    };
  }
  $('sound').onclick = () => {
    sound = !sound; $('sound').textContent = sound ? 'SOUND ON' : 'SOUND OFF'; sfx.block();
    if (!sound) stopMusic();
    else if (phase !== 'ready') { startMusic(); if (phase !== 'playing') duckMusic(0.12); }
  };
  for (const b of document.querySelectorAll('[data-colour-choice]')) {
    b.onclick = () => {
      if (b.dataset.colourChoice === colour) return;
      colour = b.dataset.colourChoice;
      try { localStorage.setItem(COLOUR_KEY, colour); } catch {}
      applyColour();
    };
  }
  $('theme').onclick = () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
    applyTheme();
    // py2Dmol paints each style on its own ground, so rebuild the viewer in the new style.
    startViewer(fighters[0].coords, fighters[1].coords);
  };

  // The stage resized: py2Dmol's own observer resizes its canvas and redraws the mesh it
  // already holds, the same frame, as its website does; the game draws once more at once
  // so the camera is pinned to the new shape and the floor and the cell, which follow
  // the stage every frame, never show a different size from the proteins. It used to
  // rebuild the whole viewer 150 ms after the window's resize event, which was the
  // jump: the background at the new size, the proteins at the old, then a flash. A
  // phone turning on its side also fires that event before its layout has settled, and
  // a viewer built from that measure stayed small; the observer reports the size the
  // stage actually ends at. Once a second the canvas is checked against the stage
  // regardless, and only if they disagree is the viewer rebuilt.
  let resizeTimer = null;
  function rebuildSoon() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resizeTimer = null; if (fighters) startViewer(fighters[0].coords, fighters[1].coords); }, 150);
  }
  new ResizeObserver(() => { if (fighters && viewer) draw(); }).observe($('stage'));
  let fitAt = 0;
  function fitStage(now) {
    if (now - fitAt < 1000 || resizeTimer) return;
    fitAt = now;
    const st = $('stage'), cv = st.querySelector('canvas');
    if (cv && (cv.clientWidth !== st.clientWidth || cv.clientHeight !== st.clientHeight)) rebuildSoon();
  }

  // Full screen where the browser offers it (Android, the desktops; iOS has none for a
  // page, and there the home-screen app is the way, see the manifest), on its side.
  if (document.fullscreenEnabled && document.documentElement.requestFullscreen) {
    $('full').hidden = false;
    $('full').onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().then(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
    };
    document.addEventListener('fullscreenchange', () => { $('full').textContent = document.fullscreenElement ? '⛶' : '⛶'; $('full').title = document.fullscreenElement ? 'leave full screen' : 'full screen'; });
  }

  // ----------------------------------------------------------------------- loop
  let last = performance.now(), acc = 0, drawn = 0, drawnAt = 0;   // frames drawn, and when the last was
  // Drawn at most thirty times a second on a touch screen, and anywhere once the bodies
  // are big: py2Dmol's mesh update is the frame's cost and grows with the residues, so
  // two fighters past a thousand residues between them draw at half rate on a desktop too.
  const BIG = 1000;
  let drawHalf = PHONE;
  const DT = 1 / 60;
  let tripped = 0;   // exceptions a step has thrown, reported once
  function frame(now) {
    // Whatever a step throws, the next frame is still asked for: an exception that
    // escaped here stopped the loop for good, which showed as the game freezing.
    try { frameBody(now); } catch (err) { if (!tripped++) console.error('a frame threw', err); }
    requestAnimationFrame(frame);
  }
  function frameBody(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!$('custom-modal').hidden) return;   // the card is up: the arena holds still behind it, and the preview has the frame to itself
    let moved = false;
    // The freeze on a landed blow: the fighters hold, but the picture goes on being
    // drawn, so the sparks fly and the camera's knock plays through the freeze. Drawn
    // as a still it read as the game stalling, worst on the drop kick, the longest one.
    if (hitstop > 0) { hitstop -= dt; frameCamera(dt); moved = true; }
    else if (phase !== 'paused') {
      // Fixed 60 Hz steps whatever the display rate, and a redraw only when something
      // stepped: py2Dmol rebuilds the whole cartoon on every draw, so a 120 Hz screen
      // would otherwise pay for it twice per step.
      // At most three steps a frame (full speed down to 20 fps): a phone that has fallen
      // further behind plays a moment of slow motion rather than posing both bodies six
      // times to catch up, and falling further behind for it.
      acc += dt;
      for (let n = 0; n < 3 && acc >= DT && phase !== 'paused'; n++) {
        clock += DT;
        frameCamera(DT);
        if (phase === 'playing') step(DT);
        else if (phase === 'ko' || phase === 'over') stepKO(DT);   // after the round, the heap keeps settling
        else warmUp(DT);   // behind the menu, the fighters warm up
        acc -= DT; moved = true;
      }
      if (acc >= DT) acc = 0;
    }
    // The cartoon is the cost of a frame (py2Dmol's mesh update, some 12 ms of script on
    // a desktop and three times that on a phone), so on a touch screen it is drawn at
    // most thirty times a second while the fight still steps at sixty.
    if (moved && (!drawHalf || now - drawnAt >= 28)) {
      const t0 = SHOW_FPS ? performance.now() : 0;
      draw(); drawnAt = now;
      if (SHOW_FPS) { fps.drawMs += performance.now() - t0; fps.draws++; }
      // Live PAE maps: every residue against every residue, so the two maps take turns,
      // one a draw (one every other draw on a phone), not through the hit freeze, where
      // nothing moved, and not while the maps are off the screen.
      const every = drawHalf ? 2 : 1;
      if (hitstop <= 0 && drawn % every === 0 && !SIDE_PLATES.matches) { const i = (drawn / every) & 1, f = fighters[i]; updatePAE(f); drawPAE(f, i); }
      drawn++;
    }
    if (net.link && (moved ? ++net.seq % 4 === 0 : (phase === 'paused' && ++net.seq % 8 === 0))) sendState();   // 15 packets/s while active, heartbeat while paused
    hud(); placePlates(); fitStage(now); if (net.link || net.guest) netStatus(now);
    if (SHOW_FPS) fpsStatus(now, moved);
  }

  // ?fps: once a second, frames and draws a second and the script cost of a draw and of
  // a frame, so what a phone actually manages can be read off its screen.
  const fps = { frames: 0, draws: 0, drawMs: 0, frameMs: 0, at: 0 };
  function fpsStatus(now, moved) {
    fps.frames++; fps.frameMs += performance.now() - now;
    if (now - fps.at < 1000) return;
    const secs = (now - fps.at) / 1000; fps.at = now;
    setText('netstat', `${(fps.frames / secs).toFixed(0)} fps · ${(fps.draws / secs).toFixed(0)} draws/s · draw ${(fps.drawMs / Math.max(1, fps.draws)).toFixed(1)} ms · frame ${(fps.frameMs / Math.max(1, fps.frames)).toFixed(1)} ms · ${devicePixelRatio}x`);
    fps.frames = fps.draws = 0; fps.drawMs = fps.frameMs = 0;
  }

  // ---------------------------------------------------------------- remote play
  // A line under the switches while remote: packets and bytes a second, and the link's
  // state, so a stall or a slow line shows for what it is.
  function netStatus(now) {
    if (now - net.tick < 1000) return;
    const secs = (now - net.tick) / 1000; net.tick = now;
    const n = net.guest ? net.pkts : (net.tx || 0) - (net.txLast || 0); net.txLast = net.tx || 0;
    const st = window.Net.status();
    const rtt = net.guest ? window.Net.rtt() : net.rtt;
    const line = `${net.watch ? 'watching' : net.guest ? 'guest' : 'host'} · ${(n / secs).toFixed(0)} pkt/s · ${(net.bytes / secs / 1024).toFixed(0)} KB/s · ${st ? (st.open ? 'link ' + st.ice : 'no link') : 'no link'}${st && !st.signal ? ' · signal lost' : ''}${st && !st.relay ? ' · no relay' : ''}${rtt ? ' · ' + rtt + ' ms' : ''}${net.watchers ? ' · ' + net.watchers + ' watching' : ''}${st && st.queued > 8192 ? ' · queued ' + (st.queued / 1024 | 0) + ' KB' : ''}`;
    net.pkts = 0; net.bytes = 0;
    setText('netstat', line);
  }
  // What the guest runs the fight from. It has the same game and the same rigs, so it
  // simulates every tick itself, its own keys acting at once; the host's packet, fifteen
  // times a second, sets it straight: each fighter's state and the springs of its
  // motion, the numbers on the HUD, what the overlay says, and what happened since the
  // last packet (hits, callouts, the finisher, sounds). The unfolding travels only when
  // it changed. About 2 KB a packet.
  const SNAP = ['x', 'y', 'vx', 'vy', 'facing', 'hp', 'crouch', 'guard', 'sinceHit', 'squat', 'jumpDir', 'upReleased', 'landing', 'landPower',
    'fatigue', 'jit', 'settle', 'action', 't', 'hit', 'hits', 'hitAt', 'stun', 'cooldown', 'limp', 'seed', 'lastLow', 'blockStun', 'blockHold', 'heldBy', 'heldProg', 'tumble', 'combo', 'comboAir', 'specialAt'];
  // What a guest keeps its own for the fighter it drives: its keys have already moved
  // it, and the host's word on where it was a moment ago would only drag it back.
  const OWN = new Set(['y', 'vy', 'crouch', 'squat', 'jumpDir', 'upReleased', 'landing', 'landPower', 'action', 't']);
  const snap = f => {
    const o = {};
    for (const k of SNAP) o[k] = f[k];
    o.q = f.queued; o.m = f.motion; o.d = f.dents.map(d => ({ at: d.at, dir: d.dir, amp: d.amp, t: d.t }));
    o.lh = f.lastHit; o.kb = f.koBrk ?? null;
    return o;
  };
  function unsnap(f, o, own) {
    for (const k of SNAP) {
      if (own && OWN.has(k)) continue;
      if (own && k === 'x') { const d = o.x - f.x; f.x += Math.abs(d) > 25 ? d : d * 0.3; continue; }   // eased, unless far out
      f[k] = o[k];
    }
    f.lastHit = o.lh;
    if (own) return;
    f.queued = o.q; f.motion = o.m;
    f.dents = o.d.map(d => ({ ...d, w: dentWeights(f, d.at) }));
  }
  function sendState() {
    const [a, b] = fighters, n = a.form.n + b.form.n;
    // The unfolding changes only on a hit or as it refolds, so it goes only when it did
    // (and now and then anyway, so a guest that missed one catches up).
    const unfold = new Uint8Array(n);
    let u = 0;
    for (const f of fighters) for (let i = 0; i < f.form.n; i++) unfold[u++] = Math.round(f.unfold[i] * 255);
    const changed = !net.lastUnfold || net.tx % 30 === 0 || unfold.some((v, i) => v !== net.lastUnfold[i]);
    if (changed) net.lastUnfold = unfold;
    const h = {
      ph: phase, t: time, r: round, w: wins, k: koTimer, hs: hitstop, held: [[...held[0]], [...held[1]]],
      f: [snap(a), snap(b)], n: [a.form.n, b.form.n],
      ov: {
        on: !$('overlay').hidden,
        ti: $('title').hidden ? '' : $('title').textContent,
        ms: $('msg').hidden ? '' : $('msg').textContent,
        btn: $('go').hidden ? '' : $('go').textContent,
        end: $('overlay').classList.contains('ended'),
      },
      ev: net.events,
    };
    net.events = [];
    net.tx = (net.tx || 0) + 1; net.bytes += JSON.stringify(h).length + (changed ? n : 0);
    net.link.send({ h, u: changed ? unfold : null });
  }
  function applyState(m) {
    const { h, u } = m || {};
    net.rx = (net.rx || 0) + 1;
    if (!h || !h.f) return;
    net.pkts++; net.bytes += JSON.stringify(h).length + (u ? u.byteLength || u.length || 0 : 0);
    // What happened first: a new round makes new fighters, a hit is replayed on them.
    for (const e of h.ev || []) {
      if (e[0] === 'custom') installCustom(e[2], e[1]);
      else if (e[0] === 'reset') { if (e[1]) { pick[0] = e[1][0]; pick[1] = e[1][1]; showPicks(); } resetRound(); }
      else if (e[0] === 'hit' && fighters[e[1]].motion) landHit(e[1], e[2], e[3], e[4]);
      else if (e[0] === 'block' && fighters[e[1]].motion) blockHit(e[1], e[2], e[3], e[4]);
      else if (e[0] === 'throw' && fighters[e[1]].motion) grab(e[1]);
      else if (e[0] === 'flash') flash([e[1], 0, 0], e[2]);
      else if (e[0] === 'finish') finisher(e[1], true);
      else if (e[0] === 'sfx' && sfx[e[1]]) sfx[e[1]](...e.slice(2));
    }
    if (fighters[0].form.n !== h.n[0] || fighters[1].form.n !== h.n[1]) return;
    const was = phase;
    phase = h.ph; time = h.t; round = h.r; wins = h.w; koTimer = h.k; hitstop = h.hs;
    held[0] = new Set(h.held[0]);   // the host's keys drive P1 here too, between packets
    if (net.watch) held[1] = new Set(h.held[1]);
    fighters.forEach((f, j) => unsnap(f, h.f[j], j === 1 && !net.watch));
    if (u) { const bytes = u instanceof Uint8Array ? u : new Uint8Array(u); let k = 0; for (const f of fighters) for (let i = 0; i < f.form.n; i++) f.unfold[i] = bytes[k++] / 255; }
    if (phase === 'ko' && was !== 'ko') for (const f of fighters) if (f.hp === 0 && !f.koWave) denature(f);
    if (phase !== 'ko' && phase !== 'over') for (const f of fighters) { f.koWave = f.koLoose = null; }
    if (phase === 'paused') {
      for (const h of held) h.clear();
      if (was !== 'paused') duckMusic(0.08);
    } else if (phase === 'playing' && was === 'paused') {
      startMusic();
    }
    $('title').textContent = h.ov.ti; $('title').hidden = !h.ov.ti;
    $('msg').textContent = h.ov.ms; $('msg').hidden = !h.ov.ms;
    // Between rounds and at a match's end the host refolds or starts again; the guest
    // has no button for it, only a word that the host will, so nothing invites a click
    // that does nothing. RESUME it keeps (a request to the host). The menu is the host's alone.
    const btn = !net.watch && h.ov.btn === 'RESUME' ? 'RESUME' : '';
    $('go').textContent = btn; $('go').hidden = !btn;
    if (h.ov.on && phase === 'over' && !h.ov.ms) { $('msg').textContent = 'the host refolds'; $('msg').hidden = false; }
    $('modes').hidden = true;
    $('overlay').hidden = !h.ov.on; $('overlay').classList.toggle('ended', h.ov.end);
  }
  // A guest's keys act here at once and go to the host: strikes as presses, directions
  // as held or released. The guest is always P2.
  function guestPress(k) {
    startMusic();
    if (net.watch) return;
    if (k === 'escape') return net.send?.({ t: 'in', a: 'escape' });
    const r = route(k);
    if (!r) return;
    const act = r[1];
    net.send?.({ t: 'in', d: 1, a: act });
    if (phase !== 'playing') return;
    if (act === 'punch' || act === 'kick') return strike(1, act);
    if (act === 'up') jumpCancel(1);
    held[1].add(act);
  }
  function hostInput(m) {
    if (m && m.t === 'custom' && m.spec) { installCustom(m.spec, 1); netEvent('custom', 1, m.spec); pick[1] = 'custom1'; showPicks(); resetRound(); return; }   // the guest's own protein
    if (m && m.t === 'pick' && FORMS[m.form]) { pick[1] = m.form; showPicks(); if (phase === 'ready') resetRound(); return; }
    if (!m || m.t !== 'in') return;
    if (m.a === 'escape') return press('escape');
    if (phase !== 'playing') return;
    if (m.a === 'punch' || m.a === 'kick') return strike(1, m.a);
    if (m.d) { if (m.a === 'up') jumpCancel(1); held[1].add(m.a); }
    else { held[1].delete(m.a); if (m.a === 'up') fighters[1].upReleased = true; }
  }
  function hostRemote() {
    mode = 3;
    overlay('REMOTE', 'Getting a code…', null);
    $('modes').hidden = true; $('qr').hidden = false; $('qr').innerHTML = '';
    net.link = window.Net.host({
      onLink: link => { $('msg').textContent = 'scan, or send the link'; $('joinlink').value = link; $('joinbox').hidden = false; if (!window.Net.showQR($('qr'), link)) $('qr').hidden = true; $('title').textContent = 'SCAN TO JOIN'; },
      // The challenger is in: a fresh match, or, back after a drop, the match resumes where
      // it stopped (the reset the newcomer gets rebuilds its fighters; the packets set them).
      onGuest: () => {
        $('qr').hidden = true; $('modes').hidden = false;
        customSpec.forEach((spec, i) => { if (spec) net.events.push(['custom', i, spec]); });   // a newcomer needs the custom fighters before the reset that picks them
        if (phase === 'ready') return start(3);
        net.events.push(['reset', pick.slice()]);
        if (net.dropped) { net.dropped = false; if (phase === 'paused') { phase = 'playing'; $('overlay').hidden = true; startMusic(); } }
      },
      onWatcher: n => { net.watchers = n; },
      onPing: rtt => { net.rtt = rtt; },
      onInput: hostInput,
      onClose: () => { held[1].clear(); net.dropped = true; if (phase === 'playing') { phase = 'paused'; duckMusic(0.08); } overlay('CHALLENGER LEFT', 'waiting for them to come back; the same link works', 'MENU'); $('go').onclick = () => { $('go').onclick = () => start(); window.Net.stop(); net.link = null; net.dropped = false; phase = 'ready'; mode = 1; overlay('', '', null); }; },
      onError: msg => { window.Net.stop(); net.link = null; mode = 3; overlay('NO CONNECTION', msg, null); },
    });
    if (!net.link) { $('modes').hidden = false; $('qr').hidden = true; }
  }
  // The join link: clicking it selects it, and COPY (or the click) puts it on the clipboard.
  async function copyLink() {
    const input = $('joinlink'), btn = $('copylink');
    input.focus(); input.select(); input.setSelectionRange(0, input.value.length);
    let ok = false;
    try { await navigator.clipboard.writeText(input.value); ok = true; } catch { try { ok = document.execCommand('copy'); } catch {} }
    btn.textContent = ok ? 'COPIED' : 'SELECT ALL';
    setTimeout(() => { btn.textContent = 'COPY'; }, 1500);
  }
  $('joinlink').onclick = copyLink;
  $('copylink').onclick = copyLink;

  // A guest joins as the player, a watcher only watches. A dropped link is tried again
  // every few seconds; the host keeps the match waiting.
  function joinRemote(id, again = false) {
    $('modes').hidden = true; $('go').hidden = true;
    overlay(again ? 'RECONNECTING' : 'CONNECTING', again ? 'the link dropped; trying again…' : 'to the host…', null); $('modes').hidden = true;
    if (net.watch) { for (const el of document.querySelectorAll('.pad')) el.hidden = true; }
    else {
      document.querySelector('.pad.left .who').textContent = 'YOU';
      document.querySelector('.picks').hidden = false; document.querySelector('.pick[data-player="0"]').hidden = true;   // a guest picks only its own
    }
    mode = 3;   // P2 by the guest's own keys, P1 by the host's, as relayed
    const link = window.Net.join(id, {
      role: net.watch ? 'watch' : 'player',
      onOpen: () => { $('title').textContent = net.watch ? 'WATCHING' : 'CONNECTED'; $('msg').textContent = 'waiting for the host'; },
      onState: applyState,
      onClose: () => { net.send = null; setTimeout(() => joinRemote(id, true), 3000); },
      onError: msg => { overlay('NO CONNECTION', msg, 'RETRY'); $('go').hidden = false; $('go').onclick = () => location.reload(); },
    });
    net.send = link ? link.send : null;
  }

  try {
    applyTheme();
    resetRound();
    showPicks();
    startViewer(fighters[0].coords, fighters[1].coords);
    window.proteinFighter = { get fighters() { return fighters; }, get mode() { return mode; }, get phase() { return phase; }, get viewer() { return viewer; }, camera: CAMERA, forms: FORMS, barrelGap, get preview() { return preview; }, updatePAE, net, view, resetRound, attack, MOVES, SPECIAL };   // for poking at from the console
    $('one').disabled = false;
    if (net.guest) joinRemote(window.Net.joinId());
    requestAnimationFrame(frame);
  } catch (e) {
    console.error(e);
    overlay('RENDERER UNAVAILABLE', String(e && e.message || e), 'RELOAD');
    $('go').onclick = () => location.reload();
  }
})();
