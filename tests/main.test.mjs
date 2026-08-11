import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readOptions, makeFpsMeter, pointerRecord, applyOrder, winnerName,
  BUILD_ORDER, TICK_RATE,
} from '../src/main.js';
import { Game } from '../src/sim/game.js';
import { Camera } from '../src/gfx/camera.js';
import { InputState } from '../src/ui/input.js';
import { BUILDABLE, RULES } from '../src/sim/defs.js';

// main.js must import cleanly under Node. If it touched `document` at module
// scope this file would throw before the first test ran, which is the point.

function makeGame() {
  return new Game(4242, 3);
}

function run(game, ticks) {
  for (let i = 0; i < ticks; i++) game.step();
}

// ------------------------------------------------------------------ options

test('readOptions parses an explicit seed and faction count', () => {
  const o = readOptions('?seed=1337&factions=4');
  assert.equal(o.seed, 1337);
  assert.equal(o.factions, 4);
});

test('readOptions clamps the faction count to the supported range', () => {
  assert.equal(readOptions('?factions=1').factions, 2);
  assert.equal(readOptions('?factions=99').factions, 4);
  assert.equal(readOptions('?factions=0').factions, 2);
});

test('readOptions defaults to three factions when unspecified', () => {
  assert.equal(readOptions('').factions, 3);
  assert.equal(readOptions('?seed=7').factions, 3);
});

test('readOptions rejects a non-numeric seed and still returns a uint32', () => {
  const o = readOptions('?seed=abc');
  assert.equal(typeof o.seed, 'number');
  assert.ok(Number.isInteger(o.seed));
  assert.ok(o.seed >= 0 && o.seed <= 0xffffffff);
});

test('readOptions round-trips a seed the sim can actually use', () => {
  const o = readOptions('?seed=90210&factions=2');
  const a = new Game(o.seed, o.factions);
  const b = new Game(o.seed, o.factions);
  run(a, 200);
  run(b, 200);
  assert.equal(a.checksum(), b.checksum());
});

// ---------------------------------------------------------------- fps meter

test('the fps meter converges towards the true frame rate', () => {
  const m = makeFpsMeter(0.2);
  for (let i = 0; i < 400; i++) m.sample(1 / 120);
  assert.ok(Math.abs(m.value - 120) < 1, `converged to ${m.value}`);
});

test('the fps meter ignores a zero or negative dt', () => {
  const m = makeFpsMeter(0.5);
  const before = m.value;
  m.sample(0);
  m.sample(-1);
  assert.equal(m.value, before);
});

test('the fps meter never returns a non-finite value', () => {
  const m = makeFpsMeter();
  for (const dt of [1 / 60, 1 / 5, 1 / 240, 0.25]) m.sample(dt);
  assert.ok(Number.isFinite(m.value));
});

// ----------------------------------------------------------- pointerRecord

const RECT = { left: 20, top: 50 };

test('pointerRecord converts client coordinates into canvas coordinates', () => {
  const p = pointerRecord({ clientX: 120, clientY: 90, button: 0 }, RECT, null);
  assert.equal(p.x, 100);
  assert.equal(p.y, 40);
});

test('pointerRecord reports a zero delta when there is no previous sample', () => {
  const p = pointerRecord({ clientX: 120, clientY: 90, button: 0 }, RECT, null);
  assert.equal(p.dx, 0);
  assert.equal(p.dy, 0);
});

test('pointerRecord computes the delta against the previous sample', () => {
  const a = pointerRecord({ clientX: 120, clientY: 90, button: 0 }, RECT, null);
  const b = pointerRecord({ clientX: 133, clientY: 84, button: 0 }, RECT, a);
  assert.equal(b.dx, 13);
  assert.equal(b.dy, -6);
});

test('pointerRecord preserves the button index and the shift modifier', () => {
  const p = pointerRecord({ clientX: 0, clientY: 0, button: 2, shiftKey: true }, RECT, null);
  assert.equal(p.button, 2);
  assert.equal(p.shift, true);
  const q = pointerRecord({ clientX: 0, clientY: 0, button: 1 }, RECT, null);
  assert.equal(q.button, 1);
  assert.equal(q.shift, false);
});

test('a pointerRecord is directly consumable by InputState', () => {
  const input = new InputState({ width: 800, height: 600, faction: 0 });
  const game = makeGame();
  const cam = new Camera();
  cam.setAspect(800 / 600);
  cam.snap();
  const down = pointerRecord({ clientX: 420, clientY: 350, button: 0 }, RECT, null);
  input.pointerDown(down);
  assert.equal(input.dragging, true);
  const up = pointerRecord({ clientX: 421, clientY: 351, button: 0 }, RECT, down);
  const res = input.pointerUp(up, game.world, cam, 1000);
  assert.equal(input.dragging, false);
  assert.ok(res === null || res.kind === 'select');
});

// ------------------------------------------------------------- applyOrder

test('applyOrder tolerates a null order', () => {
  const game = makeGame();
  assert.equal(applyOrder(null, game, new Camera(), new InputState({})), null);
});

test('applyOrder issues a move order that the simulation accepts', () => {
  const game = makeGame();
  const ids = game.world.livingShips(0).slice(0, 3).map((s) => s.id);
  const label = applyOrder({ kind: 'move', ids, point: { x: 500, y: 0, z: -500 } }, game, new Camera(), null);
  assert.equal(label, 'move');
  for (const id of ids) {
    const s = game.world.get(id);
    assert.ok(s.order && s.order.pos, `ship ${id} has a move order`);
  }
});

test('applyOrder issues an attack order against an enemy', () => {
  const game = makeGame();
  const mine = game.world.livingShips(0).filter((s) => s.def.dps > 0).slice(0, 2).map((s) => s.id);
  const foe = game.world.livingShips(1)[0];
  assert.ok(mine.length > 0 && foe, 'fixture has an attacker and a target');
  const label = applyOrder({ kind: 'attack', ids: mine, targetId: foe.id }, game, new Camera(), null);
  assert.equal(label, 'attack');
  assert.equal(game.world.get(mine[0]).order.targetId, foe.id);
});

test('applyOrder returns null when a harvest order matches no harvester', () => {
  const game = makeGame();
  const nonHarvesters = game.world.livingShips(0).filter((s) => !s.def.capacity).map((s) => s.id);
  assert.ok(nonHarvesters.length > 0, 'fixture has non-harvesters');
  assert.equal(applyOrder({ kind: 'harvest', ids: nonHarvesters }, game, null, null), null);
});

test('applyOrder harvests when the selection contains a collector', () => {
  const game = makeGame();
  const harvesters = game.world.livingShips(0).filter((s) => s.def.capacity > 0).map((s) => s.id);
  assert.ok(harvesters.length > 0, 'fixture has collectors');
  assert.equal(applyOrder({ kind: 'harvest', ids: harvesters }, game, null, null), 'harvest');
});

test('applyOrder reports success and failure of a build request distinctly', () => {
  const game = makeGame();
  game.world.factions[0].resources = 100000;
  const ok = applyOrder({ kind: 'build', type: 'interceptor' }, game, null, null);
  assert.equal(ok, 'build interceptor');
  game.world.factions[0].resources = 0;
  const bad = applyOrder({ kind: 'build', type: 'destroyer' }, game, null, null);
  assert.equal(bad, 'cannot afford destroyer');
});

test('applyOrder focus moves the camera towards the selection', () => {
  const game = makeGame();
  const cam = new Camera();
  cam.snap();
  const before = { x: cam.targetFocus.x, z: cam.targetFocus.z };
  const ids = game.world.livingShips(1).slice(0, 4).map((s) => s.id);
  assert.equal(applyOrder({ kind: 'focus', ids }, game, cam, null), 'focus');
  const moved = Math.hypot(cam.targetFocus.x - before.x, cam.targetFocus.z - before.z);
  assert.ok(moved > 1, `camera focus moved ${moved}`);
});

test('applyOrder focus on an empty selection leaves the camera untouched', () => {
  const game = makeGame();
  const cam = new Camera();
  cam.snap();
  const before = { x: cam.targetFocus.x, z: cam.targetFocus.z };
  applyOrder({ kind: 'focus', ids: [] }, game, cam, null);
  assert.equal(cam.targetFocus.x, before.x);
  assert.equal(cam.targetFocus.z, before.z);
});

test('applyOrder describes pause and speed changes for the HUD', () => {
  const game = makeGame();
  assert.equal(applyOrder({ kind: 'pause', paused: true }, game, null, null), 'paused');
  assert.equal(applyOrder({ kind: 'pause', paused: false }, game, null, null), 'resumed');
  assert.equal(applyOrder({ kind: 'speed', speed: 4 }, game, null, null), 'speed x4');
});

test('applyOrder ignores an unknown order kind rather than throwing', () => {
  const game = makeGame();
  assert.equal(applyOrder({ kind: 'teleport' }, game, null, null), null);
});

test('every order kind InputState can emit is handled by applyOrder', () => {
  const game = makeGame();
  const cam = new Camera();
  const input = new InputState({ width: 800, height: 600, faction: 0 });
  const kinds = ['select', 'move', 'attack', 'harvest', 'build', 'focus', 'pause', 'speed'];
  for (const kind of kinds) {
    const order = { kind, ids: [], point: { x: 0, y: 0, z: 0 }, targetId: 0, type: 'scout', speed: 1, paused: false };
    assert.doesNotThrow(() => applyOrder(order, game, cam, input), `${kind} is handled`);
  }
});

// ------------------------------------------------------------- winnerName

test('winnerName reports nobody while the match is running', () => {
  const game = makeGame();
  assert.equal(game.over, false);
  assert.equal(winnerName(game), 'nobody');
});

test('winnerName names the surviving faction once the match is over', () => {
  const game = makeGame();
  game.over = true;
  game.winner = 1;
  assert.equal(winnerName(game), game.world.factions[1].name);
});

test('winnerName is defensive about an out-of-range winner index', () => {
  const game = makeGame();
  game.over = true;
  game.winner = 99;
  assert.equal(winnerName(game), 'nobody');
});

// ------------------------------------------------------------- re-exports

test('BUILD_ORDER exposes every buildable hull with a positive cost', () => {
  assert.equal(BUILD_ORDER.length, BUILDABLE.length);
  for (const entry of BUILD_ORDER) {
    assert.ok(BUILDABLE.includes(entry.type), `${entry.type} is buildable`);
    assert.ok(entry.cost > 0, `${entry.type} costs ${entry.cost}`);
  }
});

test('TICK_RATE matches the simulation rules', () => {
  assert.equal(TICK_RATE, RULES.tickRate);
});
