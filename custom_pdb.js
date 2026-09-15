// Custom PDB Fighter module for Protein Fighter.
// Parses PDB C-alpha coordinates and B-factors (pLDDT), normalizes orientation via PCA,
// automatically detects the optimal punching arm, attaches procedural alpha-helical legs,
// and constructs a dynamic DomainRig form compatible with the game's motion and physics.
(function () {
  const CA_STEP = 3.8021;

  // ---------------------------------------------------------------- Vector math helpers
  const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm3 = a => Math.hypot(a[0], a[1], a[2]);
  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  // ---------------------------------------------------------------- PDB Parser
  function parsePdb(text) {
    const lines = text.split('\n');
    const cas = [];
    const seen = new Set();
    for (const line of lines) {
      const rec = line.slice(0, 6).trim();
      if (rec !== 'ATOM' && rec !== 'HETATM') continue;
      const atomName = line.slice(12, 16).trim();
      if (atomName !== 'CA') continue;
      const altLoc = line[16];
      if (altLoc && altLoc !== ' ' && altLoc !== 'A') continue;
      const chain = line[21] || 'A';
      const resSeq = parseInt(line.slice(22, 26).trim(), 10);
      const key = `${chain}_${resSeq}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const resName = line.slice(17, 20).trim();
      const x = parseFloat(line.slice(30, 38));
      const y = parseFloat(line.slice(38, 46));
      const z = parseFloat(line.slice(46, 54));
      const bStr = line.slice(60, 66).trim();
      const plddt = bStr ? parseFloat(bStr) : 85.0;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      cas.push({ chain, resSeq, resName, x, y, z, plddt: Number.isFinite(plddt) ? plddt : 85.0 });
    }
    return cas;
  }

  // ---------------------------------------------------------------- mmCIF Parser
  // Parses mmCIF / ModelCIF format as produced by AlphaFold 3, Boltz-1, Chai-1, and RCSB.
  function parseCif(text) {
    const loopRegex = /loop_\s*(?:#[^\n]*\n\s*)*(_atom_site\.[^\s]+)/i;
    const loopMatch = loopRegex.exec(text);
    if (!loopMatch) {
      throw new Error('No _atom_site loop found in CIF file');
    }

    let pos = loopMatch.index + loopMatch[0].lastIndexOf('_atom_site.');
    const len = text.length;

    // Fast streaming CIF tokenizer
    function nextToken() {
      while (pos < len) {
        const ch = text[pos];
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
          pos++;
          continue;
        }
        if (ch === '#') {
          while (pos < len && text[pos] !== '\n') pos++;
          continue;
        }
        if (ch === ';' && (pos === 0 || text[pos - 1] === '\n')) {
          pos++;
          const start = pos;
          while (pos < len) {
            if (text[pos] === ';' && text[pos - 1] === '\n') {
              const token = text.slice(start, pos - 1);
              pos++;
              return token;
            }
            pos++;
          }
          return text.slice(start);
        }
        if (ch === "'") {
          pos++;
          const start = pos;
          while (pos < len && text[pos] !== "'") pos++;
          const token = text.slice(start, pos);
          if (pos < len) pos++;
          return token;
        }
        if (ch === '"') {
          pos++;
          const start = pos;
          while (pos < len && text[pos] !== '"') pos++;
          const token = text.slice(start, pos);
          if (pos < len) pos++;
          return token;
        }
        const start = pos;
        while (pos < len) {
          const c = text[pos];
          if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '#') break;
          pos++;
        }
        return text.slice(start, pos);
      }
      return null;
    }

    // Read header tags
    const headers = [];
    while (true) {
      const savedPos = pos;
      const tok = nextToken();
      if (!tok || !tok.startsWith('_atom_site.')) {
        pos = savedPos;
        break;
      }
      headers.push(tok.toLowerCase());
    }

    const numCols = headers.length;
    if (numCols === 0) throw new Error('No _atom_site headers found in CIF file');

    const colMap = {};
    for (let i = 0; i < headers.length; i++) colMap[headers[i]] = i;

    const getCol = (...names) => {
      for (const n of names) {
        const idx = colMap[n.toLowerCase()];
        if (idx !== undefined) return idx;
      }
      return -1;
    };

    const xCol = getCol('_atom_site.cartn_x');
    const yCol = getCol('_atom_site.cartn_y');
    const zCol = getCol('_atom_site.cartn_z');
    const bCol = getCol('_atom_site.b_iso_or_equiv');
    const atomCol = getCol('_atom_site.auth_atom_id', '_atom_site.label_atom_id');
    const compCol = getCol('_atom_site.auth_comp_id', '_atom_site.label_comp_id');
    const asymCol = getCol('_atom_site.auth_asym_id', '_atom_site.label_asym_id');
    const seqCol = getCol('_atom_site.auth_seq_id', '_atom_site.label_seq_id');
    const altCol = getCol('_atom_site.label_alt_id');
    const modelCol = getCol('_atom_site.pdbx_pdb_model_num');

    if (xCol === -1 || yCol === -1 || zCol === -1) {
      throw new Error('Missing Cartn_x/y/z coordinates in CIF _atom_site');
    }

    const cas = [];
    const seen = new Set();
    let firstModel = null;

    while (true) {
      const firstTok = nextToken();
      if (!firstTok) break;
      if (firstTok === 'loop_' || firstTok.startsWith('data_') || firstTok.startsWith('save_') ||
          (firstTok.startsWith('_') && !firstTok.startsWith('_atom_site.'))) {
        break;
      }

      const row = new Array(numCols);
      row[0] = firstTok;
      for (let c = 1; c < numCols; c++) row[c] = nextToken();

      // Only take the first model in multi-model files (e.g. Chai-1 / Boltz / NMR)
      if (modelCol !== -1) {
        const model = row[modelCol];
        if (firstModel === null && model !== '.' && model !== '?') firstModel = model;
        if (firstModel !== null && model !== firstModel) continue;
      }

      // Filter alternate conformations
      if (altCol !== -1) {
        const alt = row[altCol];
        if (alt && alt !== '.' && alt !== '?' && alt !== 'A' && alt !== ' ') continue;
      }

      // Must be C-alpha atom
      const atomName = atomCol !== -1 ? row[atomCol] : '';
      if (atomName !== 'CA') continue;

      // Exclude Calcium ions (comp_id = CA or CAL)
      const resName = compCol !== -1 ? row[compCol] : 'GLY';
      if (resName === 'CA' || resName === 'CAL') continue;

      const chain = asymCol !== -1 ? row[asymCol] : 'A';
      const rawSeq = seqCol !== -1 ? row[seqCol] : (cas.length + 1);
      const resSeq = parseInt(rawSeq, 10) || (cas.length + 1);

      const key = `${chain}_${resSeq}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const x = parseFloat(row[xCol]);
      const y = parseFloat(row[yCol]);
      const z = parseFloat(row[zCol]);
      const plddt = bCol !== -1 && row[bCol] !== '.' && row[bCol] !== '?' ? parseFloat(row[bCol]) : NaN;

      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      cas.push({ chain, resSeq, resName, x, y, z, plddt: Number.isFinite(plddt) ? plddt : 85.0 });
    }

    // Fallback: If B-factors were absent or all default, check for ModelCIF _ma_qa_metric_local
    const needsMetricFallback = cas.length > 0 && cas.every(c => c.plddt === 85.0 || c.plddt === 0.0);
    if (needsMetricFallback && text.includes('_ma_qa_metric_local.')) {
      parseModelCifMetrics(text, cas);
    }

    // Auto-scale 0.0–1.0 pLDDT scale (used in raw AF3/Chai predictions) to 0–100
    if (cas.length > 0) {
      const maxPlddt = Math.max(...cas.map(c => c.plddt));
      if (maxPlddt <= 1.0 && maxPlddt > 0) {
        for (const c of cas) c.plddt *= 100.0;
      }
    }

    return cas;
  }

  // Fallback metric parser for ModelCIF _ma_qa_metric_local table
  function parseModelCifMetrics(text, cas) {
    const match = /loop_\s*(?:#[^\n]*\n\s*)*(_ma_qa_metric_local\.[^\s]+)/i.exec(text);
    if (!match) return;

    let pos = match.index + match[0].lastIndexOf('_ma_qa_metric_local.');
    const len = text.length;

    function nextToken() {
      while (pos < len) {
        const ch = text[pos];
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { pos++; continue; }
        if (ch === '#') { while (pos < len && text[pos] !== '\n') pos++; continue; }
        const start = pos;
        while (pos < len) {
          const c = text[pos];
          if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '#') break;
          pos++;
        }
        return text.slice(start, pos);
      }
      return null;
    }

    const headers = [];
    while (true) {
      const savedPos = pos;
      const tok = nextToken();
      if (!tok || !tok.startsWith('_ma_qa_metric_local.')) {
        pos = savedPos;
        break;
      }
      headers.push(tok.toLowerCase());
    }

    const numCols = headers.length;
    if (!numCols) return;

    const colMap = {};
    for (let i = 0; i < headers.length; i++) colMap[headers[i]] = i;

    const asymCol = colMap['_ma_qa_metric_local.label_asym_id'];
    const seqCol = colMap['_ma_qa_metric_local.label_seq_id'];
    const valCol = colMap['_ma_qa_metric_local.metric_value'];
    if (asymCol === undefined || seqCol === undefined || valCol === undefined) return;

    const metricMap = new Map();
    while (true) {
      const firstTok = nextToken();
      if (!firstTok) break;
      if (firstTok === 'loop_' || firstTok.startsWith('data_') || (firstTok.startsWith('_') && !firstTok.startsWith('_ma_qa_metric_local.'))) break;

      const row = new Array(numCols);
      row[0] = firstTok;
      for (let c = 1; c < numCols; c++) row[c] = nextToken();

      const chain = row[asymCol];
      const seq = parseInt(row[seqCol], 10);
      const val = parseFloat(row[valCol]);
      if (Number.isFinite(val)) {
        metricMap.set(`${chain}_${seq}`, val);
      }
    }

    for (const c of cas) {
      const m = metricMap.get(`${c.chain}_${c.resSeq}`);
      if (m !== undefined) c.plddt = m;
    }
  }

  // Unified parser auto-detecting mmCIF vs PDB format
  function parseStructure(text) {
    const isCif = /^\s*data_\w+/m.test(text) || /^\s*loop_\s*$/m.test(text) || text.includes('_atom_site.');
    return isCif ? parseCif(text) : parsePdb(text);
  }

  // ---------------------------------------------------------------- 3x3 PCA
  // Jacobi eigenvalue decomposition of 3x3 symmetric matrix
  function jacobi3(A) {
    const a = A.slice();
    const V = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let iter = 0; iter < 30; iter++) {
      let p = 0, q = 1, maxOff = Math.abs(a[1]);
      if (Math.abs(a[2]) > maxOff) { p = 0; q = 2; maxOff = Math.abs(a[2]); }
      if (Math.abs(a[5]) > maxOff) { p = 1; q = 2; maxOff = Math.abs(a[5]); }
      if (maxOff < 1e-7) break;
      const app = a[p * 3 + p], aqq = a[q * 3 + q], apq = a[p * 3 + q];
      const theta = 0.5 * Math.atan2(2 * apq, aqq - app);
      const c = Math.cos(theta), s = Math.sin(theta);
      for (let k = 0; k < 3; k++) {
        const v_kp = V[k * 3 + p], v_kq = V[k * 3 + q];
        V[k * 3 + p] = c * v_kp - s * v_kq;
        V[k * 3 + q] = s * v_kp + c * v_kq;
      }
      const a_pp = c * c * app - 2 * s * c * apq + s * s * aqq;
      const a_qq = s * s * app + 2 * s * c * apq + c * c * aqq;
      a[p * 3 + q] = a[q * 3 + p] = 0;
      a[p * 3 + p] = a_pp;
      a[q * 3 + q] = a_qq;
      for (let k = 0; k < 3; k++) {
        if (k === p || k === q) continue;
        const a_kp = a[k * 3 + p], a_kq = a[k * 3 + q];
        a[k * 3 + p] = a[p * 3 + k] = c * a_kp - s * a_kq;
        a[k * 3 + q] = a[q * 3 + k] = s * a_kp + c * a_kq;
      }
    }
    const evals = [
      { val: a[0], vec: [V[0], V[3], V[6]] },
      { val: a[4], vec: [V[1], V[4], V[7]] },
      { val: a[8], vec: [V[2], V[5], V[8]] },
    ];
    evals.sort((x, y) => y.val - x.val);
    return evals;
  }

  // Align coordinates to principal axes:
  // v0 (largest variance) -> Y (up/down)
  // v1 (medium variance)  -> X (left/right)
  // v2 (smallest variance)-> Z (depth)
  function orientCore(coords) {
    const N = coords.length;
    if (!N) return coords;
    const mean = [0, 0, 0];
    for (const p of coords) { mean[0] += p[0]; mean[1] += p[1]; mean[2] += p[2]; }
    mean[0] /= N; mean[1] /= N; mean[2] /= N;

    const cov = new Array(9).fill(0);
    for (const p of coords) {
      const dx = p[0] - mean[0], dy = p[1] - mean[1], dz = p[2] - mean[2];
      cov[0] += dx * dx; cov[1] += dx * dy; cov[2] += dx * dz;
      cov[3] += dy * dx; cov[4] += dy * dy; cov[5] += dy * dz;
      cov[6] += dz * dx; cov[7] += dz * dy; cov[8] += dz * dz;
    }
    for (let k = 0; k < 9; k++) cov[k] /= N;

    const evals = jacobi3(cov);
    let vy = evals[0].vec; // vertical
    let vx = evals[1].vec; // lateral
    let vz = [
      vx[1] * vy[2] - vx[2] * vy[1],
      vx[2] * vy[0] - vx[0] * vy[2],
      vx[0] * vy[1] - vx[1] * vy[0],
    ]; // ensure right-handed

    const out = coords.map(p => {
      const d = sub3(p, mean);
      return [dot3(d, vx), dot3(d, vy), dot3(d, vz)];
    });

    // Determine vertical span and scale
    let minY = Infinity, maxY = -Infinity;
    for (const p of out) {
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    const currentH = Math.max(15, maxY - minY);
    const targetH = 48.0; // target torso height in Ångströms
    const s = clamp(targetH / currentH, 0.45, 2.2);

    // Place bottom of torso at hip level (Y = -15)
    for (const p of out) {
      p[0] *= s;
      p[1] = (p[1] - minY) * s - 15.0;
      p[2] *= s;
    }
    return { coords: out, scale: s };
  }

  // ---------------------------------------------------------------- Arm Detection
  // Finds a contiguous sequence of residues in the custom protein to serve as the punching arm.
  function detectArm(coords, plddts) {
    const N = coords.length;
    // Ideal arm length in amino acids: 24 to 36 residues
    const minL = Math.min(20, Math.max(12, Math.floor(N * 0.1)));
    const maxL = Math.min(36, Math.max(18, Math.floor(N * 0.25)));

    // Measure neighbor density (CAs within 8.5 Å) to penalize core residues
    const neighbors = new Uint16Array(N);
    for (let i = 0; i < N; i++) {
      let count = 0;
      for (let j = 0; j < N; j++) {
        if (i !== j && dist3(coords[i], coords[j]) < 8.5) count++;
      }
      neighbors[i] = count;
    }

    let bestScore = -Infinity;
    let bestRange = [0, Math.min(N - 1, 28)];

    // Evaluate candidate windows
    const candidates = [];
    // 1. N-terminal windows
    for (let l = minL; l <= maxL; l += 4) {
      if (l <= N) candidates.push([0, l - 1, 1.35]); // terminus bonus
    }
    // 2. C-terminal windows
    for (let l = minL; l <= maxL; l += 4) {
      if (l <= N) candidates.push([N - l, N - 1, 1.35]); // terminus bonus
    }
    // 3. Sliding windows across chain
    const step = Math.max(2, Math.floor(N / 40));
    for (let l = minL; l <= maxL; l += 6) {
      for (let i = 0; i + l <= N; i += step) {
        candidates.push([i, i + l - 1, 1.0]);
      }
    }

    for (const [start, end, bonus] of candidates) {
      const len = end - start + 1;
      let protrusion = 0;
      let surfaceScore = 0;
      let avgPlddt = 0;

      for (let k = start; k <= end; k++) {
        const p = coords[k];
        // Bonus for reaching towards +X (lateral/arm side) and +Z (forward)
        protrusion += Math.hypot(p[0], p[2]) + 0.8 * p[0] + 0.5 * p[2];
        surfaceScore += Math.max(0, 16 - neighbors[k]);
        avgPlddt += plddts[k] || 80;
      }
      protrusion /= len;
      surfaceScore /= len;
      avgPlddt /= len;

      // Span distance between arm ends
      const span = dist3(coords[start], coords[end]);

      // Composite fitness score
      const score = (protrusion * 1.5 + surfaceScore * 2.0 + span * 0.8 + (avgPlddt > 50 ? 5 : 0)) * bonus;
      if (score > bestScore) {
        bestScore = score;
        bestRange = [start, end];
      }
    }

    return { start: bestRange[0], end: bestRange[1] };
  }

  // ---------------------------------------------------------------- Procedural Helices (Legs)
  // Generates an ideal alpha helix CA trace with exact CA_STEP bonds (1.5 Å rise, 100° twist)
  function alphaHelix(start, direction, count, phase = 0, ref = [0, 0, 1]) {
    const dir = scale3(direction, 1 / norm3(direction));
    // Perpendicular vectors
    let e1 = [
      ref[1] * dir[2] - ref[2] * dir[1],
      ref[2] * dir[0] - ref[0] * dir[2],
      ref[0] * dir[1] - ref[1] * dir[0],
    ];
    const l1 = norm3(e1);
    if (l1 < 1e-4) e1 = [1, 0, 0]; else e1 = scale3(e1, 1 / l1);
    const e2 = [
      dir[1] * e1[2] - dir[2] * e1[1],
      dir[2] * e1[0] - dir[0] * e1[2],
      dir[0] * e1[1] - dir[1] * e1[0],
    ];

    const rise = 1.50;
    const twist = (100 * Math.PI) / 180;
    const radius = Math.sqrt(CA_STEP * CA_STEP - rise * rise) / (2 * Math.sin(twist / 2));

    const pts = [];
    for (let i = 0; i < count; i++) {
      const angle = phase + i * twist;
      const rVec = add3(scale3(e1, Math.cos(angle)), scale3(e2, Math.sin(angle)));
      const p = add3(add3(start, scale3(dir, i * rise)), scale3(rVec, radius));
      pts.push([round3(p[0]), round3(p[1]), round3(p[2])]);
    }
    return pts;
  }

  const round3 = v => Math.round(v * 1000) / 1000;

  // Generates left and right legs matching humanoid v8 joint geometry (~63 Å leg length)
  function buildLeg(side) {
    // side: -1 for left, +1 for right
    const x = side * 8.5;
    const hipY = -16.0, kneeY = -46.5, ankleY = -78.0;
    const z = -6.0;

    // Thigh: 20 residues from hip down to knee
    const thigh = alphaHelix([x, hipY, z], [0, -1, 0], 20, side < 0 ? 0 : Math.PI);
    // Shin: 21 residues from knee down to ankle
    const shin = alphaHelix([x, kneeY, z], [0, -1, 0], 21, side < 0 ? 1.0 : Math.PI + 1.0);
    // Foot: 11 residues from ankle forward
    const foot = alphaHelix([x, ankleY, z], [0, 0, 1], 11, 0, [0, 1, 0]);

    return { thigh, shin, foot };
  }

  // Signature Feature Detector for Custom Proteins
  function detectProteinFeature(name, rawCas, coreCoords) {
    const upper = (name || '').toUpperCase();

    // Check for beta-barrel or GFP-like
    const isGfpLike = upper.includes('GFP') || upper.includes('RFP') || upper.includes('YFP') ||
                      upper.includes('BFP') || upper.includes('FLUOR') || upper.includes('BARREL') ||
                      upper.includes('PORIN') || upper.includes('AVEN');

    // Check for globin / hemoglobin
    const isGlobinLike = upper.includes('HEMO') || upper.includes('HBA') || upper.includes('HBB') ||
                         upper.includes('GLOBIN') || upper.includes('MYO');

    // Check for disordered / phase-separating
    const isDisordered = upper.includes('FUS') || upper.includes('TDP') || upper.includes('DISORDER') ||
                         upper.includes('LLPS') || upper.includes('IDP');

    const meanPlddt = rawCas.reduce((s, c) => s + c.plddt, 0) / rawCas.length;

    if (isGfpLike) {
      return {
        special: 'barrel_trap',
        title: 'BARREL STUFF',
        description: 'Vortices opponent inside its glowing fluorescent beta-barrel cavity!',
        banner: 'BARREL TRAP!',
        type: 'barrel',
      };
    }
    if (isGlobinLike) {
      return {
        special: 'allosteric_clench',
        title: 'ALLOSTERIC CLAMP',
        description: 'Snaps allosteric subunits shut, crushing opponent with heme energy!',
        banner: 'ALLOSTERIC CLAMP!',
        type: 'clamp',
      };
    }
    if (isDisordered || meanPlddt < 65) {
      return {
        special: 'condensate_trap',
        title: 'CONDENSATE DROPLET',
        description: 'Engulfs opponent inside an amorphous liquid phase separation droplet!',
        banner: 'CONDENSATE TRAP!',
        type: 'condensate',
      };
    }

    return {
      special: 'catalytic_surge',
      title: 'CATALYTIC SURGE',
      description: 'Discharges an intense radial energy wave from its catalytic core!',
      banner: 'CATALYTIC SURGE!',
      type: 'surge',
    };
  }

  // ---------------------------------------------------------------- Dynamic Form Builder
  // Takes raw PDB or mmCIF text and returns a complete floating fighter form object ready for game.js
  function buildCustomFighter(name, structureText) {
    const rawCas = parseStructure(structureText);
    if (!rawCas.length) throw new Error('No CA atoms found in structure');

    // 1. Orient core protein
    const rawCoords = rawCas.map(c => [c.x, c.y, c.z]);
    const rawPlddts = rawCas.map(c => c.plddt);
    const { coords: coreCoords } = orientCore(rawCoords);
    const nCore = coreCoords.length;

    // 2. Automated arm detection on core
    const armRange = detectArm(coreCoords, rawPlddts);
    const armIdx = [];
    for (let i = armRange.start; i <= armRange.end; i++) armIdx.push(i);

    // Identify shoulder, elbow, hand pivots on the detected arm
    const pShoulder = coreCoords[armRange.start].slice();
    const pHand = coreCoords[armRange.end].slice();
    const midIdx = armRange.start + Math.floor((armRange.end - armRange.start) / 2);
    const pElbow = coreCoords[midIdx].slice();

    // Torso domain: all core residues not part of the arm
    const torsoIdx = [];
    for (let i = 0; i < nCore; i++) {
      if (i < armRange.start || i > armRange.end) torsoIdx.push(i);
    }
    // If torso is somehow empty, ensure at least some core residues belong to torso
    if (!torsoIdx.length) torsoIdx.push(0);

    // Left arm: either a mirrored stub/secondary arm, or a modest secondary cluster
    // To maintain compatibility with two-arm guard/motion, create mirrored pivots
    const pLShoulder = [-pShoulder[0], pShoulder[1], pShoulder[2]];
    const pLElbow = [-pElbow[0], pElbow[1], pElbow[2]];
    const pLHand = [-pHand[0], pHand[1], pHand[2]];

    // 3. Floating Protein Structure (pure protein - free floats above floor without artificial legs)
    const allCoords = coreCoords.map(p => [round3(p[0]), round3(p[1]), round3(p[2])]);
    const allPlddts = rawPlddts.slice();
    const chainBreaks = new Set();

    // Internal chain breaks within core protein (multi-chain complexes or missing loops)
    for (let i = 0; i < rawCas.length - 1; i++) {
      const c1 = rawCas[i], c2 = rawCas[i + 1];
      const dx = c2.x - c1.x, dy = c2.y - c1.y, dz = c2.z - c1.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (c1.chain !== c2.chain || d > 7.0) {
        chainBreaks.add(i);
      }
    }

    // Calculate neck/head pivots
    let maxY = -Infinity, headRef = coreCoords[0];
    for (const p of coreCoords) {
      if (p[1] > maxY) { maxY = p[1]; headRef = p; }
    }
    const neckPivot = [headRef[0], maxY - 4.0, headRef[2]];

    const totalN = allCoords.length;

    // Rig data specification for floating fighter
    const rigData = {
      n_ca: totalN,
      ca_res: Array.from({ length: totalN }, (_, i) => i + 1),
      ca_xyz: allCoords,
      chain_breaks: Array.from(chainBreaks),
      base_plddt: allPlddts,
      pivots: {
        rarm_shoulder: pShoulder,
        rarm_elbow: pElbow,
        rarm_hand: pHand,
        larm_shoulder: pLShoulder,
        larm_elbow: pLElbow,
        larm_hand: pLHand,
        lleg_hip: [-8.5, -16.0, -6.0],
        lleg_knee: [-8.5, -46.5, -6.0],
        lleg_ankle: [-8.5, -78.0, -6.0],
        lleg_toe: [-8.5, -80.0, 12.0],
        rleg_hip: [8.5, -16.0, -6.0],
        rleg_knee: [8.5, -46.5, -6.0],
        rleg_ankle: [8.5, -78.0, -6.0],
        rleg_toe: [8.5, -80.0, 12.0],
        neck: neckPivot,
        head_neck: neckPivot,
        head_cranium: [neckPivot[0], neckPivot[1] + 8.0, neckPivot[2]],
      },
      domain_indices: {
        torso: torsoIdx,
        rarm: armIdx,
        larm: [], // single primary arm or mirrored
        lleg_thigh: [],
        lleg_shin: [],
        lleg_foot: [],
        rleg_thigh: [],
        rleg_shin: [],
        rleg_foot: [],
      },
      arm_hinge: 0.12,
      isFloating: true,
    };

    // Calculate mean baseline pLDDT of the actual custom protein
    const coreMeanPlddt = Math.round(rawPlddts.reduce((s, v) => s + v, 0) / rawPlddts.length);
    const feature = detectProteinFeature(name, rawCas, coreCoords);

    return {
      name,
      rigData,
      coreMeanPlddt,
      coreResidues: nCore,
      armRange,
      totalResidues: totalN,
      isFloating: true,
      feature,
    };
  }

  // AlphaFold DB UniProt fetcher
  async function fetchAlphaFoldPdb(uniprotId) {
    const id = uniprotId.trim().toUpperCase();
    const apiUrl = `https://alphafold.ebi.ac.uk/api/prediction/${encodeURIComponent(id)}`;
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`AlphaFold DB API error: HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length || !data[0].pdbUrl) {
      throw new Error(`No AlphaFold model found for UniProt ID: ${id}`);
    }
    const entry = data[0];
    const pdbRes = await fetch(entry.pdbUrl);
    if (!pdbRes.ok) throw new Error(`Failed to download PDB from ${entry.pdbUrl}`);
    const pdbText = await pdbRes.text();
    return {
      pdbText,
      uniprotId: id,
      gene: entry.gene || id,
      desc: entry.uniprotDescription || entry.uniprotId || id,
      plddt: Math.round(entry.globalMetricValue || 0),
    };
  }

  const api = {
    parsePdb,
    parseCif,
    parseStructure,
    orientCore,
    detectArm,
    detectProteinFeature,
    buildCustomFighter,
    fetchAlphaFoldPdb,
  };

  if (typeof window !== 'undefined') {
    window.CustomPdb = api;
  }
  if (typeof module !== 'undefined') {
    module.exports = api;
  }
})();
