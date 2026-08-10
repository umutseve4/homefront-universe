# HOMEFRONT: UNIVERSE

A Homeworld-style, universe-scale real-time strategy game. Full 3D fleet
movement, procedurally generated ship hulls, generative textures, GPU
instancing and a hand-written GLSL renderer — running in a browser with
**zero dependencies**. No Three.js, no npm, no build step required.

Random skirmish only (no campaign), 2–4 factions, 5 map styles.

## Play

Open `dist/homefront-universe.html` — a single standalone file. It runs
straight from `file://`. Nothing to install, no server needed.

Requires a browser with **WebGL2** (Chrome/Edge/Firefox/Safari 15+).

## Controls

| Input | Action |
|---|---|
| Left drag | Band-select ships |
| Left click | Select / click empty space to deselect |
| Right click | Move, attack, or harvest (context sensitive) |
| Shift + right click | Queue an order |
| Middle drag / Alt drag | Orbit camera |
| Scroll | Zoom (14 m cockpit → 40 km strategic) |
| Q / E | Raise and lower the movement plane |
| Ctrl + 1..9 | Assign control group |
| 1..9 | Recall control group |
| F | Focus camera on selection |
| Tab | Cycle formation |
| Space | Pause |
| ? | Controls card |

Ships move in **full 3D**. Right-click sets an X/Z destination; `Q`/`E`
slide that destination up and down the vertical axis before you commit,
which is how you get above or below an enemy fleet.

## Ship classes

Ten hulls across four tiers, with a rock–paper–scissors armour table
(`src/sim/defs.js` is the single balance source of truth):

- **Fighters** — scout, interceptor, bomber
- **Corvettes** — corvette
- **Frigates** — flak frigate, ion frigate
- **Capitals** — destroyer, carrier, mothership
- **Support** — resource collector

Interceptors shred fighters; bombers gut capitals but die to interceptors;
flak frigates erase fighter swarms; ion frigates burn capitals. Fielding one
ship type is a losing strategy.

## Architecture

```
src/core/    math.js  rng.js                    deterministic primitives
src/sim/     defs world movement combat         headless simulation,
             economy ai mapgen game             zero rendering imports
src/gfx/     gl procgen meshgen shaders         WebGL2 + GLSL renderer
             particles postfx camera renderer
src/ui/      input.js  hud.js                   controls and 2D overlay
tools/       bundle.mjs validate.mjs headless.mjs
tests/       sim.test.mjs  mesh.test.mjs
```

The simulation layer imports **nothing** from `gfx/` or the DOM, so the
entire game state can be stepped and tested under plain Node.

### Determinism

Same seed produces the same match. Entity ids and presentation seeds come
from a salted world counter, never a module global; combat jitter is a hash
of `(entityId, tick)` rather than a random stream; asteroid tumble is derived
from the sim clock instead of accumulated per frame. Visual particle spawns
are the deliberate exception — they are presentation-only.

### Rendering

- Procedural ship meshes generated at load from lofted blueprints, 3 LODs
  each, LOD selected by **projected screen size** so it is stable across
  zoom and resolution.
- Generative PBR texture arrays (albedo / normal / ORM) — no image assets
  ship with the game.
- GPU instancing throughout; hull draws are bucketed by `type + lod`, so a
  200-ship battle is a handful of draw calls.
- Pass order: sky → hulls → asteroids → depth blit → shields → beams →
  lines → particles → post.
- Post chain: bright-pass → separable blur pyramid → tent upsample →
  composite (bloom, exposure, vignette, grain, chroma, colour grade) → FXAA.
- Soft particles read a blitted depth copy, avoiding a feedback loop from
  sampling the bound depth attachment.

## Development

```bash
node tests/sim.test.mjs      # 27 simulation tests
node tests/mesh.test.mjs     # 20 geometry tests
node tools/validate.mjs      # 57 shader/module contract checks
node tools/headless.mjs      # runs the real engine against a mock WebGL2
node tools/bundle.mjs        # emit the single-file build
```

`tools/headless.mjs` stands up a minimal DOM and a recording WebGL2 mock
that parses the actual GLSL to answer uniform introspection. It executes the
real bundle — asset build, hundreds of frames, HUD hit-testing, orders — and
fails on missing uniforms, unmocked GL entry points or non-finite floats in
the instance stream. It cannot validate a single pixel; it validates
everything that would throw before a pixel exists.

## Status

Machine-verified: simulation, geometry, module and shader contracts, and a
full headless run of the engine. **Shaders have not been compiled by a real
GPU driver** in the build environment — no browser was available — so visual
tuning of the nebula, shield and lighting constants is expected on first run.

## License

MIT
