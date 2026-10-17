# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running and testing

There is no build step, no package manager and no lint or test setup. Open `index.html` in a browser.
three.js r147 and its `OrbitControls` load as classic (non-module) scripts from the jsDelivr CDN.
r147 is the last release that ships classic builds, so don't upgrade it without switching to ES modules.
The curvature shaders need WebGL2.

The physics can be tested headlessly. `script.js` exports `{ Utils, Simulation, Presets }` under Node, and
`App.start()` only runs when `window` and `document` exist:

```sh
node -e "const {Simulation,Presets}=require('./script.js'); const p=Presets.list['figure-eight'];
Object.assign(Simulation.params,{G:1,softening:0.6,c:45,collisions:true},p.params);
p.build(Simulation.params).forEach(b=>Simulation.addBody(b)); Simulation.toComFrame();
const E0=Simulation.diagnostics().energy; for(let i=0;i<3600;i++) Simulation.step(1/60);
console.log(Simulation.diagnostics().energy/E0-1)"
```

That snippet repeats what `App.loadPreset` does: reset params, apply the preset's params, build, shift to the COM frame. Put throwaway test scripts in the scratchpad, not in the repo.

## Architecture

Everything is in `script.js`: seven IIFE modules in load order. `Utils → Simulation → Presets` are pure (no
DOM, no three.js). `Renderer → Curvature → UI → App` are browser-only. `index.html` holds the DOM that
`UI` binds to by element id. `README.md` documents the physics and stability measures in detail.

- **Simulation** owns `params` and the `bodies` array. It provides O(n²) Plummer-softened gravity and kick-drift-kick leapfrog
  with adaptive substeps (`L = max(ε, radius)`). It also clamps acceleration and speed (≤ 0.99c), resolves mergers, and computes relativity
  *diagnostics* (clock rate, black-hole flag). The diagnostics are visual only and never feed back into the motion. Every
  structural or parameter change must go through `touch()`, which bumps `version`. `App` uses `version` to reset the energy-drift baseline.
- **Presets** builds the scenarios. Each entry in `Presets.list` is `{ label, params, camera, build(p) }`, and `build` returns plain body
  objects. Use the `orbit(host, r, opt, p)` helper for circular or eccentric orbits, and `rotate` for tilts. The dropdown is
  filled from `Presets.list` automatically. When adding a scenario, update the count in README's Features list.
- **App** holds view `settings` (separate from the physics `params`), the scenario lifecycle (`loadPreset`, `reset`
  from a `snapshot`, `markStart`) and the frame loop. The loop runs `Simulation.step(dt·simSpeed)`, then
  `updateRelativity`, `Renderer.update`, `Curvature.update`, `render` and `UI.tick`.
- **UI** receives `App`'s `api` object. Controls register `bindings` that mirror state. After changing params or settings
  in code, call `UI.syncControls()` (and `UI.refresh()` for the body list and inspector).
- **Curvature** warps the lattice and the embedding sheet in **vertex shaders**. The grids are static, centre-relative geometry.
  Bodies are uploaded each frame as a float `DataTexture`, one column per body: row 0 holds `x, y, z, s_lattice` and row 1 holds
  `G·m, a², s_sheet, a²_sheet`. The strength comes from each body's Schwarzschild radius `2Gm/c²`.

## Invariants that span modules

- **Shared colour ramp:** `Utils.RS_STOPS` feeds `Utils.redshiftColor` (bodies), the GLSL `uStops` uniform (grids) and the HUD
  legend. Change it in one place only.
- **Sheet depth on two sides:** `Curvature.sheetDepthAt` is a CPU copy of the sheet shader's depth formula, used for the drop lines.
  Edit both together.
- **Param leaks between presets:** `loadPreset` resets only `G, softening, c, collisions` to defaults before applying a preset's `params`. `snapshot()`
  also saves only those four. If a preset sets any other param (`radiusScale`, `eta`, `maxAccel` …), that value leaks into later
  scenarios and is not restored by Reset.
- **Collision radius is fixed by mass:** the radius is `radiusScale · m^(1/3)` and doubles as the collision radius. At watchable time scales, tight configurations
  have radii comparable to their size, so presets with close encounters set `collisions: false` and use large softening.
- **Chaotic runs aren't repeatable:** substeps are cut at frame boundaries, so trajectories depend on frame timing. A chaotic scenario
  won't replay identically after Reset, and a headless run won't match the browser. Check how robust an outcome is across several
  jittered frame-dt values before describing it in a label, comment or the README.
