import { World } from './world.js';
import { FACTION_COLOURS, RULES } from './defs.js';
import { Rng } from '../core/rng.js';

// Map generation is pure: the same seed and the same faction count always
// produce the same asteroid field and the same starting fleets.

export const START_FLEET = [
  ['mothership', 1],
  ['collector', 3],
  ['scout', 2],
  ['interceptor', 4],
  ['corvette', 2],
];

export function factionStart(index, count, radius) {
  const a = (index / count) * Math.PI * 2;
  return {
    x: Math.cos(a) * radius,
    y: 0,
    z: Math.sin(a) * radius,
  };
}

// A small, close cluster next to a starting position. Without this the
// economy stalls: collectors spend the whole match in transit.
export function generateHomePatch(world, rng, origin, count) {
  const made = [];
  for (let i = 0; i < count; i++) {
    const a = rng.next() * Math.PI * 2;
    const r = rng.range(RULES.homePatchMin, RULES.homePatchMax);
    const y = rng.range(-1, 1) * 260;
    const resource = Math.round(rng.range(RULES.asteroidMin, RULES.asteroidMax));
    const radius = 60 + (resource / RULES.asteroidMax) * 140;
    made.push(
      world.addAsteroid(
        { x: origin.x + Math.cos(a) * r, y: origin.y + y, z: origin.z + Math.sin(a) * r },
        resource,
        radius,
      ),
    );
  }
  return made;
}

// The contested central belt: richer, but far from every home position.
export function generateAsteroids(world, rng, count) {
  const belt = world.bounds * 0.52;
  for (let i = 0; i < count; i++) {
    // Two bands: a dense inner ring and a sparse outer scatter.
    const outer = i % 3 === 0;
    const r = outer
      ? belt * rng.range(1.05, 1.45)
      : belt * rng.range(0.45, 0.95);
    const a = rng.next() * Math.PI * 2;
    const y = rng.range(-1, 1) * world.bounds * 0.08;
    const resource = Math.round(rng.range(RULES.asteroidMin, RULES.asteroidMax));
    const radius = 60 + (resource / RULES.asteroidMax) * 140;
    world.addAsteroid({ x: Math.cos(a) * r, y, z: Math.sin(a) * r }, resource, radius);
  }
  return world.asteroids;
}

export function generateSkirmish(seed, factionCount) {
  const n = Math.max(2, Math.min(FACTION_COLOURS.length, factionCount | 0));
  const world = new World(seed);
  const rng = new Rng(seed);

  for (let i = 0; i < n; i++) {
    world.addFaction(i, FACTION_COLOURS[i], i === 0);
  }

  const startRadius = world.bounds * 0.62;
  const origins = [];
  for (let i = 0; i < n; i++) origins.push(factionStart(i, n, startRadius));

  generateAsteroids(world, rng, RULES.asteroidCount);
  for (const origin of origins) {
    generateHomePatch(world, rng, origin, RULES.homePatchCount);
  }

  for (let i = 0; i < n; i++) {
    const origin = origins[i];
    // Face the centre of the map.
    const len = Math.hypot(origin.x, origin.z) || 1;
    const fwd = { x: -origin.x / len, y: 0, z: -origin.z / len };
    let slot = 0;
    for (const [type, amount] of START_FLEET) {
      for (let k = 0; k < amount; k++) {
        const off = {
          x: ((slot % 4) - 1.5) * 260,
          y: Math.floor(slot / 8) * 120,
          z: (Math.floor(slot / 4) % 2) * 260,
        };
        world.spawnShip(
          type,
          i,
          { x: origin.x + off.x, y: origin.y + off.y, z: origin.z + off.z },
          fwd,
        );
        slot++;
      }
    }
  }

  return world;
}
