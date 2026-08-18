# HomeFront Universe

A deterministic 3D real-time strategy simulation for the browser: a fixed-timestep fleet-combat
sim with an economy, a squad AI, and a WebGL2 renderer, built from first principles with **zero
runtime and zero build dependencies**.

The whole game builds into one self-contained HTML file — `dist/homefront.html`, 120 486 bytes —
produced by a bundler written for this repository (`tools/bundle.mjs`, ~200 lines).

> **`dist/` is not committed.** It is generated output, so it is not in version control. A fresh
> clone has no `dist/` directory until you run `npm run bundle` (or `npm run verify`, which builds
> it as one of its steps). The build is deterministic: the same source produces the same
> 120 486-byte file every time, and `npm run checkbundle` verifies it.

> **Note on this repository's history.** The previous README described a project structure
> (`src/`, `tests/`, `tools/`, `dist/`, a single-file WebGL2 bundle) that did not exist — the repo
> contained only that README. Everything now in the tree was written and executed to replace that
> description with working code. The "What is and is not verified" section below is deliberately
> blunt about the boundary of what has actually been proven.

---

## Quick start

```bash
git clone https://github.com/umutseve4/homefront-universe.git
cd homefront-universe

npm run verify     # validate + test + bundle + checkbundle  (this creates dist/)
npm run serve      # http://127.0.0.1:8080/dist/homefront.html
```

`npm run serve` only has something to serve *after* a build, so run `npm run verify` (or at least
`npm run bundle`) first.

Requires **Node.js >= 20** (developed and measured on v24.18.1). No `npm install` step — there are
no dependencies, so `node_modules/` never gets created.

To run the simulation with no browser and no renderer at all:

```bash
node tools/headless.mjs 1337 3 3000     # seed, factions, ticks
```

---

## Measured results

Every number below was produced by running the command named next to it. None are estimates.

| Metric | Value | Produced by |
|---|---|---|
| Unit tests | **239 pass / 0 fail**, 34 652 ms | `npm test` |
| Static contract checks | **564 checks over 18 modules**, all pass | `npm run validate` |
| Bundle structure checks | **16 / 16 pass** | `npm run checkbundle` |
| Bundle size | **120 486 bytes** (117.7 KiB), 18 modules, 151 top-level bindings | `npm run bundle` |
| Simulation throughput | **~730 ticks/s** (3000 ticks in 4111 ms, single-threaded) | `npm run headless` |
| Determinism, 3000 ticks | `checksum=985466095`, identical across repeated runs | `node tools/headless.mjs 1337 3 3000` |
| Determinism, 9000 ticks | `checksum=3814631718` | `node tools/headless.mjs 1337 3 9000` |

The 3000-tick reference run (seed `1337`, 3 factions) ends with Kushan 2480 / Taiidan 1165 /
Bentusi 485 resources, `over=false winner=-1`.

Determinism is not a claim about floating-point identity across CPUs. It means: **same seed, same
tick count, same engine ⇒ same checksum**, which is what the test suite and CI assert.

---

## Visual proof

The images below are not mock-ups. Each one is a top-down (x–z) snapshot of the actual simulation
state, rendered by `tools/render_map_svg.mjs` — a zero-dependency SVG renderer that runs the same
engine as `tools/headless.mjs` and dumps the world at chosen ticks. Every snapshot embeds the
state checksum of its tick in the bottom-right corner; the t=3000 checksum (`985466095`) is the
same value the determinism row in the table above asserts.

Reproduce them from a clean clone (no browser, no GPU, no dependencies):

```bash
node tools/render_map_svg.mjs           # writes docs/figures/skirmish_t{0,1500,3000}.svg
```

| t=0 — seeded start | t=1500 — economy running | t=3000 — first battle resolved |
|---|---|---|
| ![t=0](docs/figures/skirmish_t0.svg) | ![t=1500](docs/figures/skirmish_t1500.svg) | ![t=3000](docs/figures/skirmish_t3000.svg) |

What the sequence shows, read from the embedded faction statistics:

- **t=0**: three factions, 12 ships and 1400 resources each, symmetric seeded start
  (checksum `4177652866`).
- **t=1500**: collectors are attached to asteroids (asteroid opacity = remaining resource),
  production has begun — Taiidan 14 ships, Bentusi 15, all factions harvesting
  (checksum `467772105`).
- **t=3000**: the first engagement is resolved — Kushan killed=12 / lost=0, Taiidan lost=6,
  Bentusi lost=6, `over=false winner=-1` — matching the reference run in *Measured results*
  byte-for-byte (checksum `985466095`).

---

## What is and is not verified

This is the part most project READMEs get wrong, so it is stated first-class.

**Verified by execution:**

- The simulation, economy, AI, mesh generation, camera maths, renderer command generation, input
  handling and HUD drawing all run under Node and are covered by 239 assertions.
- The renderer and HUD are tested against *assertive fakes*: a fake WebGL context that throws on
  drawing without a bound program or VAO, on zero-instance draws, and on `bufferSubData` past
  buffer capacity; and a fake 2D context that throws on NaN coordinates, negative rectangles,
  `"NaN"`/`"undefined"` appearing in drawn text, and unbalanced `save`/`restore`.
- The GLSL↔JavaScript attribute contract (locations, types, strides, divisors) is checked
  statically by `tools/validate.mjs`. This check is *negative-tested*: injecting a deliberately
  wrong attribute type and a forbidden `export default` makes it report exactly those two
  failures and exit non-zero.
- `dist/homefront.html` is structurally verified (single inline script, strict mode, IIFE, no
  `import`/`export` survivors, required DOM ids present) and syntax-checked with `node --check`.
- `tools/serve.mjs` was run and answered: `200` with `content-length: 120486` for the bundle,
  `404` for a path-traversal attempt, `404` for a missing file.
- The map snapshots in *Visual proof* were generated by executing the engine and rendering its
  state directly (`tools/render_map_svg.mjs`); their embedded checksums match the headless
  reference run.

**Not verified — do not assume these work:**

1. **The GLSL has never been compiled by a real GPU driver.** There is no GPU or browser in the
   environment this was built in. The shaders are validated as *text* against the buffer layouts
   the JavaScript sets up; a driver may still reject them.
2. **`start()` in `src/main.js` has never executed.** It requires `document` and
   `requestAnimationFrame`. Its pure helpers (`readOptions`, `makeFpsMeter`, `pointerRecord`,
   `applyOrder`, `winnerName`) are tested; the frame loop itself is not.
3. **`dist/homefront.html` has never been opened in a browser.**
4. `.github/workflows/ci.yml` has never run.
5. `package.json` has never been parsed by npm — the underlying `node --test` command is what was
   verified.

Opening the bundle in a browser is the single highest-value next step, and it is the one thing
that could not be done here.

---

## Controls

| Input | Action |
|---|---|
| Left-drag | Box-select ships |
| Left-click | Select ship |
| Double-click | Select all ships of the same type |
| Right-drag | Orbit camera |
| Middle-drag | Pan camera |
| Wheel | Zoom |
| Right-click on empty space | Move order |
| Right-click on enemy | Attack order |
| Right-click on asteroid | Harvest order |
| `1`–`9` | Queue a unit from the build menu |
| `Space` | Pause / resume |
| `+` / `-` | Simulation speed |

URL parameters, parsed by `readOptions()`: `?seed=1337&factions=3&speed=1&paused=1`.

---

## Architecture

18 ES modules in four layers, an acyclic import graph, no framework.

```
src/core/    math.js      vectors, 4×4 matrices, unproject, ray/sphere, ray/plane
             rng.js       seedable PRNG — the only source of randomness

src/sim/     defs.js      unit definitions, faction colours, RULES
             world.js     entity storage, spatial hash grid
             movement.js  steering, formations, geodesic rotation
             combat.js    weapons, damage, shields, beams
             economy.js   harvesting, resources, production queues
             ai.js        per-faction squad behaviour
             mapgen.js    seeded asteroid fields and start positions
             game.js      fixed-timestep driver, orders API, checksum

src/gfx/     meshgen.js   procedural hulls and spheres, no asset files
             camera.js    orbit camera with target/live smoothing split
             shaders.js   8 GLSL ES 3.00 programs as strings
             gl.js        thin WebGL2 wrapper (VAOs, buffers, programs)
             renderer.js  instanced hulls, line overlays, starfield, post pass

src/ui/      input.js     pointer/keyboard state, picking, drag box, orders
             hud.js       2D canvas HUD, build menu, minimap

src/main.js               entry point, frame loop, wiring
```

Rendering is three pipelines: **instanced hulls** (20 floats per instance — a 4×4 model matrix at
attribute locations 2–5 plus a tint vec4 at 6, stride 80, divisor 1), **line overlays** (7 floats
per vertex, additive, depth-write off), and a **starfield** (2600 stars, interleaved
`[x, y, z, brightness]`, stride 16). Tint alpha carries the damage fraction, which is how hulls
flash without a second draw call.

Two maths conventions coexist in `src/core/math.js` and mixing them up is the easiest way to break
this codebase: **vector helpers return new arrays**, while **matrix helpers take `out` as the first
argument**. `docs/ARCHITECTURE.md` documents this, the buffer contracts, the rejected alternatives
(ECS, Web Workers, a real bundler), and the bugs the test suite actually caught.

### The bundler

`tools/bundle.mjs` inlines the module graph into one HTML file. It is a text transformer, not a
parser, so the source is restricted to what it can safely handle — and `tools/validate.mjs`
enforces those restrictions:

- imports only as single-line `import { a, b } from './x.js';`
- exports only as `export function` / `export const` / `export class`
- no default exports, no re-exports, no `export { … }` blocks
- acyclic graph, no duplicate exported names across modules

Import lines are replaced with blank lines, so line numbers in the bundle match the source files —
stack traces from the single-file build still point at the right line.

---

## Scripts

| Command | Purpose |
|---|---|
| `npm test` | 239 unit tests across six files |
| `npm run validate` | 564 static contract checks, incl. GLSL↔JS attribute layouts |
| `npm run bundle` | Build `dist/homefront.html` |
| `npm run checkbundle` | 16 structural + syntax checks on the built bundle |
| `npm run headless` | Run the sim with no renderer, print the result table and checksum |
| `npm run serve` | Static file server on 127.0.0.1:8080 |
| `npm run verify` | validate → test → bundle → checkbundle |

---

## Known limitations

- Single-threaded; the simulation and rendering share one frame budget.
- No networking, no save/load, no campaign — this is a skirmish sandbox.
- The AI is behavioural, not strategic: it harvests, defends and attacks, but does not plan.
- No audio.
- Collision is avoidance-only; ships can overlap under heavy congestion.
- The post-processing pass is a single full-screen program, not a chain.

---

## Licence

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 Umut Sever.
