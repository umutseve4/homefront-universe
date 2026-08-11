# Architecture

This document describes how HomeFront Universe is put together and, just as
importantly, why it is put together that way. It also records the decisions that
were reversed during development, because those are usually more instructive
than the ones that survived unchanged.

## 1. Constraints that shaped everything

Four constraints were fixed before any code was written:

1. **Zero runtime dependencies.** No bundler, no framework, no math library, no
   test runner beyond the one built into Node. Everything below is written from
   first principles.
2. **The simulation must be deterministic.** Given a seed and a tick count, the
   world state must be reproducible exactly. This is what makes the simulation
   testable at all.
3. **The renderer must never be able to change simulation state.** Rendering is
   a pure read of the world.
4. **Ship as a single file.** The final artefact is one self-contained
   `.html` file with no external requests.

Constraint 2 is the load-bearing one. It is the reason there is a custom PRNG,
the reason the simulation advances on a fixed timestep, and the reason
`Math.random`, `Date.now`, and iteration over unordered collections are absent
from `src/sim/`.

## 2. Layer structure

```
src/
  core/     math, PRNG            no imports from anywhere else
  sim/      the game simulation    imports core only
  gfx/      WebGL2 rendering       imports core, reads sim data
  ui/       input and 2D HUD       imports core, reads sim data
  main.js   composition root       imports everything
```

Dependencies point strictly downward. `tools/validate.mjs` enforces this: it
builds the import graph, fails on any cycle, and fails if anything imports the
entry point. The layering is not a convention that decays over time; it is a
build-breaking assertion.

### `src/core`

- `math.js` — vectors, 4×4 matrices, projection/view construction, matrix
  inversion, unprojection, ray/sphere and ray/plane intersection.
- `rng.js` — a small deterministic PRNG with an explicit, serialisable state.

`math.js` carries **two calling conventions**, which is the single most common
source of mistakes when working in this codebase:

| Style | Functions | Signature |
|---|---|---|
| Plain return | `v3add`, `v3sub`, `v3cross`, `v3norm`, `v3len`, `v3dot`, `mat4mulPoint`, `unproject`, `raySphere`, `rayPlaneY` | returns a new value |
| Out-parameter first | `mat4mul`, `mat4perspective`, `mat4lookAt`, `mat4model`, `mat4invert` | `(out, …)`, writes into `out` |

The split is deliberate: matrix operations run per-frame and allocating a new
16-element array each time is wasteful, while vector helpers are used in
readability-sensitive code where chaining matters more. It is still a trap, so
it is written down here and asserted in tests.

`mat4invert` returns `null` when `|det| < 1e-12` rather than producing garbage.
Every caller must handle that.

### `src/sim`

- `defs.js` — ship definitions, faction colours, rule constants.
- `world.js` — entity storage, spatial grid, damage application.
- `mapgen.js` — deterministic starting layout from a seed.
- `movement.js`, `combat.js`, `economy.js`, `ai.js` — the four systems.
- `game.js` — the fixed-timestep driver and public API.

The world is plain data: arrays of records plus an id→record map. There is no
class hierarchy for entities, no component framework, no event bus. A ship is an
object with fields.

**Fixed timestep.** `Game.step()` advances exactly one tick (30 per simulated
second). `Game.advance(realDt, maxSteps)` takes **seconds of real time**, clamps
to 0.25 s, and runs up to `maxSteps` (default 6) ticks. Frame rate therefore has
no effect on simulation outcome — a machine rendering at 30 fps and one at 144
fps produce the same world.

**Spatial grid.** Combat and collision avoidance query neighbours through a
uniform grid keyed by cell coordinates, rebuilt each tick. With a few hundred
ships this beats a naive O(n²) scan comfortably and is far simpler than a tree.

**Checksum.** `Game.checksum()` folds the significant world state into a single
integer. This is the determinism test: run the same seed twice, compare one
number. CI does exactly this.

### `src/gfx`

- `shaders.js` — GLSL ES 3.00 source strings.
- `gl.js` — thin WebGL2 helpers: program linking, VAO setup, buffer creation.
- `meshgen.js` — procedural hull, sphere, and grid geometry.
- `camera.js` — orbit camera with smoothing, plus picking maths.
- `renderer.js` — the frame: stars, hulls, overlay lines.

Rendering uses three pipelines:

| Pipeline | Primitive | Layout | Notes |
|---|---|---|---|
| Hulls | instanced triangles | pos(0) vec3, normal(1) vec3, model rows(2–5) vec4, tint(6) vec4 | stride 80, divisor 1, 20 floats per instance |
| Overlay | `gl.LINES` | pos(0) vec3, colour(1) vec4 | stride 28, additive, depth-write off |
| Starfield | points | pos(0) vec3, brightness(1) float | stride 16, 2600 stars at radius 48000 |

Every ship of a given hull type is drawn in one instanced call. Ship colour is
encoded in `tint`: RGB is the faction colour dimmed by remaining hull fraction
(`0.45 + 0.55 * frac`), and **alpha carries the damage fraction** (`1 - frac`)
so the shader can add a damage glow without a second uniform.

That table is not decorative. `tools/validate.mjs` parses the `layout(location
= N) in TYPE name;` declarations out of `shaders.js` and cross-checks them
against the `vertexAttribPointer` component counts in `gl.js` and
`renderer.js`. A mismatch there is invisible to every unit test — it only shows
up as garbage geometry on a real GPU — and exactly one such bug occurred during
development: the star buffer supplied one float per vertex while the vertex
shader declared `vec3 aColour`. The validator exists so that class of bug
cannot recur silently.

### `src/ui`

- `input.js` — pointer, wheel, and keyboard handling; selection; order issuing.
- `hud.js` — 2D canvas HUD and minimap, drawn on a separate overlay canvas.

The HUD is deliberately **not** WebGL. Text rendering in WebGL requires either a
font atlas or SDF glyphs, both of which are a project of their own. A second
`<canvas>` with a 2D context sitting above the WebGL canvas costs almost
nothing and gives correct text for free.

`input.js` produces **order objects**, not mutations. It never touches the
world. `main.js` receives the order and calls the corresponding `Game` method.
This keeps constraint 3 intact: input can be tested with no simulation, and the
simulation can be tested with no input.

### `src/main.js`

The composition root. It creates the canvases, the game, the renderer, the
camera and the input state, then runs the animation loop. Five pure helpers
(`readOptions`, `makeFpsMeter`, `pointerRecord`, `applyOrder`, `winnerName`) are
exported separately so the interesting logic is testable without a DOM.

`start()` itself requires a browser and is **not** executed by the test suite.
See "Verification boundary" below.

## 3. Build

`tools/bundle.mjs` is a purpose-built concatenating bundler, about 200 lines.
It parses each module's imports and exports, topologically sorts the graph,
strips the `export` keywords, and concatenates everything into one `"use
strict"` IIFE inside an HTML shell.

This works only because the source obeys a restricted module syntax:

- single-line `import { a, b } from './x.js';` only
- exports only as `export function` / `export const` / `export class`
- no default exports, no re-exports, no `export { … }` blocks
- no dynamic `import()`
- acyclic graph, no duplicate exported names across modules

These rules are **enforced, not documented**: the bundler throws on violation
and `tools/validate.mjs` checks them independently. Import lines are replaced
with blank lines rather than deleted, so line numbers in the bundle still match
the source files — which makes browser stack traces usable.

`tools/checkbundle.mjs` then verifies the emitted artefact: exactly one inline
script, required DOM ids present, no surviving `import`/`export`, no unescaped
`</script`, wrapped in an IIFE, strict mode on, the extracted JavaScript parses
under `node --check`, and the bundle actually calls `start()`.

## 4. Testing strategy

239 tests across six files, run by `node --test`.

The technique that found the most real bugs is **assertive fakes**. The fake
WebGL context does not merely record calls — it throws on drawing without a
bound program or VAO, on drawing zero instances, and on `bufferSubData` writing
past buffer capacity. The fake 2D context throws on NaN coordinates, negative
rectangle dimensions, non-string `fillText` arguments, the literal strings
`"NaN"` or `"undefined"` appearing in drawn text, `fillText` with no font set,
and unbalanced `save`/`restore`.

A permissive mock would have passed on all of those. Several genuine defects
were caught this way, including HUD text that rendered as `undefined` for a
faction with no active production.

### Bugs found by tests, kept as regression cases

| Bug | Symptom | Cause |
|---|---|---|
| Double integration | Ships accelerated impossibly | Velocity applied twice per tick |
| Harvester drift | Collectors never returned to base | `steerTo` rotated in the wrong plane; no unload latch |
| Degenerate sphere triangles | Zero-area triangles at poles and seam | Grid mesh duplicated pole rows and the theta seam |
| Star attribute mismatch | Would have been GPU-only garbage | Buffer supplied 1 float, shader declared `vec3` |
| Wrong lint regex | False failure on correct shaders | `\\battribute\\b` matched English prose in a `//` comment |

The last row is a lesson about tests rather than about the code: before
"fixing" source to satisfy a lint, check whether the match is code or prose.

## 5. Verification boundary

This is the part most project documentation omits. Three things are **not**
verified by the automated pipeline:

1. **GLSL is never compiled by a real driver.** The shaders are validated as
   text — version directive, precision qualifier, attribute layout consistency,
   absence of GLSL ES 1.00 constructs — but no GPU has parsed them in CI. A
   syntax error inside a shader body would not be caught here.
2. **`start()` has never executed in CI.** There is no DOM and no WebGL2 context
   in the Node test environment. Everything reachable without a DOM is tested;
   the assembly step in `start()` is not.
3. **`dist/homefront.html` is verified structurally and syntactically, not
   visually.** `node --check` proves it parses. It does not prove it renders.

These are stated plainly because describing statically-checked code as
"verified" would be false. Anyone can close gaps 1–3 by running
`npm run serve` and opening the page — that manual step is currently the only
thing standing between this project and an end-to-end guarantee.

## 6. Rejected alternatives

**Entity-component-system.** Considered and dropped. At a few hundred entities
with five systems, an ECS adds indirection and a scheduler without buying
measurable performance. Plain arrays of records are faster to read and to debug.

**Web Workers for the simulation.** Attractive for frame pacing, rejected for
now because the structured-clone boundary would force either a copy of the
world every frame or a `SharedArrayBuffer` layout, and the latter is a large
rewrite of `world.js`. Revisit only if profiling shows the simulation is the
frame-time bottleneck; at ~730 ticks/s headless it currently is not.

**A real bundler (esbuild/rollup).** Would be one npm install and ten lines of
config. Rejected because the constraint was zero dependencies, and because
writing the bundler forced a precise understanding of the module graph — which
is what `tools/validate.mjs` now enforces.

**WebGL text rendering.** Rejected, see `src/ui`.

## 7. Known limitations

- Single-player only; the AI opponents share one behaviour model.
- No pathfinding around obstacles; movement is steering plus local avoidance.
- No save/load, though the deterministic seed plus tick count is effectively a
  save format and could be exposed cheaply.
- The bundler assumes ASCII-safe source; it escapes `</script` but performs no
  other transformation.
- No performance profiling has been done on GPU-side rendering, only on the
  headless simulation.
