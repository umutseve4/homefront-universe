import { ORDER } from './world.js';
import { RULES } from './defs.js';
import { generateSkirmish } from './mapgen.js';
import { advanceOrders, updateMovement, integrate, separate, formationOffset } from './movement.js';
import { updateCombat } from './combat.js';
import { updateHarvest, updateProduction, queueBuild } from './economy.js';
import { AiPlayer } from './ai.js';

// Fixed timestep. The simulation never reads wall-clock time; `step(dt)` is the
// only way it advances, which is what makes the headless runner and the browser
// produce identical state for the same seed and tick count.

export const DT = 1 / RULES.tickRate;

export class Game {
  constructor(seed, factionCount) {
    this.seed = seed >>> 0;
    this.factionCount = Math.max(2, factionCount | 0 || 2);
    this.world = generateSkirmish(this.seed, this.factionCount);
    this.ai = [];
    for (const f of this.world.factions) {
      if (!f.isHuman) this.ai.push(new AiPlayer(this.world, f.index, this.seed));
    }
    this.accumulator = 0;
    this.over = false;
    this.winner = -1;
    // Human collectors start working immediately; idle collectors are useless.
    for (const s of this.world.livingShips()) {
      if (s.def.capacity) s.order = { kind: ORDER.HARVEST, asteroidId: 0 };
    }
  }

  // Advance one fixed tick.
  step() {
    const w = this.world;
    const dt = DT;
    w.beams.length = 0;
    w.rebuildGrid();

    for (const ai of this.ai) ai.update(dt);

    for (const s of w.ships) {
      if (!s.alive) continue;
      advanceOrders(s);
      if (s.def.capacity) {
        if (s.order.kind === ORDER.MOVE) updateMovement(w, s, dt);
        else updateHarvest(w, s, dt);
      } else if (s.order.kind === ORDER.MOVE) {
        updateMovement(w, s, dt);
        updateCombat(w, s, dt, true);
      } else {
        updateCombat(w, s, dt, false);
      }
      if (s.def.produces) updateProduction(w, s, dt);
    }

    for (const s of w.ships) {
      if (!s.alive) continue;
      separate(w, s, dt);
      integrate(s, dt, w.bounds);
    }

    w.compact();
    w.tick += 1;
    w.time += dt;
    this.checkVictory();
    return w.tick;
  }

  checkVictory() {
    const w = this.world;
    let aliveCount = 0;
    let last = -1;
    for (const f of w.factions) {
      if (!f.alive) continue;
      const hasProducer = w.livingShips(f.index).some((s) => s.def.produces);
      if (!hasProducer) {
        f.alive = false;
        w.events.push({ tick: w.tick, kind: 'eliminated', faction: f.index });
        continue;
      }
      aliveCount++;
      last = f.index;
    }
    if (aliveCount <= 1 && !this.over) {
      this.over = true;
      this.winner = last;
      w.events.push({ tick: w.tick, kind: 'victory', faction: last });
    }
  }

  // Wall-clock driver for the browser. Clamped so a stalled tab does not try to
  // catch up thousands of ticks at once.
  advance(realDt, maxSteps) {
    const cap = maxSteps || 6;
    this.accumulator += Math.min(realDt, 0.25);
    let n = 0;
    while (this.accumulator >= DT && n < cap) {
      this.step();
      this.accumulator -= DT;
      n++;
    }
    return n;
  }

  // --- player commands -----------------------------------------------------

  orderMove(ids, pos, shape) {
    const w = this.world;
    let slot = 0;
    for (const id of ids) {
      const s = w.get(id);
      if (!s) continue;
      const off = formationOffset(shape || 'delta', slot++, RULES.formationSpacing * 4);
      s.order = { kind: ORDER.MOVE, pos: { x: pos.x, y: pos.y, z: pos.z }, offset: off, slot };
      s.queue.length = 0;
    }
    return slot;
  }

  orderAttack(ids, targetId) {
    const w = this.world;
    const target = w.get(targetId);
    if (!target) return 0;
    let n = 0;
    for (const id of ids) {
      const s = w.get(id);
      if (!s || s.def.dps <= 0) continue;
      s.order = { kind: ORDER.ATTACK, targetId };
      s.queue.length = 0;
      n++;
    }
    return n;
  }

  // `asteroidId` is optional. 0 means "pick the best rock yourself", which is
  // what the harvest AI does when the field it was sent to runs dry.
  orderHarvest(ids, asteroidId) {
    const w = this.world;
    const wanted = asteroidId | 0;
    const rock = wanted ? w.asteroids.find((a) => a.id === wanted && a.resource > 0) : null;
    let n = 0;
    for (const id of ids) {
      const s = w.get(id);
      if (!s || !s.def.capacity) continue;
      s.order = { kind: ORDER.HARVEST, asteroidId: rock ? rock.id : 0 };
      n++;
    }
    return n;
  }

  build(faction, type) {
    const w = this.world;
    const producer = w.livingShips(faction).find((s) => s.def.produces);
    if (!producer) return false;
    return queueBuild(w, producer, type);
  }

  // Compact, order-independent fingerprint used by the determinism tests.
  checksum() {
    const w = this.world;
    let h = 2166136261 >>> 0;
    const mix = (n) => {
      h ^= n >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(w.tick);
    for (const s of w.ships) {
      if (!s.alive) continue;
      mix(s.id);
      mix(s.faction);
      mix(Math.round(s.pos.x * 16));
      mix(Math.round(s.pos.y * 16));
      mix(Math.round(s.pos.z * 16));
      mix(Math.round(s.hp * 8));
    }
    for (const f of w.factions) mix(Math.round(f.resources));
    return h >>> 0;
  }
}

export function runHeadless(seed, factionCount, ticks) {
  const g = new Game(seed, factionCount);
  for (let i = 0; i < ticks && !g.over; i++) g.step();
  return g;
}
