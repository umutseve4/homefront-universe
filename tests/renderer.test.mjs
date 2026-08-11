import test from 'node:test';
import assert from 'node:assert/strict';

import { Renderer, hullNameForType, hullGroups, writeInstance, tintFor, screenCoverage, trailDirection } from '../src/gfx/renderer.js';
import { INSTANCE_FLOATS } from '../src/gfx/gl.js';
import { SHIP_TYPES, FACTION_COLOURS, shipDef } from '../src/sim/defs.js';
import { Game } from '../src/sim/game.js';
import { Camera } from '../src/gfx/camera.js';
import { v3 } from '../src/core/math.js';

// A recording fake WebGL2 context. It is not a driver and cannot validate
// GLSL, but it does verify that the renderer issues a coherent command
// stream: every draw is preceded by a program bind and a VAO bind, buffers
// are only written after being created, and nothing is drawn with a zero
// instance count.
function fakeGl() {
  let nextId = 1;
  const log = [];
  const live = new Set();
  const state = { program: null, vao: null, buffers: new Map() };

  const obj = (kind) => {
    const o = { kind, id: nextId++ };
    live.add(o);
    return o;
  };

  return {
    log,
    state,
    live,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    UNSIGNED_SHORT: 0x1403,
    TRIANGLES: 0x0004,
    LINES: 0x0001,
    POINTS: 0x0000,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    DEPTH_TEST: 0x0b71,
    CULL_FACE: 0x0b44,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE: 1,
    LEQUAL: 0x0203,
    BACK: 0x0405,
    CCW: 0x0901,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ACTIVE_UNIFORMS: 0x8b86,

    createShader() { return obj('shader'); },
    shaderSource() {},
    compileShader() {},
    getShaderParameter() { return true; },
    getShaderInfoLog() { return ''; },
    deleteShader(o) { live.delete(o); },
    createProgram() { return obj('program'); },
    attachShader() {},
    linkProgram() {},
    getProgramParameter(_p, pname) {
      if (pname === 0x8b82) return true;
      if (pname === 0x8b86) return 0;
      return 0;
    },
    getProgramInfoLog() { return ''; },
    deleteProgram(o) { live.delete(o); },
    getActiveUniform() { return null; },
    getUniformLocation(_p, name) { return `loc:${name}`; },
    useProgram(p) { state.program = p; log.push(`useProgram:${p ? p.id : 0}`); },

    createVertexArray() { return obj('vao'); },
    bindVertexArray(v) { state.vao = v; },
    deleteVertexArray(o) { live.delete(o); },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    vertexAttribDivisor() {},

    createBuffer() { return obj('buffer'); },
    bindBuffer(_t, b) { state.buffer = b; },
    deleteBuffer(o) { live.delete(o); },
    bufferData(_t, data) {
      if (!state.buffer) throw new Error('bufferData without a bound buffer');
      const bytes = typeof data === 'number' ? data : data.byteLength;
      state.buffers.set(state.buffer, bytes);
      log.push(`bufferData:${bytes}`);
    },
    bufferSubData(_t, offset, data) {
      if (!state.buffer) throw new Error('bufferSubData without a bound buffer');
      const cap = state.buffers.get(state.buffer);
      if (cap === undefined) throw new Error('bufferSubData into an unallocated buffer');
      if (offset + data.byteLength > cap) throw new Error('bufferSubData overflow');
      log.push(`bufferSubData:${data.byteLength}`);
    },

    uniformMatrix4fv() {},
    uniform3f() {},
    uniform1f() {},
    uniform4f() {},

    clear() { log.push('clear'); },
    clearColor() {},
    enable(c) { log.push(`enable:${c}`); },
    disable(c) { log.push(`disable:${c}`); },
    depthMask(v) { log.push(`depthMask:${v}`); },
    depthFunc() {},
    cullFace() {},
    frontFace() {},
    blendFunc() {},
    viewport() {},

    drawArrays(mode, first, count) {
      if (!state.program) throw new Error('drawArrays without a program');
      if (!state.vao) throw new Error('drawArrays without a VAO');
      if (count <= 0) throw new Error('drawArrays with zero vertices');
      log.push(`drawArrays:${mode}:${count}`);
    },
    drawElementsInstanced(mode, count, _type, _offset, instances) {
      if (!state.program) throw new Error('drawElementsInstanced without a program');
      if (!state.vao) throw new Error('drawElementsInstanced without a VAO');
      if (count <= 0) throw new Error('drawElementsInstanced with zero indices');
      if (instances <= 0) throw new Error('drawElementsInstanced with zero instances');
      log.push(`instanced:${count}x${instances}`);
    },
  };
}

function makeGame(ticks) {
  const game = new Game(4242, 3);
  for (let i = 0; i < (ticks || 0); i++) game.step();
  return game;
}

function makeCamera() {
  const cam = new Camera({ distance: 1400, aspect: 16 / 9 });
  cam.recompute();
  return cam;
}

// --- hull mapping ----------------------------------------------------------

test('every simulation ship type maps to a real hull mesh name', () => {
  const names = new Set(hullGroups().keys());
  for (const type of SHIP_TYPES) {
    const hull = hullNameForType(type);
    assert.ok(names.has(hull), `${type} -> ${hull} missing`);
  }
});

test('frigate variants share the frigate hull rather than silently becoming scouts', () => {
  assert.equal(hullNameForType('flak_frigate'), 'frigate');
  assert.equal(hullNameForType('ion_frigate'), 'frigate');
  assert.notEqual(hullNameForType('flak_frigate'), 'scout');
});

test('hull mapping is total over SHIP_TYPES and injective per distinct silhouette', () => {
  const groups = hullGroups();
  let mapped = 0;
  for (const list of groups.values()) mapped += list.length;
  assert.equal(mapped, SHIP_TYPES.length);
  assert.deepEqual(groups.get('frigate').sort(), ['flak_frigate', 'ion_frigate']);
});

test('unknown ship type falls back to scout instead of throwing', () => {
  assert.equal(hullNameForType('not_a_ship'), 'scout');
});

// --- instance packing ------------------------------------------------------

test('writeInstance packs sixteen matrix floats then four tint floats', () => {
  const batch = { data: new Float32Array(2 * INSTANCE_FLOATS), capacity: 2, count: 0 };
  const model = new Float32Array(16);
  for (let i = 0; i < 16; i++) model[i] = i + 1;
  assert.equal(writeInstance(batch, model, [0.1, 0.2, 0.3, 0.4]), true);
  assert.equal(batch.count, 1);
  for (let i = 0; i < 16; i++) assert.equal(batch.data[i], i + 1);
  assert.ok(Math.abs(batch.data[16] - 0.1) < 1e-6);
  assert.ok(Math.abs(batch.data[19] - 0.4) < 1e-6);
});

test('writeInstance refuses to overflow its batch', () => {
  const batch = { data: new Float32Array(1 * INSTANCE_FLOATS), capacity: 1, count: 0 };
  const model = new Float32Array(16);
  assert.equal(writeInstance(batch, model, [1, 1, 1, 1]), true);
  assert.equal(writeInstance(batch, model, [1, 1, 1, 1]), false);
  assert.equal(batch.count, 1);
});

test('INSTANCE_FLOATS matches the packed record size', () => {
  assert.equal(INSTANCE_FLOATS, 20);
});

// --- tint ------------------------------------------------------------------

test('tint uses the faction colour at full health', () => {
  const def = shipDef('scout');
  const tint = tintFor({ faction: 0, hp: def.hp, maxHp: def.hp }, def);
  const rgb = FACTION_COLOURS[0].rgb;
  assert.ok(Math.abs(tint[0] - rgb[0]) < 1e-6);
  assert.ok(Math.abs(tint[3]) < 1e-6, 'damage channel is zero when undamaged');
});

test('tint darkens and raises the damage channel as hull is lost', () => {
  const def = shipDef('destroyer');
  const full = tintFor({ faction: 1, hp: def.hp, maxHp: def.hp }, def);
  const hurt = tintFor({ faction: 1, hp: def.hp * 0.25, maxHp: def.hp }, def);
  assert.ok(hurt[0] < full[0]);
  assert.ok(hurt[3] > full[3]);
  assert.ok(hurt[3] <= 1 && hurt[3] >= 0);
});

test('tint clamps when hp is negative or above maximum', () => {
  const def = shipDef('scout');
  const dead = tintFor({ faction: 0, hp: -50, maxHp: def.hp }, def);
  const over = tintFor({ faction: 0, hp: def.hp * 3, maxHp: def.hp }, def);
  for (const t of [dead, over]) {
    for (const c of t) {
      assert.ok(Number.isFinite(c), 'no NaN in tint');
      assert.ok(c >= 0 && c <= 1.001, `channel ${c} in range`);
    }
  }
});

test('tint falls back to faction zero for an out-of-range faction index', () => {
  const def = shipDef('scout');
  const tint = tintFor({ faction: 99, hp: def.hp, maxHp: def.hp }, def);
  assert.ok(Number.isFinite(tint[0]));
});

// --- helpers ---------------------------------------------------------------

test('screenCoverage shrinks with distance', () => {
  const cam = makeCamera();
  const near = screenCoverage(cam, v3(0, 0, 0), 10);
  const far = screenCoverage(cam, v3(0, 0, 8000), 10);
  assert.ok(near > far);
  assert.ok(far > 0);
});

test('trailDirection is the negated unit forward vector', () => {
  const t = trailDirection({ fwd: v3(0, 0, -2) });
  assert.ok(Math.abs(t.z - 1) < 1e-6);
  assert.ok(Math.abs(t.x) < 1e-6);
});

// --- construction ----------------------------------------------------------

test('renderer constructs one instanced batch per hull mesh plus rock and marker', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, { width: 800, height: 600 });
  assert.ok(r.hulls.size >= 8);
  assert.ok(r.rock.vao);
  assert.ok(r.marker.vao);
  assert.ok(r.starCount > 0);
  assert.equal(r.lineCount, 0);
});

test('renderer creates four programs', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  assert.ok(r.progHull && r.progStar && r.progLine && r.progSky);
  assert.notEqual(r.progHull, r.progStar);
});

test('star buffer is allocated with four floats per star', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const alloc = gl.log.filter((l) => l.startsWith('bufferData:')).map((l) => Number(l.split(':')[1]));
  assert.ok(alloc.includes(r.starCount * 4 * 4), 'starfield allocation present');
});

// --- frame -----------------------------------------------------------------

test('a full frame issues a coherent command stream', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const game = makeGame(150);
  const cam = makeCamera();
  const stats = r.render(game.world, cam, {});
  assert.ok(stats.drawCalls >= 3, `drawCalls=${stats.drawCalls}`);
  assert.ok(stats.hullInstances > 0);
  assert.ok(gl.log.includes('clear'));
  assert.ok(gl.log.some((l) => l.startsWith('instanced:')));
});

test('hull instance count equals the number of living ships', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const game = makeGame(600);
  const cam = makeCamera();
  const stats = r.render(game.world, cam, {});
  const living = game.world.ships.filter((s) => s.alive).length;
  assert.equal(stats.hullInstances, living);
  assert.ok(living > 0);
});

test('repeated frames do not reallocate instance storage once warmed', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const game = makeGame(300);
  const cam = makeCamera();
  r.render(game.world, cam, {});
  const before = gl.log.filter((l) => l.startsWith('bufferData:')).length;
  for (let i = 0; i < 5; i++) r.render(game.world, cam, {});
  const after = gl.log.filter((l) => l.startsWith('bufferData:')).length;
  assert.equal(after, before, 'steady-state frames only use bufferSubData');
});

test('a frame with no living ships still renders sky and stars without error', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const game = makeGame(0);
  for (const s of game.world.ships) s.alive = false;
  const cam = makeCamera();
  const stats = r.render(game.world, cam, {});
  assert.equal(stats.hullInstances, 0);
  assert.ok(stats.drawCalls >= 2);
});

test('depth writes are restored after the sky and star passes', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const game = makeGame(100);
  r.render(game.world, makeCamera(), {});
  const masks = gl.log.filter((l) => l.startsWith('depthMask:'));
  assert.ok(masks.length >= 4);
  assert.equal(masks[masks.length - 1], 'depthMask:true', 'frame ends with depth writes enabled');
});

test('render survives a long-running simulation with combat and losses', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const game = makeGame(2500);
  const cam = makeCamera();
  const stats = r.render(game.world, cam, {});
  assert.ok(Number.isFinite(stats.hullInstances));
  assert.ok(game.world.ships.some((s) => !s.alive), 'simulation produced casualties to skip');
});

// --- overlay ---------------------------------------------------------------

test('beams become one line segment each, tinted by weapon class', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const game = makeGame(0);
  game.world.beams.length = 0;
  game.world.beams.push({ from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, weapon: 'ion', faction: 0, lethal: false });
  game.world.beams.push({ from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 10 }, weapon: 'kinetic', faction: 1, lethal: true });
  r.buildOverlay(game.world, {});
  assert.equal(r.lineCount, 4, 'two segments, two vertices each');
  const ionR = r.lineData[3];
  const kinR = r.lineData[14 + 3];
  assert.notEqual(ionR, kinR, 'weapon classes have distinct colours');
});

test('a lethal beam is drawn at full alpha', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const game = makeGame(0);
  game.world.beams.length = 0;
  game.world.beams.push({ from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, weapon: 'ion', faction: 0, lethal: true });
  r.buildOverlay(game.world, {});
  assert.ok(Math.abs(r.lineData[6] - 1) < 1e-6);
});

test('selection produces a ring, a ground stalk and a health ring when damaged', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const game = makeGame(50);
  game.world.beams.length = 0;
  const ship = game.world.ships.find((s) => s.alive);
  ship.hp = ship.maxHp * 0.5;
  r.buildOverlay(game.world, { selected: [ship.id] });
  // 20 ring segments + 1 stalk + 16 health segments = 37 segments = 74 vertices
  assert.equal(r.lineCount, (20 + 1 + 16) * 2);
});

test('an undamaged selected ship omits the health ring', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const game = makeGame(0);
  game.world.beams.length = 0;
  const ship = game.world.ships.find((s) => s.alive);
  ship.hp = ship.maxHp;
  r.buildOverlay(game.world, { selected: new Set([ship.id]) });
  assert.equal(r.lineCount, (20 + 1) * 2);
});

test('selecting a dead or unknown id is ignored rather than throwing', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const game = makeGame(0);
  game.world.beams.length = 0;
  r.buildOverlay(game.world, { selected: [999999] });
  assert.equal(r.lineCount, 0);
});

test('the move marker fades out and disappears after its lifetime', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const game = makeGame(0);
  game.world.beams.length = 0;
  r.buildOverlay(game.world, { marker: { x: 100, y: 0, z: 50 }, markerAge: 0 });
  const fresh = r.lineCount;
  assert.ok(fresh > 0);
  r.buildOverlay(game.world, { marker: { x: 100, y: 0, z: 50 }, markerAge: 5 });
  assert.equal(r.lineCount, 0, 'expired marker draws nothing');
});

test('the drag box contributes exactly four closed segments', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const game = makeGame(0);
  game.world.beams.length = 0;
  r.buildOverlay(game.world, { dragBox: { x0: -10, z0: -10, x1: 10, z1: 10 } });
  assert.equal(r.lineCount, 8);
});

test('the line buffer grows instead of dropping segments', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const start = r.lineCapacity;
  r.resetLines();
  const wanted = start + 200;
  for (let i = 0; i < wanted; i++) r.pushLine(i, 0, 0, i, 1, 0, 1, 1, 1, 1);
  assert.equal(r.lineCount, wanted * 2);
  assert.ok(r.lineCapacity > start);
  assert.equal(r.lineData[(wanted - 1) * 2 * 7], wanted - 1, 'last segment survived the grow');
});

test('pushRing closes the loop back on its starting point', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  r.resetLines();
  r.pushRing(0, 0, 0, 100, 1, 1, 1, 1, 8);
  assert.equal(r.lineCount, 16);
  const firstX = r.lineData[0];
  const lastX = r.lineData[(r.lineCount - 1) * 7];
  assert.ok(Math.abs(firstX - lastX) < 1e-3, 'ring is closed');
});

test('overlay is rebuilt from scratch each frame', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const game = makeGame(0);
  game.world.beams.length = 0;
  r.buildOverlay(game.world, { dragBox: { x0: 0, z0: 0, x1: 1, z1: 1 } });
  assert.equal(r.lineCount, 8);
  r.buildOverlay(game.world, {});
  assert.equal(r.lineCount, 0);
});

// --- asteroids -------------------------------------------------------------

test('every asteroid is drawn and depleted rocks are darker', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const game = makeGame(0);
  const cam = makeCamera();
  game.world.asteroids[0].resource = game.world.asteroids[0].maxResource;
  game.world.asteroids[1].resource = 0;
  r.drawShips(game.world, cam);
  r.drawAsteroids(game.world, cam);
  assert.equal(r.rock.count, game.world.asteroids.length);
  const rich = r.rock.data[16];
  const spent = r.rock.data[INSTANCE_FLOATS + 16];
  assert.ok(spent < rich, 'depleted asteroid renders darker');
});

// --- teardown --------------------------------------------------------------

test('dispose releases every GPU object it created', () => {
  const gl = fakeGl();
  const r = new Renderer(gl, {});
  const before = gl.live.size;
  r.dispose();
  assert.ok(gl.live.size < before, 'objects were deleted');
  assert.ok(before > 10);
});
