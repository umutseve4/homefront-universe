import { ORDER } from './world.js';
import { RULES, shipDef } from './defs.js';
import { steerTo } from './movement.js';
import { v3dist } from '../core/math.js';

// Nearest asteroid that still holds resource.
export function nearestAsteroid(world, pos) {
  let best = null;
  let bestD = Infinity;
  for (const a of world.asteroids) {
    if (a.resource <= 0) continue;
    const d = v3dist(a.pos, pos);
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

export function nearestDropoff(world, ship) {
  let best = null;
  let bestD = Infinity;
  for (const s of world.ships) {
    if (!s.alive || s.faction !== ship.faction || !s.def.produces) continue;
    const d = v3dist(s.pos, ship.pos);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

// Collector state machine: seek -> harvest -> return -> unload.
export function updateHarvest(world, ship, dt) {
  const def = ship.def;
  if (!def.capacity) return;
  const f = world.factions[ship.faction];

  // A full hold latches an explicit unload state. Without the latch the very
  // first tick of unloading drops cargo below capacity, the ship flips back to
  // "seek asteroid" and shuttles a nearly-full hold back and forth forever.
  if (ship.cargo >= def.capacity) ship.order = { kind: ORDER.HARVEST, asteroidId: 0, unload: true };

  if (ship.order.unload) {
    const home = nearestDropoff(world, ship);
    if (!home) {
      ship.order = { kind: ORDER.HARVEST, asteroidId: 0 };
      return;
    }
    // The arrive radius and the working radius must agree, otherwise the
    // collector parks outside the range in which it is allowed to unload.
    const dock = home.def.radius + def.radius + 40;
    const d = steerTo(ship, home.pos, dt, dock);
    if (d < dock) {
      const moved = Math.min(ship.cargo, RULES.collectorUnloadRate * dt);
      ship.cargo -= moved;
      f.resources += moved;
      f.harvested += moved;
      if (ship.cargo <= 0.001) {
        ship.cargo = 0;
        ship.order = { kind: ORDER.HARVEST, asteroidId: 0 };
      }
    }
    return;
  }

  let a = null;
  if (ship.order.kind === ORDER.HARVEST && ship.order.asteroidId) {
    a = world.asteroids.find((x) => x.id === ship.order.asteroidId && x.resource > 0) || null;
  }
  if (!a) {
    a = nearestAsteroid(world, ship.pos);
    if (!a) {
      ship.order = { kind: ORDER.IDLE };
      return;
    }
    ship.order = { kind: ORDER.HARVEST, asteroidId: a.id };
  }

  const reach = a.radius + def.radius + 30;
  const d = steerTo(ship, a.pos, dt, reach);
  if (d < reach) {
    const taken = Math.min(def.harvestRate * dt, a.resource, def.capacity - ship.cargo);
    a.resource -= taken;
    ship.cargo += taken;
    if (a.resource <= 0) ship.order = { kind: ORDER.HARVEST, asteroidId: 0 };
  }
}

export function canAfford(world, faction, type) {
  const def = shipDef(type);
  const f = world.factions[faction];
  if (f.resources < def.cost) return false;
  if (f.population + def.cap > RULES.populationCap) return false;
  return true;
}

// Queue a hull at a production ship. Returns true if the order was accepted.
export function queueBuild(world, producer, type) {
  if (!producer.def.produces || !producer.alive) return false;
  if (!canAfford(world, producer.faction, type)) return false;
  const def = shipDef(type);
  world.factions[producer.faction].resources -= def.cost;
  producer.buildQueue.push({ type, remaining: def.build });
  return true;
}

export function updateProduction(world, producer, dt) {
  if (!producer.def.produces) return null;
  const job = producer.buildQueue[0];
  if (!job) return null;
  job.remaining -= dt;
  if (job.remaining > 0) return null;
  producer.buildQueue.shift();
  const r = producer.def.radius + 90;
  const seed = (world.tick * 2654435761 + producer.id) >>> 0;
  const a = ((seed % 1024) / 1024) * Math.PI * 2;
  const pos = {
    x: producer.pos.x + Math.cos(a) * r,
    y: producer.pos.y + (((seed >>> 10) % 64) / 64 - 0.5) * 60,
    z: producer.pos.z + Math.sin(a) * r,
  };
  const ship = world.spawnShip(job.type, producer.faction, pos, producer.fwd);
  world.events.push({ tick: world.tick, kind: 'built', id: ship.id, type: job.type, faction: producer.faction });
  return ship;
}
