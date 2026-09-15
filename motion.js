// Motion: from what a fighter is doing to where every residue of its rig belongs.
//
// One pass, one direction, and every quantity has a single owner - no stage corrects
// what an earlier one produced:
//   1. pose    what the body is doing, as a dozen angles and offsets, each on a critically
//              damped spring, so moves blend in and out instead of snapping
//   2. hips    where the pelvis is: the fighter's position, the pose's lunge or recoil,
//              and how high it rides - walking, standing, crouched, slumped or kneeling
//   3. feet    where each foot is in the world. Walking, the feet replay the walk from
//              ../dance, held still on the floor while they bear weight. Standing, a planted
//              foot stays put until the hips have moved away from it, then steps back under.
//              A leg that kicks, or tucks in the air, is posed instead
//   4. legs    two-bone IK from each hip to its foot, blended with any posed leg
//   5. place   forward kinematics (rig.js), turned to face ±x and set on the hips
// The game adds what damage does to the chain (dents, unfolding) and the physics on top.
(function () {
  const { rotX: X, rotY: Y, matMul3: mul } = window.Rig;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const clamp01 = n => clamp(n, 0, 1);
  const ease = n => { n = clamp01(n); return n * n * (3 - 2 * n); };
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrap = u => ((u % 1) + 1) % 1;
  // An arm: turned to point forward, then lifted (negative up). `out` brings it back toward
  // the bind pose, straight out to the side.
  const arm = (side, lift, out = 0) => mul(Y(side * Math.PI / 2 * (1 - out)), X(lift));
  const SIDES = ['l', 'r'];

  function create(rig, { MOVES, JUMP_V, JUMP_VX, SQUAT, LANDING }) {
    const P = rig.pivots, D = rig.domains;

    // 0 → 1 → 0 extension curve for a strike: snap out by the active frame, hold, recover.
    function extension(move, t) {
      const m = MOVES[move], contact = m.active / m.duration, u = t / m.duration;
      return u < contact ? ease(u / contact) : 1 - ease((u - contact - 0.15) / (1 - contact - 0.15));
    }

    // ------------------------------------------------------------- leg geometry
    // Each leg in the rig's side view (z forward, y up): thigh and shin lengths, and the
    // direction each points in the bind pose, so an angle of 0 is the bind leg.
    const LEG = Object.fromEntries(['lleg', 'rleg'].map(side => {
      const h = P[side + '_hip'], k = P[side + '_knee'], a = P[side + '_ankle'];
      const len = (p, q) => Math.hypot(q[1] - p[1], q[2] - p[2]);
      const dir = (p, q) => Math.atan2(q[2] - p[2], -(q[1] - p[1]));
      return [side, { thigh: len(h, k), shin: len(k, a), thighDir: dir(h, k), shinDir: dir(k, a) }];
    }));
    const LEG_LEN = LEG.lleg.thigh + LEG.lleg.shin;
    // Thigh and shin angles that put the ankle at (dz forward, dy up) from the hip, the knee
    // bending forward. Out of reach, the leg points at the target as far as it will go.
    function legIK(side, dz, dy) {
      const g = LEG[side], far = (g.thigh + g.shin) * 0.999, near = Math.abs(g.thigh - g.shin) + 1;
      let d = Math.hypot(dz, dy);
      if (d < 1e-6) { dy = -near; d = near; }
      const dc = clamp(d, near, far);
      dz *= dc / d; dy *= dc / d; d = dc;
      const reach = Math.atan2(dz, -dy);
      const bend = Math.acos(clamp((g.thigh * g.thigh + d * d - g.shin * g.shin) / (2 * g.thigh * d), -1, 1));
      const t = reach + bend, kz = g.thigh * Math.sin(t), ky = -g.thigh * Math.cos(t);
      return [t - g.thighDir, Math.atan2(dz - kz, -(dy - ky)) - g.shinDir];
    }
    // ...and back: where the ankle sits from the hip for given angles.
    function legFK(side, thigh, shin) {
      const g = LEG[side], T = thigh + g.thighDir, S = shin + g.shinDir;
      return [g.thigh * Math.sin(T) + g.shin * Math.sin(S), -g.thigh * Math.cos(T) - g.shin * Math.cos(S)];
    }

    // The pelvis (midway between the hips) is the body's reference point. The hips turn
    // with nothing but the pelvis, so root pitch never moves them.
    const PELVIS_Y = (P.lleg_hip[1] + P.rleg_hip[1]) / 2, PELVIS_Z = (P.lleg_hip[2] + P.rleg_hip[2]) / 2;
    // The foot's residues from its ankle, and the lowest of them for a foot turned by
    // `pitch` (as the rig turns a domain: y' = cos·y + sin·z).
    const isFloating = !D.lleg_foot?.length;
    const FOOT = D.lleg_foot.map(i => [rig.bind[i][1] - P.lleg_ankle[1], rig.bind[i][2] - P.lleg_ankle[2]]);
    const soleBelow = pitch => {
      if (!FOOT.length) return -12.0;
      const c = Math.cos(pitch), s = Math.sin(pitch);
      let m = Infinity;
      for (const [y, z] of FOOT) m = Math.min(m, c * y + s * z);
      return m;
    };
    // Soles stand 2 Å above the floor; a flat foot's ankle is that plus the foot's depth.
    const FLOOR = 2, ANKLE_Y = FLOOR - soleBelow(0);

    // A fighting stance, and the deep crouch down on the back knee, as ankle offsets from
    // the hip (forward, up) for the front (left) and back (right) foot. Crouching, slumping
    // and a knockout all sit somewhere between the two: `low` 0 standing … 1 kneeling. In
    // the crouch the back foot is up on its toes, so its ankle rides higher.
    const STAND = { l: [7.5, -59.9], r: [-17, -61] }, KNEEL = { l: [20, -24.2], r: [-16, -16.2] };
    const restFwd = (side, low) => lerp(STAND[side][0], KNEEL[side][0], low);
    const toeRaise = (side, low) => Math.max(0, lerp(STAND[side][1] - STAND.l[1], KNEEL[side][1] - KNEEL.l[1], low));
    const hipHeight = low => -lerp(STAND.l[1], KNEEL.l[1], low);   // the hips above a flat planted ankle

    // ---------------------------------------------------------------------- walk
    // The walk from ../dance: CMU mocap 07_01 retargeted onto this rig, reduced to three
    // harmonics of each thigh's and shin's pitch over one 100.8 Å stride, the foot turning
    // with the shin. It is sampled here as where the ankle goes relative to the hip, how the
    // foot is turned, and how far below the hip its lowest point reaches - so the walk plays
    // back with its heel strike, roll and toe-off, and its hips riding over the lower foot.
    const STRIDE = 100.8;
    const GAIT = {
      thigh: [0.256, 0.207, 0.469, 0.088, 0.008, 0.002, -0.063],
      shin: [-0.247, -0.149, 0.409, -0.105, 0.252, -0.025, 0.081],
    };
    const gaitAngle = (c, u) => {
      let a = c[0];
      for (let h = 1; h <= 3; h++) a += c[2 * h - 1] * Math.cos(2 * Math.PI * h * u) + c[2 * h] * Math.sin(2 * Math.PI * h * u);
      return a;
    };
    const SAMPLES = 200;
    const WALK = Array.from({ length: SAMPLES }, (_, i) => {
      const u = i / SAMPLES, t = gaitAngle(GAIT.thigh, u), s = gaitAngle(GAIT.shin, u), [dz, dy] = legFK('lleg', t, s);
      return { dz, dy, pitch: s, sole: dy + soleBelow(s) };
    });
    function walkAt(u) {
      const x = wrap(u) * SAMPLES, i = Math.floor(x), k = x - i, a = WALK[i], b = WALK[(i + 1) % SAMPLES];
      return { dz: lerp(a.dz, b.dz, k), dy: lerp(a.dy, b.dy, k), pitch: lerp(a.pitch, b.pitch, k), sole: lerp(a.sole, b.sole, k) };
    }
    // A foot bears weight from heel strike, where it is furthest forward, to toe-off, where it
    // is furthest back. The dance lets it slide a little in between; here it stands still.
    const argOf = better => WALK.reduce((b, w, i) => better(w.dz, WALK[b].dz) ? i : b, 0) / SAMPLES;
    const U_STRIKE = argOf((a, b) => a > b), U_OFF = argOf((a, b) => a < b);
    const bearing = u => { u = wrap(u); return U_STRIKE < U_OFF ? u >= U_STRIKE && u <= U_OFF : u >= U_STRIKE || u <= U_OFF; };
    const SWING_LEN = wrap(U_STRIKE - U_OFF);
    const swingThrough = u => clamp01(wrap(u - U_OFF) / SWING_LEN);   // 0 at toe-off … 1 at heel strike

    // Standing, a foot further than this from where it rests steps back under the hips:
    // wide enough that crouching (the front foot rests 12.5 Å further forward) kneels in
    // place rather than shuffling.
    const STEP_TOL = 14, STEP_TIME = 0.2, STEP_LIFT = 5;
    const ROLL_CENTRE = 19;   // Å: the barrel's centre above the membrane while it rolls on its side
    // ...and where the torso's centre is from the pelvis (measured on both rigs: 15 up, 6 forward).
    const TORSO_UP = 15, TORSO_FWD = 6.4;
    const SKID = 60;   // Å/s: shoved faster than this, planted feet skid along with the body

    // ------------------------------------------------------------------ springs
    // Critically damped, implicit: stable at any stiffness for a 60 Hz tick, no overshoot.
    // A spring used for the first time starts at its target, so nothing pops in.
    function spring(M, key, target, omega, dt) {
      if (!(key in M.x)) { M.x[key] = target; M.v[key] = 0; return target; }
      const K = omega * omega, den = 1 + dt * 2 * omega + dt * dt * K;
      M.v[key] = (M.v[key] + dt * K * (target - M.x[key])) / den;
      return (M.x[key] += dt * M.v[key]);
    }

    // --------------------------------------------------------------------- pose
    // What the body is doing, as targets. env: clock, and what damage has done to its
    // bearing - sag (slumped), crawl (nearly gone), tired (breathing), kickRange.
    function poseOf(f, env) {
      const pose = f.hp <= 0 ? 'ko' : f.action === 'thrown' ? 'thrown' : f.action === 'trapped' ? 'trapped' : f.stun > 0 ? 'hurt' : (f.blockStun > 0 || f.guard) ? 'block' : MOVES[f.action] ? f.action
        : f.y > 0 ? 'jump' : f.action;
      const s = MOVES[pose] ? extension(pose, f.t) : 0;
      const { sag, crawl, tired, kickRange: kr } = env;
      const armD = env.arms || { l: 0, r: 0 }, legD = env.legs || { l: 0, r: 0 };
      // Breathing: quick and shallow when fresh, slow and deep when hurt or winded.
      const breathe = Math.sin(env.clock * (2.5 + 1.5 * tired) + f.seed);
      const breath = breathe * (0.015 + 0.07 * tired), bob = tired * 0.12 * (breathe + 1) / 2;
      const T = {
        pose, pitch: f.crouch ? 0.05 : 0, fwd: 0, bend: 0, legs: null,
        // The head nods with the breath, and a little further down in a crouch.
        head: breath * 0.6 + (f.crouch ? 0.12 : 0),
        larmU: -0.65 + breath, larmL: 1.15, rarmU: -1 + breath, rarmL: 0.95,
        // slumped, it sinks toward the kneel, bobbing with each breath; crouched, all the way
        low: f.crouch ? 1 : ease(clamp01(sag + bob)),
      };
      // A leg as it stands at a given depth: where a kick starts from and returns to.
      const restIK = (side, low = T.low) => legIK(side + 'leg', restFwd(side, low), toeRaise(side, low) - hipHeight(low));
      // In the air the legs follow the arc: a partial tuck at take-off, tightest at the
      // top, reaching for the floor on the way down; the body leans into a forward jump.
      const airLegs = () => {
        const up = clamp(f.vy / JUMP_V, -1, 1), k = clamp01(1 - Math.abs(up) * (up < 0 ? 1.1 : 0.6));
        const lean = clamp(f.vx * f.facing / (JUMP_VX * 1.6), -1, 1);
        T.pitch = -0.35 * lean * (0.3 - 0.7 * up);
        T.larmU -= 0.35 * up; T.rarmU -= 0.25 * up;   // the arms come up with the jump and settle as it falls
        const l = [0.43 + k * 0.52, -0.16 - k * 0.69], r = [-0.40 + k * 0.85, -0.12 - k * 1.08];
        T.legs = { l: [l[0], l[1], l[1]], r: [r[0], r[1], r[1]] };
      };

      if (pose === 'punch' || pose === 'lowpunch' || pose === 'airpunch' || pose === 'straight') {
        // A damaged arm does not straighten all the way, and the body puts less behind it.
        const ar = 1 - 0.45 * armD.r;
        T.rarmU = -(1 - s * ar); T.rarmL = 0.95 * (1 - s * ar);
        T.head += s * 0.15;   // eyes on the target
        if (pose === 'straight') { T.pitch = s * 0.35 * ar; T.fwd = s * 14 * ar; T.larmU = -0.65 + s * 0.3; }   // the whole body behind it
        if (pose === 'punch') { T.pitch = s * 0.2; T.fwd = s * 5 * ar; }
        if (pose === 'lowpunch') T.low = 1;
        if (pose === 'airpunch') airLegs();
      } else if (pose === 'kick') {
        if (isFloating) {
          T.pitch = s * 0.35; T.fwd = s * 16; T.head = s * 0.15;
          T.rarmU = -0.5 - s * 0.3; T.rarmL = 0.5;
        } else {
          const legR = 0.5 + 0.5 * kr, chamber = ease(f.t / 0.06) * (1 - s);
          const [bt, bs] = restIK('l', T.low * (1 - clamp01(chamber + s)));
          T.legs = { l: [bt + legR * (chamber * 1.5 + s * 1.75), bs + legR * (-chamber * 1.3 + s * 1.65), legR * s * 0.9] };
          T.pitch = kr * s * 0.5;
          T.larmU = -0.65 - kr * s * 0.55; T.larmL = 1.15 - kr * s * 0.75;
          T.rarmU = -1 - kr * s * 0.9; T.rarmL = 0.95 - kr * s * 1.7;
          T.head = -kr * s * 0.25;   // the head stays up as the body leans back
        }
      } else if (pose === 'roundhouse') {
        if (isFloating) {
          T.pitch = s * 0.45; T.fwd = s * 22; T.head = s * 0.2;
          T.rarmU = -0.6 - s * 0.4; T.rarmL = 0.7;
        } else {
          const legR = 0.5 + 0.5 * kr, chamber = ease(f.t / 0.08) * (1 - s);
          const [bt, bs] = restIK('r', T.low * (1 - clamp01(chamber + s)));
          T.legs = { r: [bt + legR * (chamber * 1.65 + s * 2.1), bs + legR * (-chamber * 1.1 + s * 1.9), legR * s * 1.0] };
          T.pitch = kr * s * 0.6; T.fwd = s * 4;
          T.larmU = -0.65 - kr * s * 0.7; T.larmL = 1.15 - kr * s * 0.9;
          T.rarmU = -1 - kr * s * 1.0; T.rarmL = 0.95 - kr * s * 1.8;
          T.head = -kr * s * 0.3;
        }
      } else if (pose === 'spin') {
        // The helix spin: both paddles straight out, and the whole body whirling twice round
        // on the spot, leaning into it, the head tucked.
        const m = MOVES.spin, u = clamp01((f.t - m.active) / m.window), wind = ease(f.t / m.active);
        T.armOut = wind * (1 - ease((f.t - m.active - m.window) / 0.15));
        T.larmU = T.rarmU = -0.1; T.larmL = T.rarmL = 0;
        T.spin = 2 * 2 * Math.PI * u;
        T.pitch = 0.15 * wind; T.head = 0.35 * wind; T.bend = 6 * wind;
      } else if (pose === 'lowkick') {
        if (isFloating) {
          T.low = 1; T.pitch = 0.42 * s; T.fwd = s * 14;
        } else {
          // From the deep crouch, the back leg sweeps out along the floor.
          T.low = 1;
          const [bt, bs] = restIK('r');
          T.legs = { r: [bt + kr * s * (1.1 - bt), bs + kr * s * (1.45 - bs), bs + kr * s * (1.4 - bs)] };
          T.pitch = 0.05 + kr * s * 0.05;
          T.larmU = -0.3; T.rarmU = -0.4; T.larmL = 1.5; T.rarmL = 1.45;
        }
      } else if (pose === 'airkick') {
        // From the tuck, stamp the back leg down and forward.
        airLegs();
        if (!isFloating && T.legs?.r) T.legs.r = [0.45 + kr * s * 0.3, -1.2 + kr * s * 2.1, kr * s * 0.9];
        T.pitch = kr * s * 0.35;
        T.larmU = -0.3; T.rarmU = -1.2;
      } else if (pose === 'roll') {
        // The barrel roll, about the barrel's own axis: it drops onto its side so the axis
        // lies across the screen's depth, legs straight along the axis and arms folded in,
        // and spins about that axis as it travels - a wheel seen face on - then stands back
        // up. The tip and the spin are applied below, not sprung: they must come round
        // exactly. `tuck` is the lie-down, 0 standing … 1 flat; `roll` the spin.
        const m = MOVES.roll, u = clamp01((f.t - m.active) / m.window), tuck = ease(f.t / m.active) * (1 - ease((f.t - m.active - m.window) / 0.2));
        T.head = 0; T.pitch = 0;
        // Arms straight down the body and legs straight: everything along the axis, so the
        // wheel is round (folded across the chest, the arms were a lump that made it wobble).
        T.larmU = T.rarmU = lerp(-0.65, -1.5, tuck); T.larmL = T.rarmL = lerp(1.05, -1.5, tuck);   // both lifts: the forearm's is absolute, not off the upper arm
        T.legs = { l: [0, 0, -1.5 * tuck], r: [0, 0, -1.5 * tuck] };   // feet pointed down the leg, not out
        T.tip = Math.PI / 2 * tuck; T.roll = 2 * 2 * Math.PI * ease(u); T.tuck = tuck;
      } else if (pose === 'special') {
        // The heat shock: a half crouch, both arms driven forward and down to the floor as
        // the wave goes out, the torso leaning into it, then back up.
        T.low = 0.55 * s; T.pitch = 0.45 * s; T.fwd = 6 * s; T.head = 0.2 * s;
        T.larmU = T.rarmU = -0.65 + 0.85 * s; T.larmL = T.rarmL = 1.1 * (1 - s);
      } else if (pose === 'barrel_trap') {
        // GFP: opens its fluorescent beta-barrel cavity with a vacuum pull
        const u = f.t / (MOVES.barrel_trap?.duration || 1.1), pull = ease(Math.min(u / 0.22, 1));
        T.pitch = -0.22 * pull;
        T.fwd = 14 * pull;
        T.rarmU = -0.3; T.rarmL = 0.6;
        T.head = -0.15;
      } else if (pose === 'allosteric_clench') {
        // Hemoglobin: allosteric T->R clamp snapping shut
        const u = f.t / (MOVES.allosteric_clench?.duration || 0.9), clampP = ease(Math.min(u / 0.2, 1));
        T.pitch = 0.3 * clampP;
        T.fwd = 15 * clampP;
        T.rarmU = -0.5; T.rarmL = 1.1;
      } else if (pose === 'condensate_trap') {
        // FUS: liquid phase separation droplet wobble
        const u = f.t / (MOVES.condensate_trap?.duration || 1.15);
        T.pitch = Math.sin(u * Math.PI * 8) * 0.22;
        T.fwd = 10 * ease(Math.min(u / 0.25, 1));
      } else if (pose === 'catalytic_surge') {
        // Catalytic surge: charges up and discharges radial energy
        const u = f.t / (MOVES.catalytic_surge?.duration || 0.85);
        T.pitch = -0.25 * ease(Math.min(u / 0.15, 1));
        T.fwd = 6;
      } else if (pose === 'throw') {
        // Reach out with both arms, take hold, heave up and over the head, and follow
        // through: the torso leans back under the weight, then forward as it lets go.
        const m = MOVES.throw, u = f.t / m.duration, reach = ease(u / 0.15), lift = ease((u - 0.15) / 0.4), go = ease((u - 0.55) / 0.3);
        const armU = -0.2 * reach - 1.9 * lift + 1.4 * go, armL = 0.9 * (1 - reach) + 0.2 * lift - 0.4 * go;
        T.larmU = T.rarmU = armU; T.larmL = T.rarmL = armL;
        T.pitch = -0.5 * lift + 0.9 * go; T.fwd = 8 * reach - 6 * go; T.head = -0.3 * lift + 0.5 * go;
        T.bend = 10 * lift * (1 - go);
      } else if (pose === 'thrown') {
        // Held: hanging from the grip, legs kicking. Flung: a backward tumble in the air,
        // arms and legs flung out, pitched over more and more until it lands.
        if (f.heldBy != null) {
          // Lifted, it turns over with the lift: back, then feet over the head, so it
          // leaves the hands upside down; the legs kick, then trail.
          const g = f.heldProg || 0;
          f.tumble = -0.3 - 2.3 * g;
          T.pitch = f.tumble; T.larmU = T.rarmU = -1.6 + 0.6 * g; T.larmL = T.rarmL = 0.4; T.head = -0.3 + 0.4 * g;
          const kick = Math.sin(env.clock * 14) * (1 - g);
          T.legs = { l: [0.6 + 0.3 * kick - 0.5 * g, -1.2 + 0.7 * g, -0.4], r: [0.2 - 0.3 * kick - 0.3 * g, -1.4 + 0.8 * g, -0.4] };
        } else {
          // Flung: the turn carries on through the air, a full circle by about the time
          // it lands, arms and legs out.
          f.tumble = (f.tumble ?? -2.6) - 6.5 * (1 / 60);
          T.pitch = f.tumble; T.larmU = T.rarmU = -2.2; T.larmL = T.rarmL = 0.1; T.head = 0.2;
          T.legs = { l: [0.9, -1.0, 0.2], r: [-0.4, -1.4, 0.3] };
        }
      } else if (pose === 'trapped') {
        // Trapped inside a custom protein cavity (e.g. GFP beta-barrel, allosteric clamp, or droplet)
        const g = f.heldProg || 0;
        const shiv = Math.sin(env.clock * 32) * (0.3 + 0.4 * g);
        T.pitch = shiv;
        T.larmU = T.rarmU = -0.5 + shiv * 0.4;
        T.larmL = T.rarmL = 1.4;
        T.head = shiv * 0.5;
        T.low = 0.6;
        T.bend = 12 * Math.sin(env.clock * 28);
        T.legs = { l: [-0.4, 0.8, 0], r: [-0.4, 0.8, 0] };
      } else if (pose === 'block') {
        // The guard: both forearms pulled in tight over the head, the head tucked down
        // behind them, and standing, the front knee brought up to cover the body, as a
        // fighter checks a kick. Taking a blow on it, the body leans back off the blow and
        // the standing knee gives a little; kneeling if crouched. The brace eases off as
        // the blockstun runs out.
        const r = clamp01(f.blockStun / 0.15);
        // Lift is negative down: the upper arm a little below level with the elbow out in
        // front, the forearm folded straight up, so the fists sit in front of the face
        // (measured: 15 Å forward and 12 up from the shoulder on the barrel, the head
        // centre 17 up). A damaged arm cannot hold its guard up: it hangs lower.
        T.larmU = -0.3 - 0.8 * armD.l; T.larmL = 1.85 - 0.6 * armD.l; T.rarmU = -0.3 - 0.8 * armD.r; T.rarmL = 1.85 - 0.6 * armD.r;
        T.pitch = -0.15 * r; T.head = 0.5; T.bend = 8 * r;
        if (f.crouch) T.low = 1;
        else { const [bt, bs] = restIK('l'); T.legs = { l: [bt + 0.85 * (1 - 0.5 * legD.l), bs - 0.7, 0.25] }; }   // the front knee up (less on a bad leg)
      } else if (pose === 'rest') {
        // Round won: guard down, arms hanging loose with a little bend at the elbow.
        T.larmU = T.rarmU = -1.4 + breath; T.larmL = T.rarmL = -1.2; T.head = 0.25 + breath;
      } else if (pose === 'hurt') {
        const r = Math.sin(clamp01(1 - f.stun / 0.3) * Math.PI);
        T.pitch = -r * 0.8; T.rarmU = -1 - r * 0.7; T.fwd = -r * 12;
        if (f.lastLow) { T.bend = 17 * 0.8 * r; T.pitch = -r * 0.4; T.head = r * 0.3; }   // a low blow: the knees buckle and the body folds forward instead
        T.head = -r * 0.5;   // the head snaps back with the blow (the neck's own whiplash is jolt())
      } else if (pose === 'jump') {
        airLegs();
        T.head = -0.15;   // looking up into the jump
      } else if (pose === 'ko') {
        // Collapse: the knees give into the kneel and the torso folds forward, arms hanging,
        // the head lolling.
        T.low = 1; T.pitch = -1.2; T.larmU = T.rarmU = T.larmL = T.rarmL = 1.4; T.head = 0.7;
      }

      // The slump leans the torso forward and lets the guard sink; a strike keeps the lean.
      const slump = -0.45 * sag - 0.6 * crawl;
      if (sag > 0 && (pose === 'idle' || pose === 'rest' || pose === 'walk' || pose === 'hurt')) {
        const droop = 1.1 * sag + 0.8 * crawl;
        T.pitch += slump; T.larmU += droop; T.larmL += droop; T.rarmU += droop; T.rarmL += droop;
        T.head += 0.5 * sag + 0.4 * crawl;   // the head hangs too
      }
      // Each arm hangs by its own damage: a battered arm drops out of the guard.
      if (pose === 'idle' || pose === 'rest' || pose === 'walk' || pose === 'hurt') {
        T.larmU -= 0.9 * armD.l; T.larmL -= 0.4 * armD.l; T.rarmU -= 0.9 * armD.r; T.rarmL -= 0.4 * armD.r;   // lift is negative down
      }
      if (sag > 0 && MOVES[pose] && !MOVES[pose].air && f.y === 0) T.pitch += slump;
      if (pose === 'idle' || pose === 'rest') T.pitch += breath * 0.8;   // the chest heaves

      // Knees bend to push off, and again to soak up a landing, harder for a longer fall.
      const standing = pose === 'idle' || pose === 'rest' || pose === 'walk';
      if (standing && f.squat > 0) T.bend = 17 * 0.55 * (1 - f.squat / SQUAT);
      else if (standing && f.landing > 0) T.bend = 17 * 0.75 * f.landPower * (f.landing / LANDING);
      // On guard, a light bounce on the knees, as a boxer stays on the balls of the feet.
      // Warming up behind the menu it bounces in earnest, quicker and deeper.
      else if (pose === 'idle' && !f.crouch && f.y === 0) { const b = env.bounce || 0; T.bend = (2.5 + 7 * b) * (0.5 + 0.5 * Math.sin(env.clock * 2 * Math.PI * (1.4 + 0.8 * b) + f.seed)); }
      // How fast the pose follows: strikes land on time, a knockout goes slack slowly.
      const bracing = f.squat > 0 || f.landing > 0;
      T.omega = MOVES[pose] ? (pose === 'spin' ? 80 : 60) : bracing ? 55 : pose === 'hurt' ? 40 : pose === 'block' ? 50 : pose === 'thrown' ? 45 : pose === 'ko' ? 10
        : f.y > 0 ? 28 : f.action === 'walk' ? 45 : f.crouch ? 26 : 15;   // rad/s
      return T;
    }

    function stateOf(f) {
      if (f.motion) return f.motion;
      const foot = x => ({ x, lift: 0, lift0: 0, swinging: false, walkSwing: false, free: false, from: x, u: 0, gap: 0, walkY: null, walkPitch: 0 });
      return (f.motion = {
        x: {}, v: {},   // spring positions and velocities, by name
        feet: { l: foot(f.x + f.facing * STAND.l[0]), r: foot(f.x + f.facing * STAND.r[0]) },
        phase: 0, walking: false, lastHip: f.x, lastV: 0, lastVy: f.vy,
        swing: { l: [0, 0], r: [0, 0], leg: [0, 0], head: [0, 0] }, k: 1, stretch: { l: 0, r: 0 },
      });
    }

    // Setting off, the walk picks up at the point in its cycle where the dance has the feet
    // closest to where they already stand, so no first step is dragged into place.
    function pickUpWalk(M, hx, fc, scale) {
      let best = 0, bestErr = Infinity;
      for (let i = 0; i < SAMPLES; i++) {
        const u = i / SAMPLES;
        const err = Math.abs(M.feet.l.x - (hx + fc * walkAt(u).dz * scale))
          + Math.abs(M.feet.r.x - (hx + fc * walkAt(u + 0.5).dz * scale));
        if (err < bestErr) { bestErr = err; best = u; }
      }
      M.phase = best;
    }

    // One tick for one fighter; returns world coordinates for every residue.
    function update(f, env) {
      const M = stateOf(f), dt = env.dt, T = poseOf(f, env), w = T.omega, air = f.y > 0, fc = f.facing;

      // 1. The pose, on springs.
      let pitch = spring(M, 'pitch', T.pitch, w, dt);
      if (isFloating) {
        // Floating hover sway & banking into movement
        const bank = clamp((f.vx * fc) / 220, -0.3, 0.3);
        const idleSway = Math.sin(env.clock * 2.0 + f.seed) * 0.05;
        pitch += (air ? -0.2 * clamp(f.vx * fc / 200, -1, 1) : bank) + idleSway;
      }
      const fwd = spring(M, 'fwd', T.fwd, w, dt);
      const low = clamp01(spring(M, 'low', T.low, Math.min(w, 26), dt));
      const bend = spring(M, 'bend', T.bend, 55, dt);
      const lu = spring(M, 'larmU', T.larmU, w, dt), ll = spring(M, 'larmL', T.larmL, w, dt);
      const ru = spring(M, 'rarmU', T.rarmU, w, dt), rl = spring(M, 'rarmL', T.rarmL, w, dt);
      const hd = spring(M, 'head', T.head, Math.min(w, 30), dt);
      const out = spring(M, 'armOut', T.armOut || 0, 40, dt);   // arms straight out to the sides, for the spin
      const spinAngle = T.spin || 0;   // the spin's turn is applied directly, not sprung: it must come round exactly
      // A posed leg (kicking, or in the air) blends in over about a tenth of a second.
      const posed = {};
      for (const side of SIDES) {
        const want = T.legs && T.legs[side];
        const weight = clamp01(spring(M, 'w' + side, want ? 1 : 0, 30, dt));
        const angles = want ? want.map((a, j) => spring(M, side + j, a, w, dt)) : [0, 1, 2].map(j => M.x[side + j]);
        posed[side] = { weight, angles };
      }

      // 2. The hips.
      const hx = f.x + fc * fwd;
      const dx = hx - M.lastHip;
      M.lastHip = hx;
      // Walking into a wall or a braced opponent covers no ground, and the cycle (which
      // advances with ground covered) would freeze with a foot in the air; so a walk that
      // is getting nowhere stands, and picks up its stride again when it moves.
      const walking = !air && f.action === 'walk' && Math.abs(dx) > 0.05;
      // The lower the hips, the shorter the step: a full stride from a slumped crouch threw
      // the back leg out flat behind it. Down to a little over half, shuffling, kneeling.
      const legD = env.legs || { l: 0, r: 0 };
      const scale = 1 - 0.45 * low, stride = STRIDE * scale;
      if (walking && !M.walking) pickUpWalk(M, hx, fc, scale);
      M.walking = walking;
      // The cycle advances with ground covered, and runs backward walking backward.
      if (walking) M.phase = wrap(M.phase + dx * fc / stride);
      const gl = walkAt(M.phase), gr = walkAt(M.phase + 0.5);
      // A damaged leg limps: its step is shorter and lower, and the hips drop onto it while
      // it bears the weight, so the gait rocks to the bad side. The step scale is per leg;
      // the height and the drop are read below where the foot is placed.
      const limpOf = side => 1 - 0.45 * legD[side];
      const hipDrop = walking ? 7 * (legD.l * (bearing(M.phase) ? 1 : 0) + legD.r * (bearing(M.phase + 0.5) ? 1 : 0))
        : 3.5 * Math.max(legD.l, legD.r);   // standing, it sags onto the bad leg a little
      // Walking, the hips ride where the dance holds them, over whichever foot is lower (so a
      // sole always meets the floor and the hips rise and fall through the stride), sunk by
      // the slump; standing, at the stance's height for its depth, less any knee bend.
      const walkHip = FLOOR - Math.min(gl.sole, gr.sole);
      // The body has weight: the hips dip as each heel lands and the weight comes onto
      // it, and ride up again over the standing leg, twice a stride. A dip only, never a
      // rise, so the standing leg is never asked to reach further than it is long.
      const bob = walking ? 3 * (1 + Math.cos(4 * Math.PI * (M.phase - U_STRIKE))) / 2 : 0;
      // Lying on its side for the barrel roll, the barrel's centre (15 Å up the body from the
      // pelvis, and 6 forward of it) sits a barrel's radius above the membrane; the pelvis
      // follows from that.
      let hipTarget;
      if (isFloating) {
        // Floating hover height: hover smoothly at torso chest height ~75 Å
        const floatBob = Math.sin(env.clock * 2.8 + f.seed) * 3.5;
        const crouchDrop = f.crouch ? 16 : 0;
        hipTarget = (air ? f.y : 0) + 52 - crouchDrop + floatBob;
      } else {
        hipTarget = T.tuck ? lerp(ANKLE_Y + hipHeight(0), ROLL_CENTRE - TORSO_UP, T.tuck) : air ? ANKLE_Y + hipHeight(0)
          : walking ? walkHip - (hipHeight(0) - hipHeight(low)) - hipDrop - bob
          : ANKLE_Y + hipHeight(low) - bend - hipDrop;
      }
      const hy = (air ? f.y : 0) + spring(M, 'hipY', hipTarget, air ? 20 : (isFloating ? 45 : 60), dt);
      const skid = !air && Math.abs(f.vx) > SKID;

      // 3. The feet.
      if (isFloating) {
        for (const side of SIDES) {
          const F = M.feet[side];
          F.x = hx; F.lift = 0; F.free = true; F.swinging = F.walkSwing = false; F.walkY = null;
        }
      } else for (const side of SIDES) {
        const F = M.feet[side], other = M.feet[side === 'l' ? 'r' : 'l'];
        const rest = hx + fc * restFwd(side, low);
        F.walkY = null;
        if (air || posed[side].weight > 0.5) {   // posed: placed below, wherever the leg puts it
          F.free = true; F.swinging = F.walkSwing = false; F.lift = F.lift0 = 0;
          continue;
        }
        F.free = false;
        if (skid) { F.x += dx; F.swinging = F.walkSwing = false; F.lift = F.lift0 = 0; continue; }
        if (walking) {
          const u = side === 'l' ? M.phase : M.phase + 0.5, g = side === 'l' ? gl : gr;
          const there = hx + fc * g.dz * scale * limpOf(side);   // where the dance has this foot now, a bad leg reaching less
          if (bearing(u)) {
            // Down: from heel strike it stays exactly where it landed until toe-off.
            if (F.swinging) { if (F.walkSwing) F.x = there; F.swinging = F.walkSwing = false; M.stepSeq = (M.stepSeq || 0) + 1; M.stepX = F.x; }   // heel strike
          } else {
            // In the air it follows the dance. What the planted foot drifted from the dance
            // while it bore weight is carried off at toe-off and faded out by heel strike.
            if (!F.walkSwing) { F.swinging = F.walkSwing = true; F.gap = F.x - there; }
            const through = swingThrough(u), done = dx * fc >= 0 ? through : 1 - through;
            F.x = there + F.gap * (1 - ease(done));
          }
          F.walkY = walkHip + g.dy - (walkHip + g.dy - ANKLE_Y) * 0.5 * legD[side];   // the dance's ankle height: heel strike, roll, toe-off, swing; a bad leg barely lifts
          F.walkPitch = g.pitch;
          F.lift = F.walkY - ANKLE_Y;
          continue;
        }
        // Standing. Stopped mid-stride, the swinging foot carries on home.
        if (F.walkSwing) { F.walkSwing = false; F.from = F.x; F.lift0 = F.lift; F.u = 0; }
        if (F.swinging) {
          F.u = Math.min(1, F.u + dt / STEP_TIME);
          F.x = lerp(F.from, rest, ease(F.u));
          F.lift = F.lift0 * (1 - F.u) + STEP_LIFT * Math.sin(Math.PI * F.u);
          if (F.u >= 1) { F.swinging = false; F.lift = F.lift0 = 0; M.stepSeq = (M.stepSeq || 0) + 1; M.stepX = F.x; }   // a step set down
        } else {
          F.lift *= 0.7;   // a heel still raised from the walk settles flat
          if (f.hp > 0 && !other.swinging && Math.abs(F.x - rest) > STEP_TOL) {
            F.swinging = true; F.u = 0; F.from = F.x; F.lift0 = F.lift;   // left behind: step under
          }
        }
      }

      // 4. The legs: IK to each foot, blended with any posed leg.
      const L = {};
      for (const side of SIDES) {
        const F = M.feet[side], g = side + 'leg', Q = posed[side];
        const ankleY = F.walkY ?? (ANKLE_Y + toeRaise(side, low) + F.lift);
        const dzA = (F.x - hx) * fc, dyA = ankleY - hy;
        M.stretch[side] = Math.hypot(dzA, dyA) / LEG_LEN;   // 1 = fully straight (for inspection)
        let [t, s] = legIK(g, dzA, dyA);
        // Walking, the foot turns as the dance turns it; standing, it is flat on the floor,
        // toes down into a kneel; stepping, it points a little.
        let ft = F.walkY != null ? F.walkPitch : F.swinging ? s * 0.5 : s * low;
        // A foot on the floor cannot point through it: levelled until its sole clears.
        if (F.walkY == null) for (let n = 0; n < 8 && ankleY + soleBelow(ft) < FLOOR - 0.2; n++) ft *= 0.7;
        if (Q.weight > 1e-3 && Q.angles[0] !== undefined) {
          t = lerp(t, Q.angles[0], Q.weight); s = lerp(s, Q.angles[1], Q.weight); ft = lerp(ft, Q.angles[2], Q.weight);
        }
        // Not posed: the posed-leg springs rest on the leg as it is, so the next kick
        // starts from here rather than from wherever the last one left off.
        if (Q.weight < 0.02) [t, s, ft].forEach((a, j) => { M.x[side + j] = a; M.v[side + j] = 0; });
        if (F.free) F.x = hx + fc * legFK(g, t, s)[0];
        L[side] = [t, s, ft];
      }

      // 5. Limbs on strings: each arm, the head on its neck, and the shins in the air, is
      // a lightly damped pendulum driven by the hips' own acceleration - arms and head
      // trail as it lunges or sets off, fling forward as it stops, drop as it lands, swing
      // against the legs when walking. The looser the protein, the slower and wider. A
      // blow jolts them (jolt()); strikes damp the arms so a punch keeps its shape.
      const S = M.swing, v = dx / dt, acc = (v - M.lastV) / dt * fc, accY = (f.vy - M.lastVy) / dt;
      M.lastV = v; M.lastVy = f.vy;
      const loose = 0.3 + 0.7 * env.mean;
      const wn = 12 - 6 * loose, zeta = 0.25 - 0.1 * loose;
      const trail = clamp(acc * 0.0004, -0.9, 0.9), drop = clamp(accY * 0.00001, -0.5, 0.5);
      const gait = walking ? Math.sin(2 * Math.PI * M.phase) * (0.3 + 0.3 * loose) : 0;
      const pend = (st, target, w = wn, z = zeta) => { st[1] += (w * w * (target - st[0]) - 2 * z * w * st[1]) * dt; st[0] += st[1] * dt; };
      pend(S.l, trail + gait + drop); pend(S.r, trail - gait + drop); pend(S.leg, clamp(accY * 0.00002, -0.8, 0.8));
      // The neck is the loosest joint of all: slower and less damped than the arms, so the
      // head lags a lunge and keeps nodding after a blow.
      pend(S.head, -0.6 * trail + 0.8 * drop, wn * 0.8, zeta * 0.7);   // lags a lunge (back), drops on a landing (forward)
      S.head[0] = clamp(S.head[0], -1.2, 1.2);
      M.k += ((MOVES[f.action] ? 0.25 : 1) - M.k) * 0.15;
      const k = M.k, flap = air ? S.leg[0] : 0;

      // 6. The rig, turned to face ±x (a rotation, not a mirror, so chirality survives) and
      // set on the hips. Turning round is a swing through the front, not a flip: the yaw
      // springs from one facing to the other in about a sixth of a second.
      const turn = 36 * (1 - 0.5 * Math.max(legD.l, legD.r));   // on bad legs the pivot is slow
      const yaw = spring(M, 'yaw', fc * Math.PI / 2, turn, dt) + fc * spinAngle, cy = Math.cos(yaw), sy = Math.sin(yaw);
      const p = rig.pose({
        root_R: X(pitch),
        larm_upper: arm(-1, lu + S.l[0] * k, out), larm_lower: arm(-1, ll + S.l[0] * 1.6 * k, out),
        rarm_upper: arm(1, ru + S.r[0] * k, out), rarm_lower: arm(1, rl + S.r[0] * 1.6 * k, out),
        lleg_upper: X(L.l[0]), lleg_lower: X(L.l[1] + flap), lleg_foot: X(L.l[2]),
        rleg_upper: X(L.r[0]), rleg_lower: X(L.r[1] + flap * 0.8), rleg_foot: X(L.r[2]),
        head: X(pitch - hd - S.head[0]),   // the rig's positive pitch tilts back; head angles here are nods forward
      });
      for (const q of p) {
        const x = q[0], y = q[1], z = q[2];
        q[0] = x * cy + (z - PELVIS_Z) * sy + hx; q[1] = y - PELVIS_Y + hy; q[2] = -x * sy + (z - PELVIS_Z) * cy;
      }
      // The barrel roll: the body tipped onto its side about the axis it travels along (so
      // the barrel's own axis lies across the depth), then spun about that axis, forward.
      if (T.tuck) {
        const cx = hx + fc * TORSO_FWD, cy = hy + TORSO_UP;
        const ct = Math.cos(T.tip), st = Math.sin(T.tip), c = Math.cos(T.roll), sn = Math.sin(T.roll) * -fc;
        for (const q of p) {
          let dy = q[1] - cy, dz = q[2];
          q[1] = cy + dy * ct - dz * st; q[2] = dy * st + dz * ct;          // the tip, about the travel axis
          const dx = q[0] - cx; dy = q[1] - cy;
          q[0] = cx + dx * c - dy * sn; q[1] = cy + dx * sn + dy * c;      // the spin, about the depth axis
        }
      }
      M.hip = [hx, hy]; M.pose = T.pose;
      return p;
    }

    // A blow: the head whips on its neck, the arms fly, the legs buckle - by so much
    // angular speed (rad/s) each. Positive head is a nod forward.
    function jolt(f, { head = 0, arms = 0, legs = 0 }) {
      const S = stateOf(f).swing;
      S.head[1] += head; S.l[1] += arms; S.r[1] += arms; S.leg[1] += legs;
    }
    const NECK_HEIGHT = (P.neck ? P.neck[1] : P.larm_shoulder[1]) - PELVIS_Y;   // the neck above the hips, in the rig

    return { update, jolt, legIK, legFK, STRIDE, ANKLE_Y, NECK_HEIGHT };
  }

  window.Motion = { create };
})();
