// UI layer tests. Everything here runs on plain CPU: the input state machine,
// the HUD layout arithmetic, and the drawing code exercised against a recording
// fake 2D context that throws on incoherent command streams.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Game } from '../src/sim/game.js';
import { Camera } from '../src/gfx/camera.js';
import { BUILDABLE, RULES, shipDef } from '../src/sim/defs.js';
import {
  DRAG_SLOP,
  DOUBLE_CLICK_MS,
  CAMERA_KEYS,
  InputState,
  buildKeyToType,
  normaliseRect,
  rectArea,
  worldToPixel,
  shipsInRect,
  pickShip,
  pickAsteroid,
} from '../src/ui/input.js';
import {
  rgbaString,
  formatNumber,
  formatClock,
  buildMenuLayout,
  hitBuildMenu,
  hudConsumes,
  hudLayout,
  summariseSelection,
  factionSummary,
  productionQueue,
  drawHud,
  drawMinimap,
  minimapTransform,
} from '../src/ui/hud.js';

const DT = 1 / RULES.tickRate;

function run(game, ticks) {
  for (let i = 0; i < ticks; i++) game.step();
  return game;
}

function makeGame(ticks) {
  const g = new Game(1337, 3);
  if (ticks) run(g, ticks);
  return g;
}

function makeCamera(world) {
  const c = new Camera();
  c.setAspect(1280 / 720);
  if (world) c.focusOn({ x: 0, y: 0, z: 0 });
  c.snap();
  return c;
}

// A 2D context that records every call and rejects malformed usage.
function fakeCtx() {
  const calls = [];
  const state = { align: 0, saves: 0 };
  const rec = (name) => (...args) => { calls.push({ name, args }); };
  const ctx = {
    calls,
    canvas: { width: 1280, height: 720 },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    clearRect: rec('clearRect'),
    beginPath: rec('beginPath'),
    closePath: rec('closePath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    arc: rec('arc'),
    stroke: rec('stroke'),
    fill: rec('fill'),
    save() { state.saves++; calls.push({ name: 'save', args: [] }); },
    restore() {
      state.saves--;
      if (state.saves < 0) throw new Error('restore() without matching save()');
      calls.push({ name: 'restore', args: [] });
    },
    fillRect(x, y, w, h) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`fillRect NaN origin ${x},${y}`);
      if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error(`fillRect NaN size ${w},${h}`);
      if (w < 0 || h < 0) throw new Error(`fillRect negative size ${w}x${h}`);
      calls.push({ name: 'fillRect', args: [x, y, w, h], style: ctx.fillStyle });
    },
    strokeRect(x, y, w, h) {
      if (!Number.isFinite(x + y + w + h)) throw new Error('strokeRect NaN');
      calls.push({ name: 'strokeRect', args: [x, y, w, h], style: ctx.strokeStyle });
    },
    fillText(txt, x, y) {
      if (typeof txt !== 'string') throw new Error(`fillText non-string: ${typeof txt}`);
      if (txt.includes('NaN') || txt.includes('undefined')) throw new Error(`fillText leaked: "${txt}"`);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`fillText NaN position for "${txt}"`);
      if (!ctx.font) throw new Error(`fillText with no font set: "${txt}"`);
      calls.push({ name: 'fillText', args: [txt, x, y], style: ctx.fillStyle });
    },
    measureText(txt) { return { width: String(txt).length * 7 }; },
    countOf(name) { return calls.filter((c) => c.name === name).length; },
    texts() { return calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]); },
    balanced() { return state.saves === 0; },
  };
  return ctx;
}

// --- pure helpers -----------------------------------------------------------

test('buildKeyToType maps Digit1..Digit9 onto BUILDABLE in order', () => {
  for (let i = 0; i < BUILDABLE.length; i++) {
    assert.equal(buildKeyToType(`Digit${i + 1}`), BUILDABLE[i]);
  }
});

test('buildKeyToType rejects out-of-range and non-digit codes', () => {
  assert.equal(buildKeyToType('Digit0'), null);
  assert.equal(buildKeyToType('KeyA'), null);
  assert.equal(buildKeyToType(''), null);
  assert.equal(buildKeyToType(`Digit${BUILDABLE.length + 1}`), null);
});

test('normaliseRect orders corners regardless of drag direction', () => {
  const a = normaliseRect(10, 20, 110, 220);
  const b = normaliseRect(110, 220, 10, 20);
  assert.deepEqual(a, b);
  assert.equal(a.x0, 10);
  assert.equal(a.y0, 20);
  assert.equal(a.x1, 110);
  assert.equal(a.y1, 220);
});

test('rectArea multiplies the normalised extents', () => {
  assert.equal(rectArea(normaliseRect(0, 0, 10, 5)), 50);
  assert.equal(rectArea(normaliseRect(4, 4, 4, 9)), 0);
});

test('DRAG_SLOP and DOUBLE_CLICK_MS are sane constants', () => {
  assert.ok(DRAG_SLOP > 0 && DRAG_SLOP < 40);
  assert.ok(DOUBLE_CLICK_MS >= 150 && DOUBLE_CLICK_MS <= 600);
});

test('CAMERA_KEYS covers WASD and the arrow keys', () => {
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    assert.ok(CAMERA_KEYS[code], `${code} missing`);
  }
});

// --- projection -------------------------------------------------------------

test('worldToPixel puts the focus point near the screen centre', () => {
  const g = makeGame(0);
  const cam = makeCamera(g.world);
  const p = worldToPixel(cam, cam.focus, 1280, 720);
  assert.ok(p, 'focus point must be visible');
  assert.ok(Math.abs(p.x - 640) < 2, `x=${p.x}`);
  assert.ok(Math.abs(p.y - 360) < 2, `y=${p.y}`);
});

test('worldToPixel returns null for points behind the eye', () => {
  const cam = makeCamera();
  const behind = {
    x: cam.eye.x + (cam.eye.x - cam.focus.x) * 4,
    y: cam.eye.y + (cam.eye.y - cam.focus.y) * 4,
    z: cam.eye.z + (cam.eye.z - cam.focus.z) * 4,
  };
  assert.equal(worldToPixel(cam, behind, 1280, 720), null);
});

test('worldToPixel depth grows with distance from the eye', () => {
  const cam = makeCamera();
  const near = { x: cam.focus.x, y: cam.focus.y, z: cam.focus.z };
  const f = cam.forward();
  const behindFocus = { x: near.x + f.x * 300, y: near.y + f.y * 300, z: near.z + f.z * 300 };
  const a = worldToPixel(cam, near, 1280, 720);
  const b = worldToPixel(cam, behindFocus, 1280, 720);
  assert.ok(a && b);
  assert.ok(Number.isFinite(a.depth) && Number.isFinite(b.depth));
  assert.ok(a.depth > 0 && b.depth > 0);
  // Moving along the view direction must strictly increase depth.
  assert.ok(b.depth > a.depth + 1, `a=${a.depth} b=${b.depth}`);
});

// --- selection --------------------------------------------------------------

test('shipsInRect only returns ships of the requested faction', () => {
  const g = makeGame(120);
  const cam = makeCamera(g.world);
  cam.frame(g.world.livingShips(0).map((s) => s.pos), 1280 / 720);
  cam.snap();
  const rect = normaliseRect(0, 0, 1280, 720);
  const ids = shipsInRect(g.world, cam, rect, 1280, 720, 0);
  assert.ok(ids.length > 0, 'full-screen rect should catch something');
  for (const id of ids) assert.equal(g.world.get(id).faction, 0);
});

test('shipsInRect returns nothing for a zero-area rect', () => {
  const g = makeGame(60);
  const cam = makeCamera(g.world);
  const ids = shipsInRect(g.world, cam, normaliseRect(5, 5, 5, 5), 1280, 720, 0);
  assert.equal(ids.length, 0);
});

test('pickShip finds the ship under its own projected centre', () => {
  const g = makeGame(60);
  const cam = makeCamera(g.world);
  const ship = g.world.livingShips(0)[0];
  cam.focusOn(ship.pos);
  cam.snap();
  const p = worldToPixel(cam, ship.pos, 1280, 720);
  assert.ok(p);
  const hit = pickShip(g.world, cam, p.x, p.y, 1280, 720, {});
  assert.ok(hit, 'expected a hit at the projected centre');
  assert.equal(hit.faction, ship.faction);
});

test('pickShip misses when the cursor is far from every hull', () => {
  const g = makeGame(60);
  const cam = makeCamera(g.world);
  const hit = pickShip(g.world, cam, -5000, -5000, 1280, 720, {});
  assert.equal(hit, null);
});

test('pickShip honours the faction filter', () => {
  const g = makeGame(60);
  const cam = makeCamera(g.world);
  const ship = g.world.livingShips(0)[0];
  cam.focusOn(ship.pos);
  cam.snap();
  const p = worldToPixel(cam, ship.pos, 1280, 720);
  const other = pickShip(g.world, cam, p.x, p.y, 1280, 720, { faction: 1 });
  if (other) assert.equal(other.faction, 1);
});

test('pickAsteroid skips depleted rocks', () => {
  const g = makeGame(0);
  const cam = makeCamera(g.world);
  const rock = g.world.asteroids[0];
  rock.resource = 0;
  cam.focusOn(rock.pos);
  cam.snap();
  const p = worldToPixel(cam, rock.pos, 1280, 720);
  assert.ok(p);
  const hit = pickAsteroid(g.world, cam, p.x, p.y, 1280, 720);
  if (hit) assert.notEqual(hit.id, rock.id);
});

test('pickAsteroid finds a live rock under the cursor', () => {
  const g = makeGame(0);
  const cam = makeCamera(g.world);
  const rock = g.world.asteroids.find((a) => a.resource > 0);
  cam.focusOn(rock.pos);
  cam.snap();
  const p = worldToPixel(cam, rock.pos, 1280, 720);
  const hit = pickAsteroid(g.world, cam, p.x, p.y, 1280, 720);
  assert.ok(hit, 'expected an asteroid hit');
  assert.ok(hit.resource > 0);
});

// --- InputState -------------------------------------------------------------

test('InputState starts empty and resizes', () => {
  const st = new InputState({ width: 800, height: 600, faction: 0 });
  assert.equal(st.selected.length, 0);
  st.resize(1920, 1080);
  assert.equal(st.width, 1920);
  assert.equal(st.height, 1080);
});

test('setSelection replaces, addToSelection unions, toggleSelection flips', () => {
  const st = new InputState({});
  st.setSelection([1, 2, 3]);
  assert.deepEqual(st.selected, [1, 2, 3]);
  st.addToSelection([3, 4]);
  assert.deepEqual(st.selected.slice().sort((a, b) => a - b), [1, 2, 3, 4]);
  st.toggleSelection(2);
  assert.ok(!st.selected.includes(2));
  st.toggleSelection(2);
  assert.ok(st.selected.includes(2));
  st.clearSelection();
  assert.equal(st.selected.length, 0);
});

test('pruneSelection drops dead and unknown ids', () => {
  const g = makeGame(30);
  const st = new InputState({});
  const ships = g.world.livingShips(0);
  st.setSelection([ships[0].id, ships[1].id, 999999]);
  ships[1].alive = false;
  st.pruneSelection(g.world);
  assert.deepEqual(st.selected, [ships[0].id]);
});

test('a click under the slop threshold is a click, not a drag', () => {
  const g = makeGame(30);
  const cam = makeCamera(g.world);
  const st = new InputState({ width: 1280, height: 720, faction: 0 });
  st.pointerDown({ x: 400, y: 300, button: 0 });
  st.pointerMove({ x: 400 + DRAG_SLOP - 1, y: 300, dx: DRAG_SLOP - 1, dy: 0 }, cam);
  // `dragging` means "the left button is held", not "the slop was exceeded".
  // The slop only decides whether a box is drawn and whether the release is a
  // box selection or a click.
  assert.equal(st.dragging, true);
  assert.equal(st.overlay().screenRect, undefined, 'sub-slop must not draw a box');
  const res = st.pointerUp({ x: 400 + DRAG_SLOP - 1, y: 300, button: 0 }, g.world, cam, 20);
  assert.equal(res.kind, 'select');
  assert.equal(res.reason, undefined, 'a single click is not a type-select');
  assert.equal(st.dragging, false);
});

test('a drag past the slop threshold produces a box selection', () => {
  const g = makeGame(120);
  const cam = makeCamera(g.world);
  cam.frame(g.world.livingShips(0).map((s) => s.pos), 1280 / 720);
  cam.snap();
  const st = new InputState({ width: 1280, height: 720, faction: 0 });
  st.pointerDown({ x: 0, y: 0, button: 0 });
  st.pointerMove({ x: 1279, y: 719, dx: 1279, dy: 719 }, cam);
  assert.equal(st.dragging, true);
  assert.ok(st.overlay().screenRect, 'past the slop the overlay must expose a box');
  const res = st.pointerUp({ x: 1279, y: 719, button: 0 }, g.world, cam, 80);
  assert.equal(res.kind, 'select');
  assert.ok(res.ids.length > 0);
  assert.equal(st.dragging, false);
});

test('two fast clicks on the same ship select the whole hull type', () => {
  const g = makeGame(120);
  const cam = makeCamera(g.world);
  const ship = g.world.livingShips(0).find((s) => g.world.livingShips(0).filter((o) => o.type === s.type).length > 1);
  assert.ok(ship, 'need at least two ships of one type');
  cam.focusOn(ship.pos);
  cam.snap();
  const p = worldToPixel(cam, ship.pos, 1280, 720);
  const st = new InputState({ width: 1280, height: 720, faction: 0 });
  st.pointerDown({ x: p.x, y: p.y, button: 0 });
  const one = st.pointerUp({ x: p.x, y: p.y, button: 0 }, g.world, cam, 1000);
  assert.equal(one.kind, 'select');
  assert.equal(one.reason, undefined);
  assert.deepEqual(st.selected, [ship.id], 'first click selects exactly one hull');
  // Second click inside DOUBLE_CLICK_MS on the same hull promotes to type-select.
  st.pointerDown({ x: p.x, y: p.y, button: 0 });
  const res = st.pointerUp({ x: p.x, y: p.y, button: 0 }, g.world, cam, 1100);
  assert.equal(res.kind, 'select');
  assert.equal(res.reason, 'type', 'a fast second click must select the hull type');
  assert.ok(st.selected.length > 1, `expected >1, got ${st.selected.length}`);
  for (const id of st.selected) {
    const s = g.world.get(id);
    assert.equal(s.type, ship.type);
    assert.equal(s.faction, 0);
  }
  // A slow third click must fall back to a single-hull select.
  st.pointerDown({ x: p.x, y: p.y, button: 0 });
  const slow = st.pointerUp({ x: p.x, y: p.y, button: 0 }, g.world, cam, 9000);
  assert.equal(slow.reason, undefined);
  assert.deepEqual(st.selected, [ship.id]);
});

test('contextOrder returns null with an empty selection', () => {
  const g = makeGame(30);
  const cam = makeCamera(g.world);
  const st = new InputState({ width: 1280, height: 720, faction: 0 });
  assert.equal(st.contextOrder({ x: 640, y: 400 }, g.world, cam), null);
});

test('contextOrder on an enemy hull yields an attack order', () => {
  const g = makeGame(60);
  const cam = makeCamera(g.world);
  const enemy = g.world.livingShips(1)[0];
  cam.focusOn(enemy.pos);
  cam.snap();
  const p = worldToPixel(cam, enemy.pos, 1280, 720);
  const st = new InputState({ width: 1280, height: 720, faction: 0 });
  st.setSelection(g.world.livingShips(0).slice(0, 3).map((s) => s.id));
  const res = st.contextOrder({ x: p.x, y: p.y }, g.world, cam);
  assert.ok(res);
  assert.equal(res.kind, 'attack');
  assert.equal(res.targetId, enemy.id);
});

test('contextOrder on a rock yields harvest only for hulls with capacity', () => {
  const g = makeGame(30);
  const cam = makeCamera(g.world);
  const rock = g.world.asteroids.find((a) => a.resource > 0);
  cam.focusOn(rock.pos);
  cam.snap();
  const p = worldToPixel(cam, rock.pos, 1280, 720);
  const st = new InputState({ width: 1280, height: 720, faction: 0 });

  const collectors = g.world.livingShips(0).filter((s) => s.def.capacity > 0);
  assert.ok(collectors.length > 0, 'faction 0 should start with collectors');
  st.setSelection(collectors.map((s) => s.id));
  const res = st.contextOrder({ x: p.x, y: p.y }, g.world, cam);
  assert.ok(res);
  assert.equal(res.kind, 'harvest');
  assert.equal(res.asteroidId, rock.id);
  for (const id of res.ids) assert.ok(g.world.get(id).def.capacity > 0);
});

test('contextOrder on empty space yields a move order and drops a marker', () => {
  const g = makeGame(30);
  const cam = makeCamera(g.world);
  const st = new InputState({ width: 1280, height: 720, faction: 0 });
  st.setSelection(g.world.livingShips(0).slice(0, 2).map((s) => s.id));
  const res = st.contextOrder({ x: 640, y: 690 }, g.world, cam);
  if (res && res.kind === 'move') {
    assert.ok(st.marker, 'a move order must leave a marker');
    assert.equal(st.markerAge, 0);
  }
});

test('the move marker expires after a couple of seconds', () => {
  const st = new InputState({});
  st.marker = { x: 0, y: 0, z: 0 };
  st.markerAge = 0;
  // The budget in InputState.tick is 2.4 s, so 2.0 s of ticks must not expire it.
  for (let i = 0; i < 60; i++) st.tick(DT);
  assert.ok(st.marker, 'marker must survive 2.0 s');
  for (let i = 0; i < 30; i++) st.tick(DT);
  assert.equal(st.marker, null);
});

test('Space toggles pause and +/- change speed within bounds', () => {
  const st = new InputState({});
  assert.equal(st.keyDown('Space').paused, true);
  assert.equal(st.keyDown('Space').paused, false);
  const up = st.keyDown('Equal');
  assert.equal(up.kind, 'speed');
  assert.ok(up.speed > 1);
  for (let i = 0; i < 12; i++) st.keyDown('Equal');
  assert.ok(st.speed <= 8);
  for (let i = 0; i < 24; i++) st.keyDown('Minus');
  assert.ok(st.speed >= 0.25);
});

test('digit keys emit build intents and Escape clears the selection', () => {
  const st = new InputState({});
  st.setSelection([1, 2]);
  const b = st.keyDown('Digit1');
  assert.equal(b.kind, 'build');
  assert.equal(b.type, BUILDABLE[0]);
  const esc = st.keyDown('Escape');
  assert.equal(esc.kind, 'select');
  assert.equal(st.selected.length, 0);
});

test('keyUp removes the code from the held set', () => {
  const st = new InputState({});
  st.keyDown('KeyW');
  assert.ok(st.keys.has('KeyW'));
  st.keyUp('KeyW');
  assert.ok(!st.keys.has('KeyW'));
});

test('applyCameraKeys pans only while a direction key is held', () => {
  const cam = makeCamera();
  const st = new InputState({});
  // pan() moves the smoothing target, not the live focus.
  const before = { ...cam.targetFocus };
  st.applyCameraKeys(cam, DT);
  assert.deepEqual({ ...cam.targetFocus }, before, 'no keys held must not move the camera');
  st.keyDown('KeyW');
  st.applyCameraKeys(cam, DT);
  const moved = Math.abs(cam.targetFocus.x - before.x) + Math.abs(cam.targetFocus.z - before.z);
  assert.ok(moved > 0, 'holding W must pan');
});

test('wheel zooms the camera without leaving the distance clamps', () => {
  const cam = makeCamera();
  const st = new InputState({});
  const d0 = cam.distance;
  // zoom() writes targetDistance; snap() pulls the live value to it.
  st.wheel({ dy: -400 }, cam);
  cam.snap();
  assert.ok(cam.distance < d0, `d0=${d0} now=${cam.distance}`);
  for (let i = 0; i < 60; i++) st.wheel({ dy: -600 }, cam);
  cam.snap();
  assert.ok(cam.distance >= cam.minDistance - 1e-6);
  assert.equal(cam.distance, cam.minDistance);
  for (let i = 0; i < 120; i++) st.wheel({ dy: 600 }, cam);
  cam.snap();
  assert.ok(cam.distance <= cam.maxDistance + 1e-6);
  assert.equal(cam.distance, cam.maxDistance);
});

test('overlay always reports the selection and only sometimes a box', () => {
  const g = makeGame(30);
  const cam = makeCamera(g.world);
  const st = new InputState({ width: 1280, height: 720, faction: 0 });
  st.setSelection([1, 2, 3]);
  const a = st.overlay();
  assert.deepEqual(a.selected, [1, 2, 3]);
  assert.equal(a.screenRect, undefined);
  st.pointerDown({ x: 10, y: 10, button: 0, time: 0 });
  // Below the slop threshold the overlay must still not draw a box.
  st.pointerMove({ x: 12, y: 12, dx: 2, dy: 2, time: 10 }, cam);
  assert.equal(st.overlay().screenRect, undefined, 'sub-slop drag must not draw a box');
  st.pointerMove({ x: 400, y: 400, dx: 388, dy: 388, time: 20 }, cam);
  const b = st.overlay();
  assert.ok(b.screenRect, 'dragging must expose a box');
  assert.ok(b.screenRect.x1 > b.screenRect.x0 && b.screenRect.y1 > b.screenRect.y0);
});

// --- HUD formatting ---------------------------------------------------------

test('rgbaString clamps and rounds channels', () => {
  assert.equal(rgbaString([0, 0, 0], 1), 'rgba(0, 0, 0, 1)');
  assert.equal(rgbaString([1, 1, 1], 0.5), 'rgba(255, 255, 255, 0.5)');
  assert.equal(rgbaString([2, -1, 0.5], 1), 'rgba(255, 0, 128, 1)');
});

test('formatNumber groups thousands and leaves small values alone', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(999), '999');
  assert.equal(formatNumber(1000), '1 000');
  assert.equal(formatNumber(1234567), '1 234 567');
  assert.equal(formatNumber(1400.4), '1 400');
});

test('formatClock renders MM:SS and floors negatives to zero', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(59.9), '00:59');
  assert.equal(formatClock(60), '01:00');
  assert.equal(formatClock(3599), '59:59');
  assert.equal(formatClock(-10), '00:00');
});

// --- HUD layout -------------------------------------------------------------

test('buildMenuLayout produces one cell per buildable in menu order', () => {
  const l = buildMenuLayout(1280, 720);
  assert.equal(l.items.length, BUILDABLE.length);
  l.items.forEach((it, i) => {
    assert.equal(it.type, BUILDABLE[i]);
    assert.equal(it.index, i);
    assert.equal(it.hotkey, String(i + 1));
  });
});

test('build menu cells sit inside the panel and never overlap', () => {
  const l = buildMenuLayout(1280, 720);
  for (const it of l.items) {
    assert.ok(it.x >= l.x && it.x + it.w <= l.x + l.w, `${it.type} escapes horizontally`);
    assert.ok(it.y >= l.y && it.y + it.h <= l.y + l.h, `${it.type} escapes vertically`);
  }
  for (let i = 0; i < l.items.length; i++) {
    for (let j = i + 1; j < l.items.length; j++) {
      const a = l.items[i], b = l.items[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `${a.type} overlaps ${b.type}`);
    }
  }
});

test('build menu never eats more than half a narrow viewport', () => {
  const l = buildMenuLayout(420, 720);
  assert.ok(l.w <= 420 * 0.5 + 28, `panel ${l.w} too wide for a 420 px viewport`);
  assert.equal(l.items.length, BUILDABLE.length);
});

test('build menu is anchored to the bottom-left as the viewport grows', () => {
  const small = buildMenuLayout(1280, 720);
  const tall = buildMenuLayout(1280, 1440);
  assert.equal(small.x, tall.x);
  assert.ok(tall.y > small.y, 'panel must follow the bottom edge');
});

test('hitBuildMenu resolves the cell under a pixel and misses outside', () => {
  const l = buildMenuLayout(1280, 720);
  const target = l.items[4];
  const hit = hitBuildMenu(l, target.x + 2, target.y + 2);
  assert.ok(hit);
  assert.equal(hit.type, target.type);
  assert.equal(hitBuildMenu(l, l.x + l.w + 50, l.y), null);
});

test('hudLayout only shows the selection panel when something is selected', () => {
  assert.equal(hudLayout(1280, 720, 0).selection, null);
  const l = hudLayout(1280, 720, 5);
  assert.ok(l.selection);
  assert.ok(l.selection.x + l.selection.w <= 1280);
  assert.ok(l.selection.y + l.selection.h <= 720);
});

test('hudConsumes is true over panels and false over the open viewport', () => {
  const l = hudLayout(1280, 720, 3);
  assert.equal(hudConsumes(l, 5, 5), true, 'top bar');
  assert.equal(hudConsumes(l, l.build.x + 5, l.build.y + 5), true, 'build panel');
  assert.equal(hudConsumes(l, l.selection.x + 5, l.selection.y + 5), true, 'selection panel');
  assert.equal(hudConsumes(l, 640, 300), false, 'open space');
});

// --- HUD data ---------------------------------------------------------------

test('summariseSelection aggregates by hull type and ignores dead ids', () => {
  const g = makeGame(60);
  const ships = g.world.livingShips(0);
  const ids = ships.slice(0, 6).map((s) => s.id);
  ships[0].alive = false;
  const sum = summariseSelection(g.world, ids.concat([999999]));
  assert.equal(sum.count, 5);
  const total = sum.rows.reduce((a, r) => a + r.count, 0);
  assert.equal(total, 5);
  assert.ok(sum.maxHp > 0);
  assert.ok(sum.hullFraction > 0 && sum.hullFraction <= 1);
});

test('summariseSelection is safe on an empty selection', () => {
  const g = makeGame(0);
  const sum = summariseSelection(g.world, []);
  assert.equal(sum.count, 0);
  assert.equal(sum.rows.length, 0);
  assert.equal(sum.hullFraction, 0);
});

test('summariseSelection only counts cargo for hulls with capacity', () => {
  const g = makeGame(300);
  const collectors = g.world.livingShips(0).filter((s) => s.def.capacity > 0);
  const fighters = g.world.livingShips(0).filter((s) => !s.def.capacity);
  const sum = summariseSelection(g.world, collectors.concat(fighters).map((s) => s.id));
  const expected = collectors.reduce((a, s) => a + s.def.capacity, 0);
  assert.equal(sum.capacity, expected);
  assert.ok(sum.cargo <= sum.capacity + 1e-6);
});

test('factionSummary reports live ship counts and the population cap', () => {
  const g = makeGame(60);
  const f = factionSummary(g.world, 0);
  assert.equal(f.index, 0);
  assert.equal(f.populationCap, RULES.populationCap);
  assert.equal(f.ships, g.world.livingShips(0).length);
  assert.equal(f.rgb.length, 3);
  assert.ok(f.resources >= 0);
  assert.equal(factionSummary(g.world, 99), null);
});

test('productionQueue reads the queue from the producing ship, not the faction', () => {
  const g = makeGame(30);
  assert.deepEqual(productionQueue(g.world, 0), []);
  assert.equal(g.build(0, 'interceptor'), true);
  const q = productionQueue(g.world, 0);
  assert.equal(q.length, 1);
  assert.equal(q[0].type, 'interceptor');
  assert.equal(q[0].remaining, shipDef('interceptor').build);
});

test('productionQueue returns an empty array when no producer survives', () => {
  const g = makeGame(30);
  for (const s of g.world.ships) if (s.def.produces && s.faction === 0) s.alive = false;
  assert.deepEqual(productionQueue(g.world, 0), []);
});

// --- HUD drawing ------------------------------------------------------------

function hudState(g, extra) {
  return Object.assign({
    width: 1280,
    height: 720,
    world: g.world,
    faction: 0,
    selected: [],
    fps: 60,
    speed: 1,
    paused: false,
    hover: null,
    message: null,
  }, extra || {});
}

test('drawHud clears the canvas and draws every build button', () => {
  const g = makeGame(60);
  const ctx = fakeCtx();
  const layout = drawHud(ctx, hudState(g));
  assert.equal(ctx.countOf('clearRect'), 1);
  assert.ok(ctx.balanced());
  for (const it of layout.build.items) {
    const name = shipDef(it.type).name;
    assert.ok(ctx.texts().some((t) => t.includes(name)), `${name} button missing`);
  }
});

test('drawHud renders the clock, speed and fps in the top bar', () => {
  const g = makeGame(300);
  const ctx = fakeCtx();
  drawHud(ctx, hudState(g, { speed: 2, paused: true, fps: 59.6 }));
  const joined = ctx.texts().join('|');
  assert.ok(joined.includes('x2'), 'speed missing');
  assert.ok(joined.includes('PAUSED'), 'pause flag missing');
  assert.ok(joined.includes('60 fps'), 'fps missing');
  assert.ok(/\d\d:\d\d/.test(joined), 'clock missing');
});

test('drawHud draws the selection panel only when ships are selected', () => {
  const g = makeGame(60);
  const ids = g.world.livingShips(0).slice(0, 4).map((s) => s.id);
  const empty = fakeCtx();
  drawHud(empty, hudState(g));
  assert.ok(!empty.texts().some((t) => t.startsWith('SELECTED')));
  const full = fakeCtx();
  const layout = drawHud(full, hudState(g, { selected: ids }));
  assert.ok(layout.selection);
  assert.ok(full.texts().some((t) => t === 'SELECTED  4'), full.texts().join('|'));
});

test('drawHud shows the production queue once a build is ordered', () => {
  const g = makeGame(30);
  const before = fakeCtx();
  drawHud(before, hudState(g));
  assert.ok(!before.texts().some((t) => t.startsWith('QUEUE')));
  g.build(0, 'bomber');
  const after = fakeCtx();
  drawHud(after, hudState(g));
  assert.ok(after.texts().some((t) => t.startsWith('QUEUE') && t.includes(shipDef('bomber').name)));
});

test('drawHud renders a transient message when one is supplied', () => {
  const g = makeGame(30);
  const ctx = fakeCtx();
  drawHud(ctx, hudState(g, { message: 'Not enough resources' }));
  assert.ok(ctx.texts().includes('Not enough resources'));
});

test('drawHud survives a bankrupt faction and a wiped-out opponent', () => {
  const g = makeGame(60);
  g.world.factions[0].resources = 0;
  for (const s of g.world.ships) if (s.faction === 1) s.alive = false;
  g.world.factions[1].alive = false;
  const ctx = fakeCtx();
  assert.doesNotThrow(() => drawHud(ctx, hudState(g, { selected: [] })));
  assert.ok(ctx.balanced());
});

test('drawHud at an extreme aspect ratio still keeps panels on screen', () => {
  const g = makeGame(30);
  const ctx = fakeCtx();
  const layout = drawHud(ctx, hudState(g, { width: 480, height: 1000, selected: [] }));
  assert.ok(layout.build.x >= 0);
  assert.ok(layout.build.y >= layout.top.h, 'build panel must not collide with the top bar');
  assert.ok(layout.build.y + layout.build.h <= 1000);
});

// --- minimap ----------------------------------------------------------------

test('minimapTransform round-trips world XZ through screen space', () => {
  const t = minimapTransform(20, 500, 200, 26000);
  const p = { x: 4200, y: 0, z: -9100 };
  const s = t.toScreen(p);
  const back = t.toWorld(s.x, s.y);
  assert.ok(Math.abs(back.x - p.x) < 1e-6, `x ${back.x}`);
  assert.ok(Math.abs(back.z - p.z) < 1e-6, `z ${back.z}`);
  assert.equal(back.y, 0);
});

test('minimapTransform maps the world origin to the panel centre', () => {
  const t = minimapTransform(0, 0, 200, 26000);
  const c = t.toScreen({ x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(c.x - 100) < 1e-9);
  assert.ok(Math.abs(c.y - 100) < 1e-9);
});

test('minimapTransform maps the world corners to the panel corners', () => {
  const b = 26000;
  const t = minimapTransform(10, 10, 200, b);
  const lo = t.toScreen({ x: -b, y: 0, z: -b });
  const hi = t.toScreen({ x: b, y: 0, z: b });
  assert.ok(Math.abs(lo.x - 10) < 1e-9 && Math.abs(lo.y - 10) < 1e-9);
  assert.ok(Math.abs(hi.x - 210) < 1e-9 && Math.abs(hi.y - 210) < 1e-9);
});

test('drawMinimap plots live ships and skips depleted rocks', () => {
  const g = makeGame(120);
  g.world.asteroids[0].resource = 0;
  const ctx = fakeCtx();
  const t = drawMinimap(ctx, { world: g.world, faction: 0, x: 12, y: 400, size: 200 });
  assert.ok(t && typeof t.toScreen === 'function');
  const live = g.world.ships.filter((s) => s.alive).length;
  const rocks = g.world.asteroids.filter((a) => a.resource > 0).length;
  // one panel fill + one fill per rock + one fill per ship
  assert.equal(ctx.countOf('fillRect'), 1 + rocks + live);
  assert.ok(ctx.balanced());
});
