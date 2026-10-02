# Curvature Sandbox

An interactive 3D n-body gravity sandbox in the browser. Bodies move under Newtonian mutual
attraction; the scene *looks* relativistic: a warped spacetime grid, time-dilation / gravitational
redshift colouring, and objects that turn into black holes when they get dense enough.

**Run it:** open `index.html` in a modern browser. You don't need a server, a build step, or a
package manager. The only dependency is three.js (r147) from the jsDelivr CDN, so the first load
needs internet access.

| File         | Contents |
|--------------|----------|
| `index.html` | Layout: top bar, controls panel, bodies panel and inspector, HUD, help dialog |
| `styles.css` | Dark glass UI, custom sliders and switches, responsive layout |
| `script.js`  | Modules: `Utils` · `Simulation` · `Presets` · `Renderer` · `Curvature` · `UI` · `App` |

`Simulation` and `Presets` use neither the DOM nor three.js. They export themselves under Node
(`require('./script.js')`), so you can test the physics headlessly.

---

## Features

- **True 3D.** Orbit, pan and zoom with OrbitControls (damped). The 3D lattice, trails, fog and
  drop lines give parallax and depth cues.
- **Bodies.** Each body has mass, position (x, y, z) and velocity (vx, vy, vz). You can add,
  edit and delete them at runtime. A body can be *pinned* (immovable).
- **Dynamics.** Softened Newtonian n-body gravity with an adaptive leapfrog integrator,
  acceleration and speed clamps.
- **Relativity-inspired effect (option A).** Time-dilation / gravitational-redshift colour mapping
  on bodies *and* on the curvature grid, plus a per-body proper-time clock.
- **Collisions.** Radius-based overlap detection and momentum-conserving mergers, with a flash
  effect.
- **Curvature visualisation.** A warped 3D lattice, an embedding "rubber sheet", or both.
- **Controls.** Pause/resume, single step, reset, "set start", 8 scenarios (default: the Solar System). Toggles for
  curvature, trails, vectors and redshift colours. Sliders for G, simulation speed, softening,
  speed of light, curvature exaggeration and trail length.
- **HUD.** FPS, simulation time, substeps per frame, energy drift and total momentum.

---

## Physics: approximations and stability measures

### Gravity

Each body's acceleration is computed directly over all pairs in O(n²), with Plummer softening:

```
a_i = Σ_j  G · m_j · (r_j − r_i) / (|r_j − r_i|² + ε²)^(3/2)
```

Pairs are processed once, and equal-and-opposite contributions are added to both bodies, so
total momentum is conserved to round-off (the HUD shows |Σp| ≈ 1e-12).

### Integration

The integrator is **kick-drift-kick leapfrog** (velocity Verlet). It is time-reversible and
symplectic at a fixed step, which means energy *oscillates* rather than drifts. Each rendered
frame advances `realDt × simSpeed` of simulation time, split into substeps.

### Stability measures

| Measure | What it does |
|--------|--------------|
| Softening ε | Removes the 1/r² singularity, so close passes can't produce infinite kicks. You can change it with a slider. |
| Adaptive substeps | `dt = min(dtMax, η·√(L/|a|), ½·L/|v|)` with `L = max(ε, radius)`. Busy encounters get finer steps. The ½·L/|v| term also stops fast bodies tunnelling through each other between collision checks. |
| Substep budget | At most 400 substeps per frame. If an encounter needs more, the sim slows down instead of freezing the tab, and the HUD shows a warning. |
| Frame-dt clamp | A frame never advances more than 0.05 s of real time (tab switches, hitches). |
| Acceleration clamp | `|a| ≤ 5000`. |
| Speed clamp | `|v| ≤ 0.99c`. This is the "cosmic speed limit": a stability guard that also keeps the Lorentz factor finite. |
| Centre-of-mass frame | Scenarios start with zero net momentum and the COM at the origin, so systems don't drift out of view. |

### Collisions and mergers

Two bodies merge when `|r_i − r_j| < R_i + R_j`. The merger is perfectly inelastic:

- mass adds: `m = m_i + m_j`
- momentum is conserved: `v = (m_i v_i + m_j v_j) / m`
- position becomes the centre of mass
- radius follows constant density: `R = 0.35 · m^(1/3)`
- colour is mass-weighted, and proper time is mass-averaged
- the heavier body keeps its id and name. If either body is pinned, the result is pinned in place.

Merging repeats until no overlaps remain, then accelerations are recomputed. Kinetic energy lost
in a merger counts as "heat", so the energy-drift baseline resets on every structural change
(add, remove, merge, edit, parameter change).

### What's accurate and what's simplified

| Accurate (within the model) | Simplified on purpose |
|---|---|
| Newtonian mutual gravity in full 3D | No general relativity: no perihelion precession, gravitational waves, frame dragging or light bending in the dynamics |
| Momentum conservation (forces and mergers) | Softening changes forces at separations ≲ ε |
| Good long-term energy behaviour (≈1e-6 relative drift over hundreds of orbits in tests) | Speed and acceleration clamps break energy conservation when they engage |
| Mass and volume add correctly in mergers | Mergers are instant and perfectly inelastic: no fragmentation, tides or Roche limits |
| Weak-field formula for the clock rate | The clock-rate formula is used outside its weak-field validity, and it never feeds back into the motion |
| | "Black hole" is a visual state (`r_s ≥ R`). The body still obeys Newtonian gravity |
| | Units are arbitrary sim units (G = 1, c ≈ 45 by default) |

---

## The relativity-inspired effect: time dilation and gravitational redshift (option A)

Every frame, each body gets a clock rate relative to a distant observer:

```
Φ_i     = −G·m_i / R_i  −  Σ_{j≠i} G·m_j / √(r_ij² + ε²)     (own surface + everyone else)
dτ/dt   = √(1 + 2Φ_i/c²) · √(1 − v_i²/c²)                    (gravitational × kinematic)
z       = 1/(dτ/dt) − 1                                       (redshift)
```

- **Body colour.** The body's own colour is blended toward a clock-rate ramp (blue-white →
  yellow → orange → red → black) by `(1 − rate)·2.2`, and dimmed by `0.25 + 0.75·rate`. Deep
  wells and fast movers look redder and darker. The legend in the HUD shows the ramp.
- **Black holes.** When the Schwarzschild radius `r_s = 2Gm/c²` reaches the physical radius, the
  body renders black with an orange photon-ring halo, and the list shows "BH". Try the
  *Black-hole forge* scenario, or lower the *c* slider.
- **Proper time.** Each body accumulates `τ += rate·dt`. The inspector shows τ next to the
  coordinate time t, along with Φ, the gravity factor, γ and z.
- **Grid colouring.** The curvature grid uses the same ramp, so the wells glow warm.
- Turning the *Time-dilation colours* toggle (or pressing `D`) off restores plain Newtonian
  colours.

Because the visual strength scales with 1/c², the **speed of light slider** is the single knob for
"how relativistic" the scene looks.

---

## Rendering and curvature visualisation

**Renderer** (three.js r147, classic scripts so `file://` works)

- **Bodies.** Each body is a shared unit sphere scaled to its radius, using `MeshStandardMaterial`.
  Luminous bodies (≥ 50 mass and ≥ 20% of the heaviest) are strongly emissive. A point light
  rides on the heaviest body and lights the planets. Each body also has an additive glow sprite.
- **Minimum glow size.** A body's glow never shrinks below about 25 px on screen, so tiny bodies
  (Earth is 3e-6 of the Sun's mass) stay visible at any zoom. Only the drawing changes; the
  physical and collision radius don't.
- **Trails.** Each body has a `THREE.Line` backed by a 2000-point buffer. The newest point is at
  index 0; old points shift down (`copyWithin`), and only the visible range is uploaded. Colours
  fade with age over the chosen trail length.
- **Vectors.** `ArrowHelper`s show velocity (cyan, length ∝ |v|) and acceleration (orange,
  length ∝ √|a|, so both small and large values stay readable).
- **Picking.** Picking works in screen space, with a minimum 10 px target, so tiny planets are
  still clickable. Shift+click raycasts onto the horizontal plane through the orbit target.
- **Depth cues.** Exponential fog fades distant grid lines and trails. A 3000-point starfield
  sits far away.

**Curvature** (`Curvature` module). Everything is driven by each body's Schwarzschild radius, so
curvature responds to mass, G and c:

1. **3D lattice (warped grid).** An n×n×n grid of shared vertices (9³, 13³ or 17³), drawn as
   indexed `LineSegments`. Each body pulls a vertex toward itself by
   `Δ = r · s/(s + r²)`, with `s = k·r_s`. Far away that's about s/r; up close it's never more
   than r. Vertices bunch into wells but never pass through a mass. The lattice snaps to the
   orbit target in whole cells, so it always surrounds what you're looking at while appearing
   fixed in space. Edges fade out.
2. **Embedding sheet.** An N×N grid below the system, sunk by
   `depth = Σ k·r_s / √(d² + (R+2)²)` (horizontal distance d), with a soft cap. This is the
   classic rubber-sheet picture. **Drop lines** run from each body down to its well, which makes
   height above the plane readable.
3. **Both** at once.

Both grids are warped and coloured on the GPU, in vertex shaders that share one prelude (uniforms,
redshift ramp, shading, fog). Their vertex buffers hold static centre-relative offsets, and each
frame the bodies are uploaded once as a small float texture (one texel column per body, 8 floats),
so there's no cap on body count and the CPU cost no longer scales with grid density. Only the drop
lines (bodies × bodies, at most 128) are still computed on the CPU. Physics plus body rendering
takes under 0.05 ms. The shaders need WebGL2 (`texelFetch`, loops bounded by a uniform), which
three.js r147 uses by default.

---

## Default scenario: the Solar System

The page opens on the Sun and the eight planets. It uses real mass ratios (Sun = 1000) and real
J2000 orbital elements: eccentricity, inclination, ascending node and longitude of perihelion.
Semi-major axes are compressed to `12 · a^0.55` (a in AU), so Mercury through Neptune fit on screen:
Earth at 12, Neptune at 78. Each planet starts at its perihelion `r = a(1 − e)` with the vis-viva
speed `√(GM(1+e)/r)`, so it traces a Kepler ellipse with the Sun at one focus. The positions are
not those of a particular date, because every planet starts at its own perihelion.

- **Visible ellipses.** Mercury (e = 0.21) and Mars (e = 0.09) are clearly off-centre. Look from
  above. The others are nearly circular, as in reality.
- **Kepler's second law.** Select Mercury and watch the inspector speed: it is about 1.5× faster at
  perihelion than at aphelion.
- **Accuracy.** Over 600 sim-seconds, measured eccentricities match the real ones to within about
  0.01. The small deviations of the outer planets come from Jupiter and Saturn perturbing each other.
  Relative energy drift is about 1e-7.
- **No moons.** At true mass ratios, their orbits would sit inside the softening length.
- **Halley's Comet.** It uses real elements: retrograde (i = 162°), Ω = 58.4°, ω = 111.3°. Its
  perihelion (0.586 AU) and aphelion (35.1 AU) go through the same compression, so it passes inside
  Venus's orbit and swings out past Neptune's. Its apparent eccentricity is about 0.82, not 0.967:
  keeping the real value with the compressed semi-major axis would put perihelion inside the Sun.
  Planetary tugs make its period vary slightly from pass to pass (63–66 s here, 74–79 years in
  reality).

To open a different scenario by default, change
`loadPreset('solar-system')` in `App.start`.

## How to add a body

**From the UI**

1. In **Controls → Add body**, set the mass, colour and position.
2. Either leave **Circular orbit around heaviest body** on (the velocity is computed for you and
   written back into the form), or turn it off and type a velocity. You can also tick
   **Pinned** for an immovable anchor.
3. Click **Add body**. Or hold **Shift and click** in the scene to drop the body where you point,
   on the horizontal plane through the orbit centre. **Randomize** fills in a random mass,
   colour and position.

**Editing.** Click a body (in the scene or in the list). The inspector fields show live values
until you start typing. Then they freeze ("edited"), and you press **Apply** (or Enter) to write
them back, or **Revert**. Double-click a body, or press `F`, to have the camera follow it.

**From code** (browser console, or inside a preset):

```js
Simulation.addBody({ name: 'Probe', mass: 2, color: '#ff66aa',
                     x: 30, y: 0, z: 0, vx: 0, vy: 0, vz: 5.8, pinned: false });

// Circular orbit around a host, tilted 20°:
const sol = Simulation.heaviest();
Simulation.addBody(Presets.orbit(sol, 30, { name: 'Moonlet', mass: 1, incl: 20 }, Simulation.params));
```

**New scenario.** Add an entry to `Presets.list` in `script.js`:

```js
myScenario: {
  label: 'My scenario',
  params: { G: 1, softening: 0.5, c: 45 },
  camera: { pos: [60, 45, 80], target: [0, 0, 0] },
  build(p) { return [ { name: 'A', mass: 500 }, Presets.orbit({ mass: 500, x: 0, y: 0, z: 0 }, 20, { name: 'B', mass: 2 }, p) ]; },
},
```

## Tweaking parameters

| Where | Parameter | Effect |
|---|---|---|
| Slider | **Gravity G** | Overall force strength, plus curvature and redshift depth |
| Slider | **Simulation speed** | Simulation seconds per real second (0 to 5×) |
| Slider | **Softening ε** | Larger is smoother and more stable, but less accurate at close range |
| Slider | **Speed of light c** | Lower means more time dilation, deeper curvature, more black holes, and a lower speed cap |
| Slider | **Curvature exaggeration** | Visual gain on the lattice pull and sheet depth |
| Slider | **Trail length** | 0 to 2000 points |
| Select | **Curvature style / Grid density** | Lattice, sheet or both; low, medium or high |
| `Simulation.params` | `radiusScale` (0.35) | Body size per m^(1/3), which also sets collision radius |
| `Simulation.params` | `eta` (0.08), `dtMax` (1/120), `maxSubsteps` (400) | Accuracy/speed trade-off of the integrator |
| `Simulation.params` | `maxAccel` (5000) | Acceleration clamp |
| `Curvature` constants | `LATTICE_K`, `SHEET_K`, `SPACING`, `SHEET_Y` | Base exaggeration, cell size, sheet height |

## Keyboard

`Space` pause · `N` step · `R` reset · `C` curvature · `T` trails · `V` vectors ·
`D` time-dilation colours · `F` follow selected · `Del` delete selected · `Esc` deselect/unfollow ·
`H` help
