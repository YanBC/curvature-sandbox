/*
 * Curvature Sandbox — script.js
 *
 * Modules, in load order:
 *   Utils       math, colour and formatting helpers
 *   Simulation  Newtonian n-body physics + relativity-inspired diagnostics (no DOM, no three.js)
 *   Presets     scenario builders (no DOM, no three.js)
 *   Renderer    three.js scene: bodies, glows, trails, vectors, picking, camera follow
 *   Curvature   warped 3D lattice and embedding-sheet visualisations
 *   UI          DOM panels, body list, inspector, HUD, keyboard and mouse input
 *   App         settings, scenario lifecycle and the frame loop
 *
 * Simulation and Presets can be loaded under Node for headless tests (see the bottom of the file).
 */
'use strict';

/* ════════════════════════════════════════════════════════════════════════════
 * Utils
 * ════════════════════════════════════════════════════════════════════════════ */
const Utils = (() => {
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const randLog = (lo, hi) => Math.exp(rand(Math.log(lo), Math.log(hi)));

  function hexToRgb(hex) {
    const n = parseInt(String(hex).replace('#', ''), 16) || 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function rgbToHex(r, g, b) {
    const h = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
    return '#' + h(r) + h(g) + h(b);
  }
  function mixHex(a, b, t) {
    const A = hexToRgb(a), B = hexToRgb(b);
    return rgbToHex(lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t));
  }
  function hslHex(h, s, l) {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return rgbToHex(f(0), f(8), f(4));
  }
  const randomColor = () => hslHex(rand(0, 360), rand(0.55, 0.85), rand(0.6, 0.72));

  // Clock-rate → colour ramp shared by bodies, grid and legend.
  // rate 1 = flat space (cool blue-white), falling through yellow/orange/red to black at 0.
  const RS_STOPS = [
    [0.0, 0.04, 0.0, 0.0],
    [0.3, 0.72, 0.08, 0.05],
    [0.55, 1.0, 0.42, 0.12],
    [0.75, 1.0, 0.78, 0.42],
    [0.9, 0.86, 0.91, 1.0],
    [1.0, 0.52, 0.76, 1.0],
  ];
  function redshiftColor(rate, out) {
    rate = clamp(rate, 0, 1);
    for (let i = 1; i < RS_STOPS.length; i++) {
      const b = RS_STOPS[i];
      if (rate <= b[0]) {
        const a = RS_STOPS[i - 1];
        const t = (rate - a[0]) / (b[0] - a[0]);
        out[0] = lerp(a[1], b[1], t);
        out[1] = lerp(a[2], b[2], t);
        out[2] = lerp(a[3], b[3], t);
        return out;
      }
    }
    const last = RS_STOPS[RS_STOPS.length - 1];
    out[0] = last[1]; out[1] = last[2]; out[2] = last[3];
    return out;
  }
  function redshiftCss(rate) {
    const c = redshiftColor(rate, [0, 0, 0]);
    return rgbToHex(c[0], c[1], c[2]);
  }
  function redshiftGradientCss() {
    const stops = RS_STOPS.map((s) => `${rgbToHex(s[1], s[2], s[3])} ${s[0] * 100}%`);
    return `linear-gradient(90deg, ${stops.join(', ')})`;
  }

  function fmt(v, digits = 2) {
    if (!Number.isFinite(v)) return v > 0 ? '∞' : '—';
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(1);
    return v.toFixed(digits);
  }

  // Speed of a circular orbit of radius r around mass M under Plummer-softened gravity.
  function circularSpeed(G, M, r, eps) {
    return Math.sqrt((G * M * r * r) / Math.pow(r * r + eps * eps, 1.5));
  }

  return {
    clamp, lerp, smoothstep, rand, randLog, hexToRgb, rgbToHex, mixHex, hslHex, randomColor,
    redshiftColor, redshiftCss, redshiftGradientCss, fmt, circularSpeed,
  };
})();

/* ════════════════════════════════════════════════════════════════════════════
 * Simulation — Newtonian n-body with softening, adaptive leapfrog, clamps, mergers
 * ════════════════════════════════════════════════════════════════════════════ */
const Simulation = (() => {
  const params = {
    G: 1,               // gravitational constant (sim units)
    softening: 0.6,     // Plummer softening length ε
    c: 45,              // "speed of light": speed cap + relativistic visual scale
    collisions: true,   // merge overlapping bodies
    radiusScale: 0.35,  // radius = radiusScale · m^(1/3)  (constant density)
    maxAccel: 5000,     // acceleration clamp
    eta: 0.08,          // adaptive-timestep accuracy factor
    dtMax: 1 / 120,     // largest substep (sim seconds)
    dtMin: 1e-5,        // smallest substep
    maxSubsteps: 400,   // per frame; beyond this the sim runs slower than requested
  };

  const bodies = [];
  const listeners = { merge: [] };
  let nextId = 1;
  let time = 0;
  let version = 0; // bumped on structural changes (add/remove/merge/edit/param); used for energy baselines

  const on = (evt, fn) => listeners[evt].push(fn);
  const emit = (evt, data) => listeners[evt].forEach((fn) => fn(data));
  const touch = () => { version++; };

  const radiusFor = (mass) => Math.max(0.12, params.radiusScale * Math.cbrt(Math.max(mass, 1e-6)));
  const num = (v, fallback = 0) => (Number.isFinite(+v) ? +v : fallback);

  function addBody(o = {}) {
    const id = nextId++;
    const b = {
      id,
      name: (o.name && String(o.name).trim()) || `Body ${id}`,
      mass: Math.max(1e-20, num(o.mass, 1)),
      x: num(o.x), y: num(o.y), z: num(o.z),
      vx: num(o.vx), vy: num(o.vy), vz: num(o.vz),
      ax: 0, ay: 0, az: 0,
      color: o.color || '#8fd3ff',
      pinned: !!o.pinned,
      radius: 0,
      // relativity-inspired diagnostics (updated by updateRelativity)
      tau: 0, phi: 0, gravFactor: 1, velFactor: 1, rate: 1, isBlackHole: false,
    };
    if (b.pinned) b.vx = b.vy = b.vz = 0;
    b.radius = radiusFor(b.mass);
    bodies.push(b);
    touch();
    return b;
  }

  const getBody = (id) => bodies.find((b) => b.id === id) || null;

  function removeBody(id) {
    const i = bodies.findIndex((b) => b.id === id);
    if (i < 0) return null;
    const [b] = bodies.splice(i, 1);
    touch();
    return b;
  }

  function updateBody(id, patch) {
    const b = getBody(id);
    if (!b) return null;
    for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz']) if (Number.isFinite(patch[k])) b[k] = patch[k];
    if (Number.isFinite(patch.mass) && patch.mass > 0) b.mass = patch.mass;
    if (typeof patch.name === 'string' && patch.name.trim()) b.name = patch.name.trim();
    if (typeof patch.color === 'string') b.color = patch.color;
    if (typeof patch.pinned === 'boolean') b.pinned = patch.pinned;
    if (b.pinned) b.vx = b.vy = b.vz = 0;
    b.radius = radiusFor(b.mass);
    touch();
    return b;
  }

  function clear() {
    bodies.length = 0;
    time = 0;
    touch();
  }

  function setParam(key, value) {
    params[key] = value;
    touch();
  }

  /* ── Forces ─────────────────────────────────────────────────────────────── */

  // a_i = Σ_j G m_j (r_j − r_i) / (|r_j − r_i|² + ε²)^(3/2), pairwise (Newton's 3rd law), O(n²).
  function computeAccelerations() {
    const n = bodies.length;
    const G = params.G;
    const eps2 = Math.max(params.softening * params.softening, 1e-6);
    for (let i = 0; i < n; i++) { const b = bodies[i]; b.ax = 0; b.ay = 0; b.az = 0; }
    for (let i = 0; i < n; i++) {
      const A = bodies[i];
      for (let j = i + 1; j < n; j++) {
        const B = bodies[j];
        const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
        const r2 = dx * dx + dy * dy + dz * dz + eps2;
        const inv3 = 1 / (r2 * Math.sqrt(r2));
        const fa = G * B.mass * inv3;
        const fb = G * A.mass * inv3;
        A.ax += dx * fa; A.ay += dy * fa; A.az += dz * fa;
        B.ax -= dx * fb; B.ay -= dy * fb; B.az -= dz * fb;
      }
    }
    const aMax = params.maxAccel;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (b.pinned) { b.ax = 0; b.ay = 0; b.az = 0; continue; }
      const a2 = b.ax * b.ax + b.ay * b.ay + b.az * b.az;
      if (a2 > aMax * aMax) {
        const k = aMax / Math.sqrt(a2);
        b.ax *= k; b.ay *= k; b.az *= k;
      }
    }
  }

  // Keeps every body below 0.99c — a stability guard that doubles as the "cosmic speed limit".
  function clampSpeed(b) {
    const vMax = 0.99 * params.c;
    const v2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
    if (v2 > vMax * vMax) {
      const k = vMax / Math.sqrt(v2);
      b.vx *= k; b.vy *= k; b.vz *= k;
    }
  }

  // Adaptive substep: limited by acceleration (dt ≤ η√(L/|a|)) and by displacement (dt ≤ ½L/|v|,
  // so a body never jumps more than half its size per substep — prevents tunnelling through others).
  function chooseDt() {
    let dt = params.dtMax;
    const eta = params.eta;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.pinned) continue;
      const L = Math.max(params.softening, b.radius);
      const a = Math.sqrt(b.ax * b.ax + b.ay * b.ay + b.az * b.az);
      if (a > 0) dt = Math.min(dt, eta * Math.sqrt(L / a));
      const v = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
      if (v > 0) dt = Math.min(dt, (0.5 * L) / v);
    }
    return Math.max(dt, params.dtMin);
  }

  /* ── Integration ────────────────────────────────────────────────────────── */

  // Advances the simulation by dtTotal using kick-drift-kick leapfrog substeps.
  // Returns { substeps, lag } where lag > 0 means the substep budget ran out (sim ran slow).
  function step(dtTotal) {
    if (!(dtTotal > 0)) return { substeps: 0, lag: 0 };
    if (!bodies.length) { time += dtTotal; return { substeps: 0, lag: 0 }; }

    computeAccelerations();
    let remaining = dtTotal;
    let n = 0;
    while (remaining > 1e-9 && n < params.maxSubsteps) {
      const dt = Math.min(remaining, chooseDt());
      const h = dt * 0.5;
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        if (b.pinned) continue;
        b.vx += b.ax * h; b.vy += b.ay * h; b.vz += b.az * h;   // kick
        b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;   // drift
      }
      computeAccelerations();
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        if (!b.pinned) {
          b.vx += b.ax * h; b.vy += b.ay * h; b.vz += b.az * h; // kick
          clampSpeed(b);
        }
        b.tau += b.rate * dt; // proper time, using the most recent clock rate
      }
      if (params.collisions && resolveCollisions()) computeAccelerations();
      remaining -= dt;
      time += dt;
      n++;
    }
    return { substeps: n, lag: remaining > 1e-9 ? remaining : 0 };
  }

  /* ── Collisions ─────────────────────────────────────────────────────────── */

  function resolveCollisions() {
    let merged = false;
    let again = true;
    while (again) {
      again = false;
      outer: for (let i = 0; i < bodies.length; i++) {
        const A = bodies[i];
        for (let j = i + 1; j < bodies.length; j++) {
          const B = bodies[j];
          const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
          const rr = A.radius + B.radius;
          if (dx * dx + dy * dy + dz * dz < rr * rr) {
            mergePair(A, B);
            merged = again = true;
            break outer;
          }
        }
      }
    }
    return merged;
  }

  // Perfectly inelastic merger: mass adds, momentum is conserved, the merged body sits at the
  // centre of mass and gets a constant-density radius. The heavier body survives (keeps id/name).
  function mergePair(A, B) {
    const big = A.mass >= B.mass ? A : B;
    const small = big === A ? B : A;
    const m = A.mass + B.mass;
    if (A.pinned || B.pinned) {
      const anchor = A.pinned && B.pinned ? big : A.pinned ? A : B;
      big.x = anchor.x; big.y = anchor.y; big.z = anchor.z;
      big.vx = big.vy = big.vz = 0;
      big.pinned = true;
    } else {
      big.x = (A.x * A.mass + B.x * B.mass) / m;
      big.y = (A.y * A.mass + B.y * B.mass) / m;
      big.z = (A.z * A.mass + B.z * B.mass) / m;
      big.vx = (A.vx * A.mass + B.vx * B.mass) / m;
      big.vy = (A.vy * A.mass + B.vy * B.mass) / m;
      big.vz = (A.vz * A.mass + B.vz * B.mass) / m;
    }
    big.tau = (A.tau * A.mass + B.tau * B.mass) / m;
    big.color = Utils.mixHex(big.color, small.color, small.mass / m);
    big.mass = m;
    big.radius = radiusFor(m);
    bodies.splice(bodies.indexOf(small), 1);
    touch();
    emit('merge', { survivor: big, absorbed: small });
  }

  /* ── Relativity-inspired diagnostics (visual only; never feed back into motion) ── */

  // Weak-field clock rate relative to a distant observer:
  //   dτ/dt = √(1 + 2Φ/c²) · √(1 − v²/c²)
  // Φ includes the body's own surface potential (−Gm/R) plus softened potentials of all others.
  function updateRelativity() {
    const n = bodies.length;
    const G = params.G;
    const c2 = params.c * params.c;
    const eps2 = params.softening * params.softening;
    for (let i = 0; i < n; i++) {
      const A = bodies[i];
      let phi = (-G * A.mass) / A.radius;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const B = bodies[j];
        const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
        phi -= (G * B.mass) / Math.sqrt(dx * dx + dy * dy + dz * dz + eps2);
      }
      A.phi = phi;
      const g = 1 + (2 * phi) / c2;
      A.gravFactor = g > 0 ? Math.sqrt(g) : 0;
      const k = 1 - (A.vx * A.vx + A.vy * A.vy + A.vz * A.vz) / c2;
      A.velFactor = k > 0 ? Math.sqrt(k) : 0;
      A.rate = A.gravFactor * A.velFactor;
      A.isBlackHole = (2 * G * A.mass) / c2 >= A.radius; // r_s ≥ R
    }
  }

  function diagnostics() {
    const G = params.G;
    const eps2 = params.softening * params.softening;
    let ke = 0, pe = 0, px = 0, py = 0, pz = 0;
    for (let i = 0; i < bodies.length; i++) {
      const A = bodies[i];
      ke += 0.5 * A.mass * (A.vx * A.vx + A.vy * A.vy + A.vz * A.vz);
      px += A.mass * A.vx; py += A.mass * A.vy; pz += A.mass * A.vz;
      for (let j = i + 1; j < bodies.length; j++) {
        const B = bodies[j];
        const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
        pe -= (G * A.mass * B.mass) / Math.sqrt(dx * dx + dy * dy + dz * dz + eps2);
      }
    }
    return { energy: ke + pe, kinetic: ke, potential: pe, momentum: Math.hypot(px, py, pz) };
  }

  // Shift into the centre-of-mass frame: zero net momentum, COM at the origin.
  // Skipped when bodies are pinned (they define an absolute frame).
  function toComFrame() {
    if (!bodies.length || bodies.some((b) => b.pinned)) return false;
    let m = 0, x = 0, y = 0, z = 0, vx = 0, vy = 0, vz = 0;
    for (const b of bodies) {
      m += b.mass;
      x += b.x * b.mass; y += b.y * b.mass; z += b.z * b.mass;
      vx += b.vx * b.mass; vy += b.vy * b.mass; vz += b.vz * b.mass;
    }
    for (const b of bodies) {
      b.x -= x / m; b.y -= y / m; b.z -= z / m;
      b.vx -= vx / m; b.vy -= vy / m; b.vz -= vz / m;
    }
    touch();
    return true;
  }

  function heaviest(excludeId) {
    let best = null;
    for (const b of bodies) if (b.id !== excludeId && (!best || b.mass > best.mass)) best = b;
    return best;
  }

  function snapshot() {
    return {
      params: { G: params.G, softening: params.softening, c: params.c, collisions: params.collisions },
      bodies: bodies.map(({ name, mass, x, y, z, vx, vy, vz, color, pinned }) =>
        ({ name, mass, x, y, z, vx, vy, vz, color, pinned })),
    };
  }

  function restore(snap) {
    bodies.length = 0;
    Object.assign(params, snap.params);
    snap.bodies.forEach((b) => addBody(b));
    time = 0;
    touch();
  }

  return {
    params, bodies, on, addBody, removeBody, updateBody, getBody, clear, setParam,
    step, updateRelativity, diagnostics, toComFrame, heaviest, snapshot, restore, radiusFor,
    get time() { return time; },
    get version() { return version; },
  };
})();

/* ════════════════════════════════════════════════════════════════════════════
 * Presets — scenario builders. Each returns plain body descriptions.
 * ════════════════════════════════════════════════════════════════════════════ */
const Presets = (() => {
  const DEG = Math.PI / 180;

  // Rotate by inclination i (about x) then by node angle o (about y).
  function rotate(x, y, z, i, o) {
    const y1 = y * Math.cos(i) - z * Math.sin(i);
    const z1 = y * Math.sin(i) + z * Math.cos(i);
    return [x * Math.cos(o) + z1 * Math.sin(o), y1, -x * Math.sin(o) + z1 * Math.cos(o)];
  }

  // A body on a (scaled) circular orbit around `host`. speed = 1 → circular, < 1 → eccentric/infall.
  function orbit(host, r, opt, p) {
    const { incl = 0, node = 0, phase = 0, speed = 1, mass = 1 } = opt;
    const ph = phase * DEG;
    const [px, py, pz] = rotate(r * Math.cos(ph), 0, r * Math.sin(ph), incl * DEG, node * DEG);
    const [dx, dy, dz] = rotate(-Math.sin(ph), 0, Math.cos(ph), incl * DEG, node * DEG);
    const v = Utils.circularSpeed(p.G, host.mass + mass, r, p.softening) * speed;
    return {
      name: opt.name, color: opt.color, mass,
      x: (host.x || 0) + px, y: (host.y || 0) + py, z: (host.z || 0) + pz,
      vx: (host.vx || 0) + dx * v, vy: (host.vy || 0) + dy * v, vz: (host.vz || 0) + dz * v,
    };
  }

  const list = {
    'solar-system': {
      label: 'Solar System',
      params: { G: 1, softening: 0.25, c: 45 },
      camera: { pos: [55, 45, 80], target: [0, 0, 0] },
      build(p) {
        // Real mass ratios (Sun = 1000) and J2000 orbital elements: eccentricity e, inclination i,
        // ascending node Ω and longitude of perihelion ϖ. Semi-major axes are compressed to
        // 12 · a^0.55 (a in AU) so Mercury … Neptune fit on screen: Earth at 12, Neptune at 78.
        // Each planet starts at perihelion r = a(1 − e) with vis-viva speed √(GM(1+e)/r),
        // which traces an ellipse of eccentricity e with the Sun at one focus.
        const sun = { name: 'Sun', mass: 1000, color: '#ffd27a', x: 0, y: 0, z: 0 };
        const planets = [
          { name: 'Mercury', a: 0.387, e: 0.2056, mass: 1.66e-4, color: '#b8b2aa', incl: 7.0, node: 48.3, peri: 77.5 },
          { name: 'Venus', a: 0.723, e: 0.0068, mass: 2.45e-3, color: '#e8c98a', incl: 3.39, node: 76.7, peri: 131.6 },
          { name: 'Earth', a: 1.0, e: 0.0167, mass: 3.0e-3, color: '#4f9dff', incl: 0, node: 0, peri: 102.9 },
          { name: 'Mars', a: 1.524, e: 0.0934, mass: 3.23e-4, color: '#e0603a', incl: 1.85, node: 49.6, peri: 336.1 },
          { name: 'Jupiter', a: 5.203, e: 0.0484, mass: 0.9546, color: '#d9a066', incl: 1.3, node: 100.5, peri: 14.7 },
          { name: 'Saturn', a: 9.537, e: 0.0539, mass: 0.2858, color: '#e8d18f', incl: 2.49, node: 113.7, peri: 92.6 },
          { name: 'Uranus', a: 19.19, e: 0.0473, mass: 0.04366, color: '#9fe3ec', incl: 0.77, node: 74.0, peri: 170.9 },
          { name: 'Neptune', a: 30.07, e: 0.0086, mass: 0.05151, color: '#5b7bff', incl: 1.77, node: 131.8, peri: 44.9 },
        ];
        const squash = (au) => 12 * Math.pow(au, 0.55);
        const out = [sun, ...planets.map((pl) => orbit(sun, squash(pl.a) * (1 - pl.e),
          { ...pl, phase: pl.peri - pl.node, speed: Math.sqrt(1 + pl.e) }, p))];

        // Halley's Comet: q = 0.586 AU, Q = 35.08 AU, i = 162.3° (retrograde), Ω = 58.4°, ω = 111.3°.
        // Its perihelion and aphelion distances go through the same squash map, so it still dips inside
        // Venus's orbit and swings out past Neptune's. The apparent eccentricity drops from 0.967 to
        // ≈ 0.82: keeping 0.967 with the compressed semi-major axis would put perihelion inside the Sun.
        const q = squash(0.586), Q = squash(35.08), e = (Q - q) / (Q + q);
        out.push(orbit(sun, q, {
          name: "Halley's Comet", mass: 1.1e-13, color: '#c8f4ff',
          incl: 162.26, node: 58.42, phase: 111.33, speed: Math.sqrt(1 + e),
        }, p));
        return out;
      },
    },

    'star-system': {
      label: 'Fictional star + planets (with moon & comet)',
      params: { G: 1, softening: 0.25, c: 45 },
      camera: { pos: [62, 48, 88], target: [0, 0, 0] },
      build(p) {
        const sun = { name: 'Sol', mass: 1000, color: '#ffcf6e', x: 0, y: 0, z: 0 };
        const out = [sun];
        const planets = [
          { name: 'Ember', r: 10, mass: 0.4, color: '#d9b99b', incl: 3, phase: 0 },
          { name: 'Dune', r: 16, mass: 1, color: '#e9b872', incl: -3, phase: 120 },
          { name: 'Azure', r: 25, mass: 3, color: '#4f9dff', incl: 1.5, phase: 230 },
          { name: 'Titan', r: 42, mass: 5, color: '#f3a65a', incl: 4, phase: 60 },
          { name: 'Glacier', r: 64, mass: 2, color: '#86e0ff', incl: -7, phase: 300 },
        ];
        for (const pl of planets) out.push(orbit(sun, pl.r, pl, p));
        const azure = out[3];
        out.push(orbit(azure, 1.0, { name: 'Luna', mass: 0.1, color: '#d8d8e0', incl: 12, phase: 40 }, p));
        out.push(orbit(sun, 62, { name: 'Comet', mass: 0.3, color: '#b8f7ff', incl: 28, node: 30, phase: 160, speed: 0.5 }, p));
        return out;
      },
    },

    binary: {
      label: 'Binary star + circumbinary planets',
      params: { G: 1, softening: 0.5, c: 45 },
      camera: { pos: [80, 60, 100], target: [0, 0, 0] },
      build(p) {
        const m = 500, half = 8, d = 2 * half;
        // Each star circles the COM at radius `half`; the pull comes from the other star at distance d.
        const v = Math.sqrt((half * p.G * m * d) / Math.pow(d * d + p.softening ** 2, 1.5));
        const out = [
          { name: 'Castor', mass: m, color: '#9fd0ff', x: half, y: 0, z: 0, vx: 0, vy: 0, vz: v },
          { name: 'Pollux', mass: m, color: '#ffb36b', x: -half, y: 0, z: 0, vx: 0, vy: 0, vz: -v },
        ];
        const com = { mass: 2 * m, x: 0, y: 0, z: 0 };
        out.push(orbit(com, 42, { name: 'Verdant', mass: 6, color: '#8affc1', incl: 8, phase: 30 }, p));
        out.push(orbit(com, 62, { name: 'Rose', mass: 12, color: '#ff8ad8', incl: -14, phase: 200 }, p));
        out.push(orbit(com, 52, { name: 'Polaris', mass: 3, color: '#fff38a', incl: 85, node: 40, phase: 100 }, p));
        return out;
      },
    },

    'figure-eight': {
      label: 'Figure-eight three-body',
      params: { G: 1, softening: 0.15, c: 45 },
      camera: { pos: [20, 26, 38], target: [0, 0, 0] },
      build(p) {
        // Chenciner–Montgomery choreography (G = m = 1), scaled to length L and mass m, tilted 30°.
        const m = 150, L = 14, vs = Math.sqrt((p.G * m) / L), tilt = 30 * DEG;
        const p1 = [0.97000436, -0.24308753], v3 = [-0.93240737, -0.86473146];
        const mk = (name, color, x, z, vx, vz) => {
          const [X, Y, Z] = rotate(x * L, 0, z * L, tilt, 0);
          const [VX, VY, VZ] = rotate(vx * vs, 0, vz * vs, tilt, 0);
          return { name, color, mass: m, x: X, y: Y, z: Z, vx: VX, vy: VY, vz: VZ };
        };
        return [
          mk('Aster', '#ff7b7b', p1[0], p1[1], -v3[0] / 2, -v3[1] / 2),
          mk('Brio', '#74ffbf', -p1[0], -p1[1], -v3[0] / 2, -v3[1] / 2),
          mk('Cielo', '#7ab8ff', 0, 0, v3[0], v3[1]),
        ];
      },
    },

    cluster: {
      label: 'Random cluster (mergers)',
      params: { G: 1, softening: 0.8, c: 45 },
      camera: { pos: [70, 55, 95], target: [0, 0, 0] },
      build(p) {
        const N = 16, R = 35, out = [];
        let total = 0;
        for (let i = 0; i < N; i++) {
          let x, y, z;
          do { x = Utils.rand(-1, 1); y = Utils.rand(-1, 1); z = Utils.rand(-1, 1); } while (x * x + y * y + z * z > 1);
          const mass = Utils.randLog(5, 120);
          total += mass;
          out.push({ name: `C-${i + 1}`, mass, color: Utils.randomColor(), x: x * R, y: y * R * 0.5, z: z * R });
        }
        // Rotation about y (sub-virial, so the cluster collapses and merges), plus random jitter.
        for (const b of out) {
          const r = Math.hypot(b.x, b.y, b.z), rc = Math.hypot(b.x, b.z) || 1;
          const enclosed = total * Math.min(1, (r / R) ** 3);
          const v = 0.75 * Math.sqrt((p.G * enclosed) / Math.max(r, 1));
          b.vx = (-b.z / rc) * v + Utils.rand(-0.5, 0.5);
          b.vy = Utils.rand(-0.5, 0.5);
          b.vz = (b.x / rc) * v + Utils.rand(-0.5, 0.5);
        }
        return out;
      },
    },

    cascade: {
      label: 'Merger cascade',
      params: { G: 1, softening: 0.6, c: 45 },
      camera: { pos: [55, 60, 85], target: [0, 0, 0] },
      build(p) {
        const core = { name: 'Core', mass: 300, color: '#ffd36e', x: 0, y: 0, z: 0 };
        const out = [core];
        for (let k = 0; k < 12; k++) {
          out.push(orbit(core, 32 + Utils.rand(-3, 3), {
            name: `Shard ${k + 1}`, mass: Utils.randLog(6, 25), color: Utils.randomColor(),
            incl: Utils.rand(-8, 8), phase: k * 30, speed: 0.35,
          }, p));
        }
        out.push({ name: 'Hammer', mass: 60, color: '#ff8f6b', x: -50, y: 14, z: 0, vx: 6, vy: 0, vz: 0 });
        out.push({ name: 'Anvil', mass: 60, color: '#9fa8ff', x: 50, y: 14, z: 0, vx: -6, vy: 0, vz: 0 });
        return out;
      },
    },

    'black-hole': {
      label: 'Black-hole forge (low c)',
      params: { G: 1, softening: 0.6, c: 30 },
      camera: { pos: [60, 55, 110], target: [0, 0, 0] },
      build(p) {
        // Two dense stars on an eccentric orbit that collide at first pericentre. Each alone is just
        // below its Schwarzschild limit (deep red); the merged body crosses it.
        const m = 1400, d = 36;
        const vRel = 0.5 * Math.sqrt((p.G * 2 * m) / d);
        const out = [
          { name: 'Alpha', mass: m, color: '#9ec8ff', x: d / 2, y: 0, z: 0, vx: 0, vy: 0, vz: vRel / 2 },
          { name: 'Beta', mass: m, color: '#ffc38a', x: -d / 2, y: 0, z: 0, vx: 0, vy: 0, vz: -vRel / 2 },
        ];
        const com = { mass: 2 * m, x: 0, y: 0, z: 0 };
        out.push(orbit(com, 70, { name: 'Witness I', mass: 4, color: '#8affd6', incl: 10, phase: 90 }, p));
        out.push(orbit(com, 92, { name: 'Witness II', mass: 6, color: '#d3a6ff', incl: -18, phase: 250 }, p));
        return out;
      },
    },

    empty: {
      label: 'Empty space',
      params: { G: 1, softening: 0.6, c: 45 },
      camera: { pos: [60, 45, 80], target: [0, 0, 0] },
      build() { return []; },
    },
  };

  return { list, orbit };
})();

/* ════════════════════════════════════════════════════════════════════════════
 * Renderer — three.js scene for bodies, glows, trails, vectors; picking & camera follow
 * (all three.js objects are created in init() so this file still loads under Node)
 * ════════════════════════════════════════════════════════════════════════════ */
const Renderer = (() => {
  const TRAIL_CAP = 2000;
  const visuals = new Map(); // body id → visual bundle
  const flashes = [];
  const tex = {};
  const rgb = [0, 0, 0], tint = [0, 0, 0];
  let renderer, scene, camera, controls, keyLight, selectSprite, sphereGeo;
  let V1, V2, V3, raycaster, plane, ndc;
  const follow = { id: null, last: null };
  let clock = 0;

  function canvasTexture(size, draw) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    return new THREE.CanvasTexture(c);
  }
  function radialTexture(stops) {
    return canvasTexture(128, (g, s) => {
      const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      for (const [t, a] of stops) grd.addColorStop(t, `rgba(255,255,255,${a})`);
      g.fillStyle = grd;
      g.fillRect(0, 0, s, s);
    });
  }

  function init(container) {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x02040a);
    scene.fog = new THREE.FogExp2(0x02040a, 0.0024); // fades distant grid lines → depth cue

    camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 8000);
    camera.position.set(62, 48, 88);
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    Object.assign(controls, {
      enableDamping: true, dampingFactor: 0.08, screenSpacePanning: true,
      minDistance: 2, maxDistance: 1200, zoomSpeed: 0.9, rotateSpeed: 0.7,
    });

    scene.add(new THREE.AmbientLight(0x6f7f9f, 0.45));
    keyLight = new THREE.PointLight(0xfff2dd, 1.6, 0); // rides on the heaviest body
    scene.add(keyLight);

    sphereGeo = new THREE.SphereGeometry(1, 40, 24);
    tex.glow = radialTexture([[0, 1], [0.18, 0.55], [0.45, 0.12], [1, 0]]);
    tex.halo = radialTexture([[0, 0], [0.3, 0], [0.4, 1], [0.55, 0.25], [1, 0]]);
    tex.ring = canvasTexture(128, (g, s) => {
      g.strokeStyle = 'rgba(255,255,255,0.95)';
      g.lineWidth = 5;
      g.beginPath();
      g.arc(s / 2, s / 2, s / 2 - 8, 0, Math.PI * 2);
      g.stroke();
    });

    selectSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex.ring, transparent: true, depthWrite: false, depthTest: false, fog: false,
    }));
    selectSprite.renderOrder = 10;
    selectSprite.visible = false;
    scene.add(selectSprite);

    buildStarfield();

    V1 = new THREE.Vector3(); V2 = new THREE.Vector3(); V3 = new THREE.Vector3();
    follow.last = new THREE.Vector3();
    raycaster = new THREE.Raycaster();
    plane = new THREE.Plane();
    ndc = new THREE.Vector2();

    window.addEventListener('resize', () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    });
  }

  function buildStarfield() {
    const n = 3000, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      let x, y, z, l;
      do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; l = x * x + y * y + z * z; } while (l > 1 || l < 1e-4);
      const r = (2500 + Math.random() * 1500) / Math.sqrt(l);
      pos.set([x * r, y * r, z * r], i * 3);
      const warm = Math.random(), b = 0.35 + Math.random() * 0.65;
      col.set([b * (0.8 + 0.2 * warm), b * 0.85, b * (1 - 0.25 * warm)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({
      size: 1.6, sizeAttenuation: false, vertexColors: true, fog: false, transparent: true, depthWrite: false,
    })));
  }

  /* ── Per-body visuals ───────────────────────────────────────────────────── */

  function createVisual() {
    const mesh = new THREE.Mesh(sphereGeo, new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0, fog: false }));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex.glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }));

    const pos = new Float32Array(TRAIL_CAP * 3), col = new Float32Array(TRAIL_CAP * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    const trail = new THREE.Line(g, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    trail.frustumCulled = false;

    const vel = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0x4fe3ff);
    const acc = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xff9f43);
    vel.visible = acc.visible = false;

    scene.add(mesh, glow, trail, vel, acc);
    return { mesh, glow, trail, pos, col, count: 0, trailKey: '', vel, acc, hex: '', base: [1, 1, 1] };
  }

  function disposeVisual(v) {
    scene.remove(v.mesh, v.glow, v.trail, v.vel, v.acc);
    v.mesh.material.dispose();
    v.glow.material.dispose();
    v.trail.geometry.dispose();
    v.trail.material.dispose();
    for (const a of [v.vel, v.acc]) { a.line.material.dispose(); a.cone.material.dispose(); }
  }

  // Create visuals for new bodies and drop visuals of removed/merged ones.
  function syncVisuals() {
    const alive = new Set();
    for (const b of Simulation.bodies) {
      alive.add(b.id);
      if (!visuals.has(b.id)) visuals.set(b.id, createVisual());
    }
    for (const [id, v] of visuals) {
      if (!alive.has(id)) { disposeVisual(v); visuals.delete(id); }
    }
  }

  // Base colour, optionally shifted by the time-dilation mapping:
  // blend toward the clock-rate ramp as the clock slows, and dim (fewer photons arrive per second).
  function displayColor(v, b, redshift, out) {
    if (v.hex !== b.color) { v.hex = b.color; v.base = Utils.hexToRgb(b.color); }
    const base = v.base;
    if (!redshift) { out[0] = base[0]; out[1] = base[1]; out[2] = base[2]; return out; }
    Utils.redshiftColor(b.rate, tint);
    const w = Utils.clamp((1 - b.rate) * 2.2, 0, 1);
    const dim = 0.25 + 0.75 * b.rate;
    for (let k = 0; k < 3; k++) out[k] = Utils.lerp(base[k], tint[k], w) * dim;
    return out;
  }

  function update(dt, s) {
    clock += dt;
    syncVisuals();
    const bodies = Simulation.bodies;

    let heavy = null;
    for (const b of bodies) if (!heavy || b.mass > heavy.mass) heavy = b;
    if (heavy) keyLight.position.set(heavy.x, heavy.y, heavy.z);
    keyLight.intensity = heavy ? 1.6 : 0;
    const maxMass = heavy ? heavy.mass : 0;
    // Minimum glow size (~25 px across) so tiny bodies stay visible at any zoom.
    const minGlowPerDist = 0.028 * (55 / camera.fov);

    for (const b of bodies) {
      const v = visuals.get(b.id);
      const luminous = b.mass >= 50 && b.mass >= 0.2 * maxMass;
      const blackHole = s.redshift && b.isBlackHole;
      displayColor(v, b, s.redshift, rgb);

      v.mesh.position.set(b.x, b.y, b.z);
      v.mesh.scale.setScalar(b.radius);
      const mm = v.mesh.material;
      if (blackHole) {
        mm.color.setRGB(0.008, 0.008, 0.01);
        mm.emissive.setRGB(0, 0, 0);
      } else {
        const k = luminous ? 0.95 : 0.12;
        mm.color.setRGB(rgb[0], rgb[1], rgb[2]);
        mm.emissive.setRGB(rgb[0] * k, rgb[1] * k, rgb[2] * k);
      }

      const gm = v.glow.material;
      v.glow.position.copy(v.mesh.position);
      if (blackHole) {
        if (gm.map !== tex.halo) { gm.map = tex.halo; gm.needsUpdate = true; }
        gm.color.setRGB(1, 0.55, 0.2);
        gm.opacity = 0.95;
        v.glow.scale.setScalar(b.radius * 6.5);
      } else {
        if (gm.map !== tex.glow) { gm.map = tex.glow; gm.needsUpdate = true; }
        gm.color.setRGB(rgb[0], rgb[1], rgb[2]);
        const size = b.radius * (luminous ? 7 : 3.2);
        const minSize = camera.position.distanceTo(v.mesh.position) * minGlowPerDist;
        gm.opacity = luminous ? 0.9 : size < minSize ? 0.95 : 0.4;
        v.glow.scale.setScalar(Math.max(size, minSize));
      }

      updateTrail(v, b, s);
      setArrow(v.vel, s.showVectors, b, b.vx, b.vy, b.vz, 0.8, 1);
      setArrow(v.acc, s.showVectors && !b.pinned, b, b.ax, b.ay, b.az, 2.5, 0.5);
    }

    updateSelection(s);
    updateFollow(dt, s);
    updateFlashes(dt);
  }

  // Newest point at index 0, oldest at the end; colours fade with age along the visible length.
  function updateTrail(v, b, s) {
    const len = Utils.clamp(s.trailLength | 0, 0, TRAIL_CAP);
    const key = b.color + '|' + len;
    const posAttr = v.trail.geometry.attributes.position;
    const colAttr = v.trail.geometry.attributes.color;
    if (key !== v.trailKey) {
      v.trailKey = key;
      const base = Utils.hexToRgb(b.color);
      for (let k = 0; k < TRAIL_CAP; k++) {
        const t = k < len ? Math.pow(1 - k / len, 1.4) * 0.85 : 0;
        v.col[k * 3] = base[0] * t; v.col[k * 3 + 1] = base[1] * t; v.col[k * 3 + 2] = base[2] * t;
      }
      colAttr.needsUpdate = true;
    }
    const p = v.pos;
    const dx = b.x - p[0], dy = b.y - p[1], dz = b.z - p[2];
    if (v.count === 0 || dx * dx + dy * dy + dz * dz > 1e-4) {
      p.copyWithin(3, 0, (TRAIL_CAP - 1) * 3);
      p[0] = b.x; p[1] = b.y; p[2] = b.z;
      v.count = Math.min(v.count + 1, TRAIL_CAP);
      posAttr.updateRange.offset = 0;
      posAttr.updateRange.count = Math.min(v.count, Math.max(len, 1)) * 3;
      posAttr.needsUpdate = true;
    }
    v.trail.geometry.setDrawRange(0, Math.min(v.count, len));
    v.trail.visible = s.showTrails && len > 1 && v.count > 1;
  }

  // Arrow length = body radius + scale · |x|^power (capped), so small and large values both read.
  function setArrow(arrow, show, b, x, y, z, scale, power) {
    const mag = Math.sqrt(x * x + y * y + z * z);
    if (!show || mag < 1e-6) { arrow.visible = false; return; }
    arrow.visible = true;
    arrow.position.set(b.x, b.y, b.z);
    V1.set(x / mag, y / mag, z / mag);
    arrow.setDirection(V1);
    const L = b.radius + Math.min(45, scale * Math.pow(mag, power));
    const head = Math.min(L * 0.35, 0.8 + b.radius * 0.4);
    arrow.setLength(L, head, head * 0.55);
  }

  function updateSelection(s) {
    const sel = s.selectedId != null ? Simulation.getBody(s.selectedId) : null;
    selectSprite.visible = !!sel;
    if (!sel) return;
    selectSprite.position.set(sel.x, sel.y, sel.z);
    selectSprite.scale.setScalar(sel.radius * 2.6 + 1.4);
    selectSprite.material.opacity = 0.55 + 0.3 * Math.sin(clock * 4);
    selectSprite.material.color.set(s.followId === sel.id ? 0xffb46b : 0xffffff);
  }

  // Camera follow: translate camera + orbit target with the body (exact), and ease the target
  // onto the body (smooth) so starting to follow doesn't jump.
  function updateFollow(dt, s) {
    const f = s.followId != null ? Simulation.getBody(s.followId) : null;
    if (!f) { follow.id = null; return; }
    V2.set(f.x, f.y, f.z);
    if (follow.id !== f.id) { follow.id = f.id; follow.last.copy(V2); }
    V3.copy(camera.position).sub(controls.target);       // keep orbit offset
    V1.copy(V2).sub(follow.last);                         // body displacement this frame
    controls.target.add(V1).lerp(V2, 1 - Math.exp(-dt * 5));
    camera.position.copy(controls.target).add(V3);
    follow.last.copy(V2);
  }

  /* ── Merge flashes ──────────────────────────────────────────────────────── */

  function flash(x, y, z, size, color) {
    const mk = (map) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      }));
      sp.position.set(x, y, z);
      scene.add(sp);
      return sp;
    };
    flashes.push({ glow: mk(tex.glow), ring: mk(tex.ring), age: 0, dur: 0.9, size });
  }

  function updateFlashes(dt) {
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      f.age += dt;
      const k = f.age / f.dur;
      if (k >= 1) {
        for (const sp of [f.glow, f.ring]) { scene.remove(sp); sp.material.dispose(); }
        flashes.splice(i, 1);
        continue;
      }
      const ease = 1 - Math.pow(1 - k, 3);
      f.glow.scale.setScalar(f.size * (0.4 + 0.8 * ease));
      f.glow.material.opacity = (1 - k) * (1 - k);
      f.ring.scale.setScalar(f.size * (0.2 + 1.6 * ease));
      f.ring.material.opacity = (1 - k) * 0.8;
    }
  }

  /* ── Picking & placement ────────────────────────────────────────────────── */

  // Screen-space pick with a generous minimum radius so tiny bodies are still clickable.
  function pick(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    let best = null, bestDist = Infinity;
    for (const b of Simulation.bodies) {
      V1.set(b.x, b.y, b.z);
      const camDist = V1.distanceTo(camera.position);
      V1.project(camera);
      if (V1.z > 1 || V1.z < -1) continue; // behind the camera / clipped
      const sx = rect.left + ((V1.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - V1.y) / 2) * rect.height;
      const rPx = (b.radius / (camDist * tanHalf)) * (rect.height / 2);
      const d = Math.hypot(sx - clientX, sy - clientY);
      if (d <= Math.max(rPx, 10) + 4 && camDist < bestDist) { best = b; bestDist = camDist; }
    }
    return best ? best.id : null;
  }

  // Intersection of the mouse ray with the horizontal plane through the orbit target.
  function placementPoint(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    plane.set(V1.set(0, 1, 0), -controls.target.y);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    return hit.distanceTo(camera.position) < 1500 ? hit : null;
  }

  function clearTrail(id) {
    const v = visuals.get(id);
    if (v) v.count = 0;
  }

  function setCamera(pos, target) {
    camera.position.set(pos[0], pos[1], pos[2]);
    controls.target.set(target[0], target[1], target[2]);
    controls.update();
  }

  function render() {
    controls.update();
    renderer.render(scene, camera);
  }

  return {
    init, update, render, pick, placementPoint, flash, clearTrail, setCamera,
    get scene() { return scene; },
    get target() { return controls.target; },
    get domElement() { return renderer.domElement; },
  };
})();

/* ════════════════════════════════════════════════════════════════════════════
 * Curvature — "spacetime" visualisations driven by each body's Schwarzschild radius
 *   lattice: a 3D grid whose vertices are pulled toward masses
 *   sheet:   an embedding-diagram style surface below the system, with drop lines
 * Both are coloured by the same clock-rate ramp as the bodies.
 * ════════════════════════════════════════════════════════════════════════════ */
const Curvature = (() => {
  const SPACING = 10;       // lattice cell size
  const SHEET_HALF = 90;    // sheet half-extent
  const SHEET_Y = -16;      // sheet rest height
  const LATTICE_K = 50;     // visual exaggeration of lattice pull
  const SHEET_K = 80;       // visual exaggeration of sheet depth
  const SHEET_MAX = 55;     // asymptotic max sheet depth
  const DROP_CAP = 128;
  const DENSITY = { low: { n: 9, sheetN: 46 }, med: { n: 13, sheetN: 61 }, high: { n: 17, sheetN: 91 } };

  let scene = null, lattice = null, sheet = null, drops = null, builtFor = '';
  // Per-body scratch arrays (structure-of-arrays for the inner loops).
  let cap = 0, bx, by, bz, bS, bSK, bGM, bA2, bA2s;
  const col = [0, 0, 0];

  function init(s) { scene = s; }

  function lineSet(vertexCount, indices) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(vertexCount * 3), colr = new Float32Array(vertexCount * 3);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(colr, 3).setUsage(THREE.DynamicDrawUsage));
    if (indices) g.setIndex(indices);
    const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    line.frustumCulled = false;
    scene.add(line);
    return { line, pos, col: colr, geo: g };
  }

  function dispose(set) {
    scene.remove(set.line);
    set.geo.dispose();
    set.line.material.dispose();
  }

  function build(density) {
    const d = DENSITY[density] || DENSITY.med;
    for (const set of [lattice, sheet, drops]) if (set) dispose(set);

    // Lattice: n³ shared vertices, segments along x, y and z (indexed).
    const n = d.n, half = ((n - 1) / 2) * SPACING, count = n * n * n;
    const base = new Float32Array(count * 3), idx = [];
    const id = (i, j, k) => (i * n + j) * n + k;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
      const v = id(i, j, k);
      base[v * 3] = -half + i * SPACING;
      base[v * 3 + 1] = -half + j * SPACING;
      base[v * 3 + 2] = -half + k * SPACING;
      if (i < n - 1) idx.push(v, id(i + 1, j, k));
      if (j < n - 1) idx.push(v, id(i, j + 1, k));
      if (k < n - 1) idx.push(v, id(i, j, k + 1));
    }
    lattice = Object.assign(lineSet(count, idx), { base, half, count });

    // Sheet: N × N grid in the xz-plane.
    const N = d.sheetN, step = (2 * SHEET_HALF) / (N - 1), sc = N * N;
    const sbase = new Float32Array(sc * 2), sidx = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const v = i * N + j;
      sbase[v * 2] = -SHEET_HALF + i * step;
      sbase[v * 2 + 1] = -SHEET_HALF + j * step;
      if (i < N - 1) sidx.push(v, v + N);
      if (j < N - 1) sidx.push(v, v + 1);
    }
    sheet = Object.assign(lineSet(sc, sidx), { base: sbase, count: sc, step });

    drops = lineSet(DROP_CAP * 2, null);
    builtFor = density;
  }

  function prepare(bodies, p, s) {
    const n = bodies.length;
    if (n > cap) {
      cap = Math.max(n, 32);
      [bx, by, bz, bS, bSK, bGM, bA2, bA2s] = Array.from({ length: 8 }, () => new Float64Array(cap));
    }
    const c2 = p.c * p.c;
    for (let j = 0; j < n; j++) {
      const b = bodies[j];
      const rs = (2 * p.G * b.mass) / c2; // Schwarzschild radius in sim units
      bx[j] = b.x; by[j] = b.y; bz[j] = b.z;
      bS[j] = s.curvatureScale * LATTICE_K * rs;
      bSK[j] = s.curvatureScale * SHEET_K * rs;
      bGM[j] = p.G * b.mass;
      const a = Math.max(b.radius, p.softening);
      bA2[j] = a * a;
      bA2s[j] = (b.radius + 2) * (b.radius + 2);
    }
    return n;
  }

  // Shared vertex shading: clock-rate ramp (time-dilation mode) or plain cyan by deformation.
  function shade(C, i3, phi, amount, c2, fade, redshift) {
    if (redshift) {
      const g = 1 + (2 * phi) / c2;
      const rate = g > 0 ? Math.sqrt(g) : 0;
      Utils.redshiftColor(rate, col);
      const k = fade * Math.min(1.1, 0.16 + 2.0 * Math.pow(1 - rate, 0.6));
      C[i3] = col[0] * k; C[i3 + 1] = col[1] * k; C[i3 + 2] = col[2] * k;
    } else {
      const k = fade * Math.min(1, 0.16 + amount * 0.12);
      C[i3] = 0.25 * k; C[i3 + 1] = 0.7 * k; C[i3 + 2] = 1.0 * k;
    }
  }

  // Each body pulls a vertex toward itself by  r · s / (s + r²)  (s ∝ r_s): ≈ s/r far away,
  // never more than r up close, so vertices bunch into wells without passing through the mass.
  function updateLattice(n, target, p, redshift) {
    const { base, pos, col: C, count, half } = lattice;
    const cx = Math.round(target.x / SPACING) * SPACING;
    const cy = Math.round(target.y / SPACING) * SPACING;
    const cz = Math.round(target.z / SPACING) * SPACING;
    const c2 = p.c * p.c, maxD = SPACING * 2.2;
    for (let v = 0; v < count; v++) {
      const i3 = v * 3;
      const lx = base[i3], ly = base[i3 + 1], lz = base[i3 + 2];
      const px = cx + lx, py = cy + ly, pz = cz + lz;
      let dx = 0, dy = 0, dz = 0, phi = 0;
      for (let j = 0; j < n; j++) {
        const ex = bx[j] - px, ey = by[j] - py, ez = bz[j] - pz;
        const r2 = ex * ex + ey * ey + ez * ez;
        const f = bS[j] / (bS[j] + r2 + 1e-9);
        dx += ex * f; dy += ey * f; dz += ez * f;
        phi -= bGM[j] / Math.sqrt(r2 + bA2[j]);
      }
      let dm = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dm > maxD) { const k = maxD / dm; dx *= k; dy *= k; dz *= k; dm = maxD; }
      pos[i3] = px + dx; pos[i3 + 1] = py + dy; pos[i3 + 2] = pz + dz;
      const edge = Math.max(Math.abs(lx), Math.abs(ly), Math.abs(lz)) / half;
      shade(C, i3, phi, dm, c2, 1 - 0.85 * Utils.smoothstep(0.45, 1, edge), redshift);
    }
    lattice.geo.attributes.position.needsUpdate = true;
    lattice.geo.attributes.color.needsUpdate = true;
  }

  function sheetDepthAt(n, x, z) {
    let depth = 0;
    for (let j = 0; j < n; j++) {
      const ex = bx[j] - x, ez = bz[j] - z;
      depth += bSK[j] / Math.sqrt(ex * ex + ez * ez + bA2s[j]);
    }
    return SHEET_MAX * (1 - Math.exp(-depth / SHEET_MAX)); // soft cap
  }

  function updateSheet(n, target, p, redshift) {
    const { base, pos, col: C, count, step } = sheet;
    const cx = Math.round(target.x / step) * step, cz = Math.round(target.z / step) * step;
    const c2 = p.c * p.c;
    for (let v = 0; v < count; v++) {
      const lx = base[v * 2], lz = base[v * 2 + 1];
      const px = cx + lx, pz = cz + lz;
      let depth = 0, phi = 0;
      for (let j = 0; j < n; j++) {
        const ex = bx[j] - px, ez = bz[j] - pz;
        const inv = 1 / Math.sqrt(ex * ex + ez * ez + bA2s[j]);
        depth += bSK[j] * inv;
        phi -= bGM[j] * inv;
      }
      depth = SHEET_MAX * (1 - Math.exp(-depth / SHEET_MAX));
      const i3 = v * 3;
      pos[i3] = px; pos[i3 + 1] = SHEET_Y - depth; pos[i3 + 2] = pz;
      const rr = Math.sqrt(lx * lx + lz * lz) / SHEET_HALF;
      shade(C, i3, phi, depth * 0.6, c2, 1 - Utils.smoothstep(0.5, 1, rr), redshift);
    }
    sheet.geo.attributes.position.needsUpdate = true;
    sheet.geo.attributes.color.needsUpdate = true;

    // Drop lines: from each body straight down to its well — shows height above the sheet.
    const m = Math.min(n, DROP_CAP);
    const P = drops.pos, D = drops.col;
    for (let j = 0; j < m; j++) {
      const o = j * 6;
      P[o] = bx[j]; P[o + 1] = by[j]; P[o + 2] = bz[j];
      P[o + 3] = bx[j]; P[o + 4] = SHEET_Y - sheetDepthAt(n, bx[j], bz[j]); P[o + 5] = bz[j];
      D[o] = 0.3; D[o + 1] = 0.38; D[o + 2] = 0.5;
      D[o + 3] = 0.05; D[o + 4] = 0.07; D[o + 5] = 0.1;
    }
    drops.geo.setDrawRange(0, m * 2);
    drops.geo.attributes.position.needsUpdate = true;
    drops.geo.attributes.color.needsUpdate = true;
  }

  function update(bodies, p, s, target) {
    if (builtFor !== s.gridDensity) build(s.gridDensity);
    const showL = s.showCurvature && s.curvatureMode !== 'sheet';
    const showS = s.showCurvature && s.curvatureMode !== 'lattice';
    lattice.line.visible = showL;
    sheet.line.visible = showS;
    drops.line.visible = showS;
    if (!showL && !showS) return;
    const n = prepare(bodies, p, s);
    if (showL) updateLattice(n, target, p, s.redshift);
    if (showS) updateSheet(n, target, p, s.redshift);
  }

  return { init, update };
})();

/* ════════════════════════════════════════════════════════════════════════════
 * UI — panels, list, inspector, HUD, keyboard & pointer input
 * ════════════════════════════════════════════════════════════════════════════ */
const UI = (() => {
  const $ = (id) => document.getElementById(id);
  const bindings = []; // { sync() } for controls mirrored from state
  let A = null;        // App API
  let listSig = '';
  let refreshAcc = 0;
  let inspectedId = null;
  let inspectorDirty = false;
  let statusTimer = 0;

  const INSPECT_FIELDS = ['x', 'y', 'z', 'vx', 'vy', 'vz'];

  /* ── Control binding helpers ────────────────────────────────────────────── */

  function setFill(input) {
    const t = (input.value - input.min) / (input.max - input.min);
    input.style.setProperty('--fill', `${Utils.clamp(t, 0, 1) * 100}%`);
  }

  function range(id, get, set, show) {
    const input = $(id), out = document.querySelector(`output[for="${id}"]`);
    const sync = () => { input.value = get(); out.textContent = show(+input.value); setFill(input); };
    input.addEventListener('input', () => { set(+input.value); out.textContent = show(+input.value); setFill(input); });
    bindings.push({ sync });
  }
  function check(id, get, set) {
    const input = $(id);
    input.addEventListener('change', () => set(input.checked));
    bindings.push({ sync: () => { input.checked = get(); } });
  }
  function select(id, key) {
    const input = $(id);
    input.addEventListener('change', () => { A.settings[key] = input.value; });
    bindings.push({ sync: () => { input.value = A.settings[key]; } });
  }
  function syncControls() {
    bindings.forEach((b) => b.sync());
    syncPause();
  }

  /* ── Init ───────────────────────────────────────────────────────────────── */

  function init(app) {
    A = app;
    const S = A.settings, P = Simulation.params;

    const presetSel = $('preset');
    for (const [key, p] of Object.entries(Presets.list)) presetSel.add(new Option(p.label, key));
    presetSel.addEventListener('change', () => A.loadPreset(presetSel.value));

    $('btn-pause').onclick = () => A.togglePause();
    $('btn-step').onclick = () => A.stepOnce();
    $('btn-reset').onclick = () => A.reset();
    $('btn-mark').onclick = () => A.markStart();
    $('btn-help').onclick = () => toggleHelp();
    $('help-close').onclick = () => toggleHelp(false);
    $('help').addEventListener('click', (e) => { if (e.target.id === 'help') toggleHelp(false); });
    $('btn-left').onclick = () => togglePanel('left');
    $('btn-right').onclick = () => togglePanel('right');
    if (window.innerWidth < 900) document.body.classList.add('hide-left', 'hide-right');
    // Panels sit just below the top bar, whose height changes when it wraps on narrow screens.
    const topbar = document.querySelector('.topbar');
    const syncTop = () => document.documentElement.style.setProperty('--top', `${topbar.offsetHeight + 6}px`);
    new ResizeObserver(syncTop).observe(topbar);
    syncTop();

    range('s-g', () => P.G, (v) => Simulation.setParam('G', v), (v) => v.toFixed(2));
    range('s-speed', () => S.simSpeed, (v) => { S.simSpeed = v; }, (v) => v.toFixed(2) + '×');
    range('s-soft', () => P.softening, (v) => Simulation.setParam('softening', v), (v) => v.toFixed(2));
    range('s-c', () => P.c, (v) => Simulation.setParam('c', v), (v) => v.toFixed(0));
    range('s-curv', () => S.curvatureScale, (v) => { S.curvatureScale = v; }, (v) => v.toFixed(1) + '×');
    range('s-trail', () => S.trailLength, (v) => { S.trailLength = v | 0; }, (v) => (v | 0) + ' pts');
    check('t-merge', () => P.collisions, (v) => Simulation.setParam('collisions', v));
    check('t-curv', () => S.showCurvature, (v) => { S.showCurvature = v; });
    check('t-trails', () => S.showTrails, (v) => { S.showTrails = v; });
    check('t-vectors', () => S.showVectors, (v) => { S.showVectors = v; });
    check('t-redshift', () => S.redshift, (v) => { S.redshift = v; });
    select('sel-curv', 'curvatureMode');
    select('sel-density', 'gridDensity');
    $('btn-com').onclick = () => status(Simulation.toComFrame()
      ? 'Moved to the centre-of-mass frame'
      : 'Not possible while bodies are pinned (or there are none)', !Simulation.bodies.length || Simulation.bodies.some((b) => b.pinned));

    // Add-body form
    $('a-color').value = Utils.randomColor();
    $('a-orbit').addEventListener('change', syncOrbitLock);
    $('a-pinned').addEventListener('change', syncOrbitLock);
    $('btn-rand').onclick = randomizeAddForm;
    $('btn-add').onclick = () => A.addFromForm(null);
    syncOrbitLock();

    // Body list
    $('body-list').addEventListener('click', onListClick);
    $('btn-clear').onclick = () => A.clearAll();

    // Inspector
    const insp = $('inspector');
    insp.addEventListener('input', () => setDirty(true));
    insp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') applyInspector(); });
    $('insp-pinned').addEventListener('change', () => setDirty(true));
    $('btn-apply').onclick = applyInspector;
    $('btn-revert').onclick = () => populateInspector();
    $('btn-follow').onclick = () => A.toggleFollow(S.selectedId);
    $('btn-del').onclick = () => A.removeBody(S.selectedId);

    $('legend-bar').style.background = Utils.redshiftGradientCss();

    bindPointer();
    bindKeyboard();

    // Mouse clicks shouldn't leave focus on buttons/switches/sliders, so Space keeps meaning "pause".
    document.addEventListener('pointerup', () => setTimeout(() => {
      const el = document.activeElement;
      if (el && (el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && /^(checkbox|range)$/.test(el.type)))) el.blur();
    }, 0));

    syncControls();
  }

  /* ── Add-body form ──────────────────────────────────────────────────────── */

  function syncOrbitLock() {
    const locked = $('a-orbit').checked && !$('a-pinned').checked;
    $('a-vel').classList.toggle('locked', locked);
    for (const k of ['a-vx', 'a-vy', 'a-vz']) $(k).disabled = locked;
  }

  function readAddForm() {
    const num = (id) => parseFloat($(id).value);
    return {
      name: $('a-name').value.trim(),
      mass: num('a-mass'),
      color: $('a-color').value,
      x: num('a-x'), y: num('a-y'), z: num('a-z'),
      vx: num('a-vx'), vy: num('a-vy'), vz: num('a-vz'),
      orbit: $('a-orbit').checked,
      pinned: $('a-pinned').checked,
    };
  }

  function fillAddVelocity(v) {
    ['a-vx', 'a-vy', 'a-vz'].forEach((id, i) => { $(id).value = +v[i].toFixed(3); });
  }

  function afterAdd() {
    $('a-name').value = '';
    $('a-color').value = Utils.randomColor();
  }

  function randomizeAddForm() {
    const r = Utils.rand(12, 60), ang = Utils.rand(0, Math.PI * 2);
    $('a-x').value = (r * Math.cos(ang)).toFixed(2);
    $('a-y').value = Utils.rand(-4, 4).toFixed(2);
    $('a-z').value = (r * Math.sin(ang)).toFixed(2);
    $('a-mass').value = Utils.randLog(0.5, 40).toFixed(2);
    $('a-color').value = Utils.randomColor();
    $('a-orbit').checked = true;
    $('a-pinned').checked = false;
    syncOrbitLock();
  }

  /* ── Body list ──────────────────────────────────────────────────────────── */

  function renderList(force) {
    const S = A.settings;
    const bodies = Simulation.bodies;
    const ul = $('body-list');
    const sig = bodies.map((b) => `${b.id}:${b.name}:${b.color}`).join('|') + `#${S.selectedId}#${S.followId}`;
    if (force || sig !== listSig) {
      listSig = sig;
      ul.textContent = '';
      for (const b of bodies) {
        const li = document.createElement('li');
        li.className = 'body-row' + (b.id === S.selectedId ? ' selected' : '') + (b.id === S.followId ? ' following' : '');
        li.dataset.id = b.id;
        li.innerHTML =
          '<span class="swatch"></span><span class="nm"></span><span class="num ms"></span>' +
          '<span class="num rt"><i class="dot"></i><span></span></span>' +
          '<span class="acts"><button class="icon" data-act="follow" title="Follow">◎</button>' +
          '<button class="icon del" data-act="del" title="Delete">✕</button></span>';
        li.querySelector('.swatch').style.setProperty('--c', b.color);
        li.querySelector('.nm').textContent = b.name;
        ul.appendChild(li);
      }
      $('body-count').textContent = bodies.length;
      $('empty-hint').hidden = bodies.length > 0;
      $('btn-clear').hidden = bodies.length === 0;
    }
    // Live numbers
    const rows = ul.children;
    for (let i = 0; i < rows.length; i++) {
      const b = bodies[i];
      if (!b) break;
      rows[i].querySelector('.ms').textContent = b.mass >= 10 ? b.mass.toFixed(0) : b.mass >= 0.01 ? b.mass.toFixed(2) : b.mass.toExponential(1);
      rows[i].querySelector('.rt span').textContent = b.isBlackHole ? 'BH' : b.rate.toFixed(3);
      rows[i].querySelector('.dot').style.setProperty('--d', b.isBlackHole ? '#000' : Utils.redshiftCss(b.rate));
    }
  }

  function onListClick(e) {
    const li = e.target.closest('.body-row');
    if (!li) return;
    const id = +li.dataset.id;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'del') A.removeBody(id);
    else if (act === 'follow') A.toggleFollow(id);
    else A.select(id);
  }

  /* ── Inspector ──────────────────────────────────────────────────────────── */

  function setDirty(v) {
    inspectorDirty = v;
    $('insp-dirty').hidden = !v;
  }

  // Fill the editable fields from the live body (discarding edits).
  function populateInspector() {
    const b = Simulation.getBody(A.settings.selectedId);
    $('inspector').hidden = !b;
    $('insp-empty').hidden = !!b;
    inspectedId = b ? b.id : null;
    setDirty(false);
    if (!b) return;
    $('insp-name').value = b.name;
    $('insp-color').value = b.color;
    $('insp-pinned').checked = b.pinned;
    writeLiveFields(b);
    refreshReadouts();
  }

  function writeLiveFields(b) {
    $('insp-mass').value = +b.mass.toPrecision(6);
    for (const k of INSPECT_FIELDS) $('insp-' + k).value = +b[k].toFixed(3);
  }

  function applyInspector() {
    const b = Simulation.getBody(A.settings.selectedId);
    if (!b) return;
    const num = (id) => parseFloat($(id).value);
    const patch = {
      name: $('insp-name').value,
      color: $('insp-color').value,
      mass: num('insp-mass'),
      pinned: $('insp-pinned').checked,
    };
    for (const k of INSPECT_FIELDS) patch[k] = num('insp-' + k);
    if (!(patch.mass > 0)) { status('Mass must be greater than 0', true); return; }
    const moved = ['x', 'y', 'z'].some((k) => Math.abs(patch[k] - b[k]) > 1e-3);
    Simulation.updateBody(b.id, patch);
    if (moved) Renderer.clearTrail(b.id);
    populateInspector();
    status(`Updated ${b.name}`);
  }

  function refreshReadouts() {
    const S = A.settings;
    const b = Simulation.getBody(S.selectedId);
    if (!b) return;
    if (!inspectorDirty && document.activeElement?.closest?.('#inspector') == null) writeLiveFields(b);
    const P = Simulation.params;
    const v = Math.hypot(b.vx, b.vy, b.vz), a = Math.hypot(b.ax, b.ay, b.az);
    const rs = (2 * P.G * b.mass) / (P.c * P.c);
    $('r-speed').textContent = `${Utils.fmt(v)}  (${Utils.fmt((v / P.c) * 100, 1)}% c)`;
    $('r-acc').textContent = Utils.fmt(a);
    $('r-radius').textContent = `${Utils.fmt(b.radius)} · ${Utils.fmt(rs)}`;
    $('r-phi').textContent = Utils.fmt(b.phi, 1);
    $('r-gf').textContent = b.gravFactor.toFixed(4);
    $('r-gamma').textContent = b.velFactor > 0 ? (1 / b.velFactor).toFixed(4) : '∞';
    $('r-rate').textContent = b.rate.toFixed(4);
    $('r-z').textContent = b.rate > 0 ? Utils.fmt(1 / b.rate - 1, 4) : '∞';
    $('r-tau').textContent = `${Utils.fmt(b.tau, 2)}  (t = ${Utils.fmt(Simulation.time, 2)})`;
    $('insp-badge').hidden = !b.isBlackHole;
    $('btn-follow').classList.toggle('active', S.followId === b.id);
    $('btn-follow').textContent = S.followId === b.id ? 'Unfollow' : 'Follow';
  }

  /* ── HUD & status ───────────────────────────────────────────────────────── */

  function refreshHud() {
    const st = A.stats;
    $('h-fps').textContent = Math.round(st.fps);
    $('h-bodies').textContent = Simulation.bodies.length;
    $('h-time').textContent = Utils.fmt(Simulation.time, 1);
    $('h-steps').textContent = st.substeps;
    $('h-steps').classList.toggle('bad', st.lag > 0);
    const drift = A.energyDrift();
    $('h-energy').textContent = Simulation.bodies.length > 1 ? `${drift >= 0 ? '+' : ''}${Utils.fmt(drift * 100, 3)}%` : '–';
    $('h-energy').classList.toggle('bad', Math.abs(drift) > 0.01);
    $('h-mom').textContent = Utils.fmt(st.momentum, 2);
    if (st.lag > 0 && !A.settings.paused && performance.now() > statusTimer) {
      showStatus('Close encounter: substep budget reached — running slower than requested', true, 600);
    }
  }

  function showStatus(msg, warn, ms) {
    const el = $('h-status');
    el.textContent = msg;
    el.classList.toggle('warn', !!warn);
    el.classList.add('show');
    clearTimeout(showStatus.t);
    showStatus.t = setTimeout(() => el.classList.remove('show'), ms);
  }

  function status(msg, warn = false) {
    statusTimer = performance.now() + 2500;
    showStatus(msg, warn, 2500);
  }

  function syncPause() {
    const paused = A.settings.paused;
    $('btn-pause').textContent = paused ? '▶ Resume' : '❚❚ Pause';
    document.body.classList.toggle('paused', paused);
  }

  // On narrow screens only one panel is open at a time.
  function togglePanel(side) {
    const cls = document.body.classList;
    const opening = cls.contains('hide-' + side);
    cls.toggle('hide-' + side, !opening);
    if (opening && window.innerWidth < 900) cls.add(side === 'left' ? 'hide-right' : 'hide-left');
  }

  function toggleHelp(force) {
    const el = $('help');
    el.hidden = force === undefined ? !el.hidden : !force;
  }

  /* ── Input ──────────────────────────────────────────────────────────────── */

  function bindPointer() {
    const canvas = Renderer.domElement;
    let down = null;
    canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, shift: e.shiftKey, button: e.button };
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!d || d.button !== 0 || e.button !== 0) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return; // it was a drag
      if (d.shift) {
        const p = Renderer.placementPoint(e.clientX, e.clientY);
        if (p) A.addFromForm(p);
        else status('Aim at the horizontal plane to place a body', true);
        return;
      }
      A.select(Renderer.pick(e.clientX, e.clientY));
    });
    canvas.addEventListener('dblclick', (e) => {
      const id = Renderer.pick(e.clientX, e.clientY);
      if (id != null) A.toggleFollow(id, true);
    });
  }

  function bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') {
        if (e.key === 'Escape') t.blur();
        return;
      }
      if (t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const S = A.settings;
      switch (e.key) {
        case ' ': A.togglePause(); break;
        case 'n': case 'N': A.stepOnce(); break;
        case 'r': case 'R': A.reset(); break;
        case 'c': case 'C': S.showCurvature = !S.showCurvature; syncControls(); break;
        case 't': case 'T': S.showTrails = !S.showTrails; syncControls(); break;
        case 'v': case 'V': S.showVectors = !S.showVectors; syncControls(); break;
        case 'd': case 'D': S.redshift = !S.redshift; syncControls(); break;
        case 'f': case 'F': if (S.selectedId != null) A.toggleFollow(S.selectedId); break;
        case 'Delete': case 'Backspace': if (S.selectedId != null) A.removeBody(S.selectedId); break;
        case 'Escape':
          if (!$('help').hidden) toggleHelp(false);
          else if (S.followId != null) A.toggleFollow(null);
          else A.select(null);
          break;
        case 'h': case 'H': case '?': toggleHelp(); break;
        default: return;
      }
      e.preventDefault();
    });
  }

  /* ── Frame tick ─────────────────────────────────────────────────────────── */

  function tick(dt) {
    refreshAcc += dt;
    if (refreshAcc < 0.2) return;
    refreshAcc = 0;
    renderList(false);
    if (inspectedId !== A.settings.selectedId) populateInspector();
    else refreshReadouts();
    refreshHud();
  }

  // Immediate refresh after structural changes (select/add/remove/reset).
  function refresh() {
    renderList(false);
    if (inspectedId !== A.settings.selectedId) populateInspector();
  }

  return { init, syncControls, syncPause, readAddForm, fillAddVelocity, afterAdd, populateInspector, refresh, status, tick };
})();

/* ════════════════════════════════════════════════════════════════════════════
 * App — settings, scenario lifecycle, frame loop
 * ════════════════════════════════════════════════════════════════════════════ */
const App = (() => {
  const settings = {
    paused: false,
    simSpeed: 1,
    showCurvature: true,
    showTrails: true,
    showVectors: false,
    redshift: true,
    curvatureMode: 'lattice',
    curvatureScale: 1,
    gridDensity: 'med',
    trailLength: 600,
    selectedId: null,
    followId: null,
  };
  const stats = { fps: 60, substeps: 0, lag: 0, momentum: 0 };
  let startSnap = null;
  let stepRequested = false;
  let last = 0;
  let E0 = 0, E0Version = -1;

  function start() {
    if (typeof THREE === 'undefined' || !THREE.OrbitControls) {
      const el = document.getElementById('fatal');
      el.hidden = false;
      el.textContent = 'Could not load three.js from the CDN (cdn.jsdelivr.net). Check your connection and reload.';
      return;
    }
    Renderer.init(document.getElementById('viewport'));
    Curvature.init(Renderer.scene);
    Simulation.on('merge', onMerge);
    UI.init(api);
    loadPreset('solar-system');
    requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
  }

  /* ── Scenarios ──────────────────────────────────────────────────────────── */

  function loadPreset(key) {
    const p = Presets.list[key];
    if (!p) return;
    Object.assign(Simulation.params, { G: 1, softening: 0.6, c: 45, collisions: true }, p.params);
    Simulation.clear();
    p.build(Simulation.params).forEach((b) => Simulation.addBody(b));
    Simulation.toComFrame();
    startSnap = Simulation.snapshot();
    settings.selectedId = settings.followId = null;
    Renderer.setCamera(p.camera.pos, p.camera.target);
    document.getElementById('preset').value = key;
    UI.syncControls();
    UI.refresh();
    UI.status(`Loaded “${p.label}”`);
  }

  function reset() {
    if (!startSnap) return;
    Simulation.restore(startSnap);
    settings.selectedId = settings.followId = null;
    UI.syncControls();
    UI.refresh();
    UI.status('Reset to start state');
  }

  function markStart() {
    startSnap = Simulation.snapshot();
    UI.status('Current state is now the reset point');
  }

  function clearAll() {
    Simulation.clear();
    settings.selectedId = settings.followId = null;
    UI.refresh();
    UI.status('All bodies removed');
  }

  /* ── Bodies ─────────────────────────────────────────────────────────────── */

  // Velocity for a circular orbit around the heaviest body, in its horizontal plane
  // (or a vertical plane if the new body sits directly above/below it).
  function orbitVelocity(f) {
    const H = Simulation.heaviest();
    if (!H) return null;
    const rx = f.x - H.x, ry = f.y - H.y, rz = f.z - H.z;
    const r = Math.hypot(rx, ry, rz);
    if (r < 1e-6) return null;
    let nx = 0, ny = 1, nz = 0;
    if (Math.abs(ry / r) > 0.95) { nx = 1; ny = 0; }
    let tx = ry * nz - rz * ny, ty = rz * nx - rx * nz, tz = rx * ny - ry * nx; // r × n
    const tl = Math.hypot(tx, ty, tz);
    tx /= tl; ty /= tl; tz /= tl;
    const P = Simulation.params;
    const s = Utils.circularSpeed(P.G, H.mass + f.mass, r, P.softening);
    return [H.vx + tx * s, H.vy + ty * s, H.vz + tz * s];
  }

  function addFromForm(point) {
    const f = UI.readAddForm();
    if (point) { f.x = point.x; f.y = point.y; f.z = point.z; }
    if (!(f.mass > 0)) { UI.status('Mass must be greater than 0', true); return; }
    if (f.orbit && !f.pinned) {
      const v = orbitVelocity(f);
      if (v) { [f.vx, f.vy, f.vz] = v; UI.fillAddVelocity(v); }
    }
    const b = Simulation.addBody(f);
    UI.afterAdd();
    select(b.id);
    UI.status(`Added ${b.name}`);
  }

  function removeBody(id) {
    const b = Simulation.removeBody(id);
    if (!b) return;
    if (settings.selectedId === id) settings.selectedId = null;
    if (settings.followId === id) settings.followId = null;
    UI.refresh();
    UI.status(`Removed ${b.name}`);
  }

  function select(id) {
    settings.selectedId = id;
    UI.refresh();
  }

  function toggleFollow(id, forceOn = false) {
    settings.followId = id == null || (settings.followId === id && !forceOn) ? null : id;
    if (settings.followId != null) settings.selectedId = settings.followId;
    UI.refresh();
  }

  function onMerge({ survivor, absorbed }) {
    if (settings.selectedId === absorbed.id) settings.selectedId = survivor.id;
    if (settings.followId === absorbed.id) settings.followId = survivor.id;
    const c = Utils.hexToRgb(survivor.color);
    Renderer.flash(survivor.x, survivor.y, survivor.z, survivor.radius * 9 + 4, new THREE.Color(c[0], c[1], c[2]));
    UI.status(`${absorbed.name} merged into ${survivor.name}`);
  }

  /* ── Transport ──────────────────────────────────────────────────────────── */

  function togglePause() {
    settings.paused = !settings.paused;
    UI.syncPause();
  }

  function stepOnce() {
    if (!settings.paused) { settings.paused = true; UI.syncPause(); }
    stepRequested = true;
  }

  function energyDrift() {
    const d = Simulation.diagnostics();
    stats.momentum = d.momentum;
    if (E0Version !== Simulation.version) { E0 = d.energy; E0Version = Simulation.version; }
    return Math.abs(E0) > 1e-9 ? (d.energy - E0) / Math.abs(E0) : 0;
  }

  /* ── Frame loop ─────────────────────────────────────────────────────────── */

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); // clamp: tab switches, hitches
    last = now;
    if (dt > 0) stats.fps = Utils.lerp(stats.fps, 1 / dt, 0.05);

    let res = null;
    if (stepRequested) { res = Simulation.step(settings.simSpeed / 60); stepRequested = false; }
    else if (!settings.paused) res = Simulation.step(dt * settings.simSpeed);
    stats.substeps = res ? res.substeps : 0;
    stats.lag = res ? res.lag : 0;

    Simulation.updateRelativity();
    Renderer.update(dt, settings);
    Curvature.update(Simulation.bodies, Simulation.params, settings, Renderer.target);
    Renderer.render();
    UI.tick(dt);
  }

  const api = {
    settings, stats, loadPreset, reset, markStart, clearAll, addFromForm, removeBody, select,
    toggleFollow, togglePause, stepOnce, energyDrift,
  };
  return { start, ...api };
})();

/* ── Bootstrap ─────────────────────────────────────────────────────────────── */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  App.start();
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Utils, Simulation, Presets };
}
