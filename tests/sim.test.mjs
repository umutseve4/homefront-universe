import test from 'node:test';
import assert from 'node:assert/strict';

import { clamp, lerp, smoothstep, v3add, v3sub, v3len, v3norm, v3dot, v3dist, mat4identity, mat4mul, mat4perspective, mat4lookAt, EPS } from '../src/core/math.js';
import { Rng, hashU32, hash3 } from '../src/core/rng.js';
import { ARMOUR, WEAPON, ROLE, SHIPS, SHIP_TYPES, BUILDABLE, RULES, damageMultiplier, shipDef } from '../src/sim/defs.js';
import { World, ORDER } from '../src/sim/world.js';
import { formationOffset, FORMATIONS, steerTo, integrate, distanceTo } from '../src/sim/movement.js';
import { applyDamage, acquireTarget } from '../src/sim/combat.js';
import { nearestAsteroid, nearestDropoff, canAfford, queueBuild, updateProduction } from '../src/sim/economy.js';
import { Game, DT } from '../src/sim/game.js';

// `Game.advance` consumes wall-clock seconds and is frame-rate capped, so the
// tests drive the fixed timestep directly to get an exact tick count.
function run(game, ticks) {
  for (let i = 0; i < ticks; i += 1) game.step();
  return game;
}

// ---------------------------------------------------------------- core maths

test('clamp bounds both ends and passes interior values through', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.25, 0, 1), 0.25);
});

test('lerp and smoothstep hit their endpoints exactly', () => {
  assert.equal(lerp(2, 6, 0), 2);
  assert.equal(lerp(2, 6, 1), 6);
  assert.equal(lerp(2, 6, 0.5), 4);
  assert.equal(smoothstep(0, 1, 0), 0);
  assert.equal(smoothstep(0, 1, 1), 1);
  assert.ok(Math.abs(smoothstep(0, 1, 0.5) - 0.5) < EPS);
});

test('vector helpers agree with hand-computed values', () => {
  assert.deepEqual(v3add({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }), { x: 5, y: 7, z: 9 });
  assert.deepEqual(v3sub({ x: 4, y: 5, z: 6 }, { x: 1, y: 2, z: 3 }), { x: 3, y: 3, z: 3 });
  assert.equal(v3len({ x: 3, y: 4, z: 0 }), 5);
  assert.equal(v3dot({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), 0);
  assert.equal(v3dist({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 7 }), 7);
});

test('v3norm returns unit length and tolerates the zero vector', () => {
  const n = v3norm({ x: 3, y: 4, z: 12 });
  assert.ok(Math.abs(v3len(n) - 1) < 1e-9);
  const z = v3norm({ x: 0, y: 0, z: 0 });
  assert.ok(Number.isFinite(z.x) && Number.isFinite(z.y) && Number.isFinite(z.z));
});

test('identity is the multiplicative unit for mat4mul', () => {
  const p = mat4perspective(mat4identity(), 1.0, 1.6, 1, 5000);
  const i = mat4identity();
  const r = mat4mul(mat4identity(), p, i);
  for (let k = 0; k < 16; k += 1) assert.ok(Math.abs(r[k] - p[k]) < 1e-9);
});

test('lookAt places the eye at the origin of view space', () => {
  const eye = { x: 100, y: 60, z: 240 };
  const v = mat4lookAt(mat4identity(), eye, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  // The translated eye must map to (0,0,0).
  const x = v[0] * eye.x + v[4] * eye.y + v[8] * eye.z + v[12];
  const y = v[1] * eye.x + v[5] * eye.y + v[9] * eye.z + v[13];
  const z = v[2] * eye.x + v[6] * eye.y + v[10] * eye.z + v[14];
  // Float32Array storage: a 240-unit eye distance leaves ~2e-6 of residue.
  assert.ok(Math.abs(x) < 1e-4 && Math.abs(y) < 1e-4 && Math.abs(z) < 1e-4);
});

// ------------------------------------------------------------------- the rng

test('Rng is reproducible for a given seed and diverges for another', () => {
  const a = new Rng(99);
  const b = new Rng(99);
  const c = new Rng(100);
  const sa = [];
  const sb = [];
  const sc = [];
  for (let i = 0; i < 64; i += 1) {
    sa.push(a.next());
    sb.push(b.next());
    sc.push(c.next());
  }
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
});

test('Rng.next stays in [0,1) and int stays in range', () => {
  const r = new Rng(7);
  for (let i = 0; i < 2000; i += 1) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1);
    const n = r.int(0, 4);
    assert.ok(Number.isInteger(n) && n >= 0 && n <= 4);
  }
});

test('Rng.onSphere returns unit vectors', () => {
  const r = new Rng(3);
  for (let i = 0; i < 200; i += 1) {
    assert.ok(Math.abs(v3len(r.onSphere()) - 1) < 1e-6);
  }
});

test('hash functions are pure and 32-bit', () => {
  assert.equal(hashU32(12345), hashU32(12345));
  assert.ok(hashU32(12345) >= 0 && hashU32(12345) <= 0xffffffff);
  assert.equal(hash3(1, 2, 3), hash3(1, 2, 3));
  assert.notEqual(hash3(1, 2, 3), hash3(3, 2, 1));
});

// ------------------------------------------------------------ ship datatable

test('every hull carries the fields the simulation reads', () => {
  for (const type of SHIP_TYPES) {
    const d = SHIPS[type];
    assert.ok(d.name, `${type} name`);
    assert.ok(Object.values(ROLE).includes(d.role), `${type} role`);
    assert.ok(Object.values(ARMOUR).includes(d.armour), `${type} armour`);
    assert.ok(d.hp > 0 && d.speed > 0 && d.turn > 0 && d.radius > 0, `${type} physicals`);
    assert.ok(typeof d.fireInterval === 'number', `${type} fireInterval`);
    if (d.dps > 0) {
      assert.ok(Object.values(WEAPON).includes(d.weapon), `${type} weapon`);
      assert.ok(d.fireInterval > 0 && d.range > 0, `${type} gunnery`);
    }
  }
});

test('every buildable type exists and has a positive cost and build time', () => {
  for (const type of BUILDABLE) {
    const d = shipDef(type);
    assert.ok(d, type);
    assert.ok(d.cost > 0 && d.build > 0, `${type} economics`);
  }
});

test('the damage table is defined for every weapon/armour pair', () => {
  for (const w of Object.values(WEAPON)) {
    for (const a of Object.values(ARMOUR)) {
      const m = damageMultiplier(w, a);
      assert.ok(m > 0 && m < 4, `${w} vs ${a} = ${m}`);
    }
  }
});

test('ion beats heavy armour and kinetic beats light armour', () => {
  assert.ok(damageMultiplier(WEAPON.ION, ARMOUR.HEAVY) > damageMultiplier(WEAPON.ION, ARMOUR.LIGHT));
  assert.ok(damageMultiplier(WEAPON.KINETIC, ARMOUR.LIGHT) > damageMultiplier(WEAPON.KINETIC, ARMOUR.HEAVY));
});

// ------------------------------------------------------------------ the world

test('spawnShip registers the ship in the index and the faction population', () => {
  const w = new World(1);
  w.addFaction(0, false);
  const s = w.spawnShip('interceptor', 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  assert.equal(w.get(s.id), s);
  assert.equal(w.ships.length, 1);
  assert.equal(w.factions[0].population, SHIPS.interceptor.cap);
  assert.ok(s.alive && s.hp === SHIPS.interceptor.hp);
});

test('allocId never repeats', () => {
  const w = new World(2);
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) {
    const id = w.allocId();
    assert.ok(!seen.has(id));
    seen.add(id);
  }
});

test('queryRadius finds exactly the ships inside the radius', () => {
  const w = new World(3);
  w.addFaction(0, false);
  const inside = [];
  for (let i = 0; i < 40; i += 1) {
    const p = { x: i * 120, y: 0, z: 0 };
    const s = w.spawnShip('scout', 0, p, { x: 0, y: 0, z: -1 });
    if (p.x <= 1000) inside.push(s.id);
  }
  w.rebuildGrid();
  const hits = w.queryRadius({ x: 0, y: 0, z: 0 }, 1000, []);
  const ids = hits.filter((s) => v3dist(s.pos, { x: 0, y: 0, z: 0 }) <= 1000).map((s) => s.id).sort();
  assert.deepEqual(ids, inside.slice().sort());
});

test('livingShips filters by faction and by life', () => {
  const w = new World(4);
  w.addFaction(0, false);
  w.addFaction(1, true);
  const a = w.spawnShip('scout', 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  w.spawnShip('scout', 1, { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  assert.equal(w.livingShips(0).length, 1);
  assert.equal(w.livingShips().length, 2);
  a.alive = false;
  assert.equal(w.livingShips(0).length, 0);
});

// --------------------------------------------------------------- the movement

test('formation offsets are deterministic and distinct per slot', () => {
  for (const shape of FORMATIONS) {
    const seen = new Set();
    for (let slot = 0; slot < 12; slot += 1) {
      const a = formationOffset(shape, slot, 100);
      const b = formationOffset(shape, slot, 100);
      assert.deepEqual(a, b, `${shape} slot ${slot} must be pure`);
      const key = `${a.x.toFixed(4)}|${a.y.toFixed(4)}|${a.z.toFixed(4)}`;
      assert.ok(!seen.has(key), `${shape} slot ${slot} collides`);
      seen.add(key);
    }
  }
});

test('steerTo turns a hull that is pointing exactly backwards', () => {
  // Regression: a lerp-based turn is degenerate at 180 degrees and leaves the
  // ship facing away from its target forever.
  const w = new World(5);
  w.addFaction(0, false);
  const s = w.spawnShip('collector', 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  const target = { x: 0, y: 0, z: -4000 };
  for (let i = 0; i < 200; i += 1) steerTo(s, target, DT, 100);
  assert.ok(s.fwd.z < -0.9, `expected the hull to come about, fwd.z=${s.fwd.z}`);
});

test('steerTo brings a hull to rest inside the arrive radius', () => {
  const w = new World(6);
  w.addFaction(0, false);
  const s = w.spawnShip('collector', 0, { x: 0, y: 0, z: 900 }, { x: 0, y: 0, z: -1 });
  const target = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 900; i += 1) {
    steerTo(s, target, DT, 160);
    integrate(s, DT, w.bounds);
  }
  assert.ok(v3dist(s.pos, target) < 160, `parked at ${v3dist(s.pos, target)}`);
  assert.ok(v3len(s.vel) < 1, `residual speed ${v3len(s.vel)}`);
});

test('integrate is the only writer of position', () => {
  const w = new World(7);
  w.addFaction(0, false);
  const s = w.spawnShip('interceptor', 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  const before = { ...s.pos };
  steerTo(s, { x: 0, y: 0, z: -5000 }, DT, 200);
  assert.deepEqual(s.pos, before, 'steerTo must not move the ship');
  integrate(s, DT, w.bounds);
  assert.notDeepEqual(s.pos, before, 'integrate must move the ship');
});

test('integrate clamps the ship inside the world bounds', () => {
  const w = new World(8);
  w.addFaction(0, false);
  const s = w.spawnShip('scout', 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  s.vel = { x: 1e9, y: 1e9, z: 1e9 };
  integrate(s, DT, w.bounds);
  assert.ok(Math.abs(s.pos.x) <= w.bounds);
  assert.ok(Math.abs(s.pos.y) <= w.bounds * 0.35);
  assert.ok(Math.abs(s.pos.z) <= w.bounds);
});

test('distanceTo matches the raw vector distance', () => {
  const w = new World(9);
  w.addFaction(0, false);
  const a = w.spawnShip('scout', 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  const b = w.spawnShip('scout', 0, { x: 300, y: 400, z: 0 }, { x: 0, y: 0, z: -1 });
  assert.ok(Math.abs(distanceTo(a, b) - 500) < 1e-9);
});

// ----------------------------------------------------------------- the combat

test('applyDamage kills exactly once and books the kill to the attacker', () => {
  const w = new World(10);
  w.addFaction(0, false);
  w.addFaction(1, true);
  const gun = w.spawnShip('destroyer', 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  const mark = w.spawnShip('scout', 1, { x: 100, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  const popBefore = w.factions[1].population;
  applyDamage(w, mark, 1e9, gun);
  applyDamage(w, mark, 1e9, gun);
  assert.equal(mark.alive, false);
  assert.equal(w.factions[0].killed, 1, 'a corpse may only be killed once');
  assert.equal(w.factions[1].lost, 1);
  assert.equal(w.factions[1].population, popBefore - SHIPS.scout.cap);
});

test('acquireTarget picks an enemy and never a friend', () => {
  const w = new World(11);
  w.addFaction(0, false);
  w.addFaction(1, true);
  const gun = w.spawnShip('interceptor', 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  w.spawnShip('scout', 0, { x: 200, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  const foe = w.spawnShip('scout', 1, { x: 400, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  w.rebuildGrid();
  const t = acquireTarget(w, gun);
  assert.ok(t);
  assert.equal(t.faction, 1);
  assert.equal(t.id, foe.id);
});

test('acquireTarget returns null when the nearest enemy is out of sensor range', () => {
  const w = new World(12);
  w.addFaction(0, false);
  w.addFaction(1, true);
  const gun = w.spawnShip('interceptor', 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  w.spawnShip('scout', 1, { x: SHIPS.interceptor.sensor * 4, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  w.rebuildGrid();
  assert.equal(acquireTarget(w, gun), null);
});

// ---------------------------------------------------------------- the economy

test('nearestAsteroid ignores exhausted rocks', () => {
  const w = new World(13);
  const near = w.addAsteroid({ x: 100, y: 0, z: 0 }, 0, 60);
  const far = w.addAsteroid({ x: 900, y: 0, z: 0 }, 5000, 60);
  assert.equal(nearestAsteroid(w, { x: 0, y: 0, z: 0 }).id, far.id);
  near.resource = 1000;
  assert.equal(nearestAsteroid(w, { x: 0, y: 0, z: 0 }).id, near.id);
});

test('nearestDropoff only returns living friendly producers', () => {
  const w = new World(14);
  w.addFaction(0, false);
  w.addFaction(1, true);
  const col = w.spawnShip('collector', 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  w.spawnShip('mothership', 1, { x: 50, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  assert.equal(nearestDropoff(w, col), null, 'an enemy hull is not a dropoff');
  const mine = w.spawnShip('carrier', 0, { x: 800, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  assert.equal(nearestDropoff(w, col).id, mine.id);
  mine.alive = false;
  assert.equal(nearestDropoff(w, col), null);
});

test('canAfford respects both the treasury and the population cap', () => {
  const w = new World(15);
  w.addFaction(0, false);
  w.factions[0].resources = 0;
  assert.equal(canAfford(w, 0, 'interceptor'), false);
  w.factions[0].resources = 100000;
  assert.equal(canAfford(w, 0, 'interceptor'), true);
  w.factions[0].population = RULES.populationCap;
  assert.equal(canAfford(w, 0, 'interceptor'), false);
});

test('queueBuild debits the treasury and updateProduction spawns the hull', () => {
  const w = new World(16);
  w.addFaction(0, false);
  const yard = w.spawnShip('mothership', 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  w.factions[0].resources = 5000;
  const before = w.factions[0].resources;
  assert.equal(queueBuild(w, yard, 'interceptor'), true);
  assert.equal(w.factions[0].resources, before - SHIPS.interceptor.cost);
  assert.equal(yard.buildQueue.length, 1);
  let born = null;
  for (let i = 0; i < 4000 && !born; i += 1) born = updateProduction(w, yard, DT);
  assert.ok(born, 'the yard must eventually deliver the hull');
  assert.equal(born.type, 'interceptor');
  assert.equal(born.faction, 0);
  assert.equal(yard.buildQueue.length, 0);
});

test('a non-producing hull refuses build orders', () => {
  const w = new World(17);
  w.addFaction(0, false);
  const s = w.spawnShip('interceptor', 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  w.factions[0].resources = 99999;
  assert.equal(queueBuild(w, s, 'scout'), false);
  assert.equal(updateProduction(w, s, DT), null);
});

test('a collector completes a full harvest round trip', () => {
  // Regression: the collector used to sail past its dropoff and shuttle a
  // nearly-full hold back and forth without ever banking the cargo.
  const g = new Game(4242, 2);
  const before = g.world.factions[0].harvested;
  run(g, 3000);
  const after = g.world.factions[0].harvested;
  assert.ok(after > before, 'the faction must bank some cargo');
  assert.ok(
    after >= SHIPS.collector.capacity * 2,
    `expected at least two full loads, banked ${after}`,
  );
});

// -------------------------------------------------------------------- the game

test('two runs from the same seed produce the same checksum', () => {
  const a = new Game(2024, 3);
  const b = new Game(2024, 3);
  run(a, 1500);
  run(b, 1500);
  assert.equal(a.checksum(), b.checksum());
  assert.equal(a.world.tick, b.world.tick);
});

test('advancing in two halves equals advancing in one go', () => {
  const a = new Game(31337, 2);
  const b = new Game(31337, 2);
  run(a, 1200);
  run(b, 600);
  run(b, 600);
  assert.equal(a.checksum(), b.checksum());
});

test('different seeds diverge', () => {
  const a = new Game(1, 2);
  const b = new Game(2, 2);
  run(a, 900);
  run(b, 900);
  assert.notEqual(a.checksum(), b.checksum());
});

test('the checksum reacts to state', () => {
  const g = new Game(55, 2);
  const c0 = g.checksum();
  run(g, 300);
  assert.notEqual(g.checksum(), c0);
});

test('a fresh skirmish is well formed', () => {
  const g = new Game(808, 3);
  assert.equal(g.world.factions.length, 3);
  assert.ok(g.world.asteroids.length > 0);
  for (let f = 0; f < 3; f += 1) {
    const mine = g.world.livingShips(f);
    assert.ok(mine.length > 0, `faction ${f} must start with ships`);
    assert.ok(mine.some((s) => s.def.produces), `faction ${f} must start with a yard`);
    assert.ok(mine.some((s) => s.def.capacity), `faction ${f} must start with a collector`);
  }
});

test('no ship ever leaves the world bounds', () => {
  const g = new Game(9001, 3);
  run(g, 1500);
  for (const s of g.world.ships) {
    assert.ok(Math.abs(s.pos.x) <= g.world.bounds + 1, `x=${s.pos.x}`);
    assert.ok(Math.abs(s.pos.y) <= g.world.bounds * 0.35 + 1, `y=${s.pos.y}`);
    assert.ok(Math.abs(s.pos.z) <= g.world.bounds + 1, `z=${s.pos.z}`);
  }
});

test('no ship state goes non-finite or negative', () => {
  const g = new Game(6060, 3);
  run(g, 1500);
  for (const s of g.world.ships) {
    for (const k of ['x', 'y', 'z']) {
      assert.ok(Number.isFinite(s.pos[k]), `pos.${k}`);
      assert.ok(Number.isFinite(s.vel[k]), `vel.${k}`);
      assert.ok(Number.isFinite(s.fwd[k]), `fwd.${k}`);
    }
    assert.ok(Math.abs(v3len(s.fwd) - 1) < 1e-6, 'fwd must stay normalised');
    assert.ok(s.hp <= s.def.hp, 'hp must never exceed the hull maximum');
    if (s.alive) assert.ok(s.hp > 0, 'a living ship must have positive hp');
    assert.ok(s.cargo >= 0);
  }
});

test('population accounting matches the living fleet', () => {
  const g = new Game(4711, 3);
  run(g, 1500);
  for (let f = 0; f < 3; f += 1) {
    const expect = g.world.livingShips(f).reduce((n, s) => n + s.def.cap, 0);
    assert.equal(g.world.factions[f].population, expect, `faction ${f} population`);
  }
});

test('kills and losses balance across all factions', () => {
  const g = new Game(2718, 3);
  run(g, 2000);
  const killed = g.world.factions.reduce((n, f) => n + f.killed, 0);
  const lost = g.world.factions.reduce((n, f) => n + f.lost, 0);
  const dead = g.world.ships.filter((s) => !s.alive).length;
  assert.equal(killed, lost, 'every kill is exactly one loss');
  assert.equal(lost, dead, 'every loss is exactly one corpse');
});

test('resources never go negative', () => {
  const g = new Game(1234, 3);
  run(g, 2000);
  for (const f of g.world.factions) {
    assert.ok(f.resources >= 0, `faction ${f.id} treasury ${f.resources}`);
    assert.ok(f.harvested >= 0);
  }
});

test('orderMove overrides the standing order and moves the hull', () => {
  const g = new Game(77, 2);
  const s = g.world.livingShips(0).find((x) => !x.def.produces);
  const start = { ...s.pos };
  const dest = { x: s.pos.x + 2600, y: s.pos.y, z: s.pos.z };
  g.orderMove([s.id], dest, 'delta');
  assert.equal(s.order.kind, ORDER.MOVE);
  run(g, 600);
  assert.ok(v3dist(s.pos, start) > 200, 'the hull must actually travel');
});

test('orderAttack marks the requested target', () => {
  const g = new Game(88, 2);
  const mine = g.world.livingShips(0).find((x) => x.def.dps > 0);
  const foe = g.world.livingShips(1)[0];
  g.orderAttack([mine.id], foe.id);
  assert.equal(mine.order.kind, ORDER.ATTACK);
  assert.equal(mine.order.targetId, foe.id);
});

test('build routes through the treasury', () => {
  const g = new Game(99, 2);
  const yard = g.world.livingShips(0).find((s) => s.def.produces);
  g.world.factions[0].resources = 0;
  assert.equal(g.build(0, 'interceptor'), false);
  g.world.factions[0].resources = 9999;
  assert.equal(g.build(0, 'interceptor'), true);
  assert.ok(yard.buildQueue.length > 0);
});

test('victory triggers when a faction loses every producer', () => {
  const g = new Game(1555, 2);
  for (const s of g.world.livingShips(1)) {
    if (s.def.produces) {
      s.alive = false;
      g.world.factions[1].population -= s.def.cap;
    }
  }
  g.step();
  assert.equal(g.over, true);
  assert.equal(g.winner, 0);
});

test('a fresh game is not already over', () => {
  const g = new Game(1556, 3);
  assert.equal(g.over, false);
  assert.equal(g.winner, -1);
});
