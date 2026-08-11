import { ORDER } from './world.js';
import { BUILDABLE, RULES } from './defs.js';
import { queueBuild, canAfford } from './economy.js';
import { formationOffset } from './movement.js';
import { v3dist } from '../core/math.js';
import { Rng } from '../core/rng.js';

// A deliberately small opponent: it keeps an economy running, keeps a build
// queue full, and commits a wave once it has enough hulls. It is not a strong
// player and is not claimed to be one.

export const AI_STATE = {
  ECONOMY: 'economy',
  MASS: 'mass',
  ATTACK: 'attack',
};

export class AiPlayer {
  constructor(world, faction, seed) {
    this.world = world;
    this.faction = faction;
    this.rng = new Rng(seed ^ (faction * 0x9e3779b1));
    this.state = AI_STATE.ECONOMY;
    this.think = 0;
    this.thinkInterval = 1.25;
    this.waveSize = 6;
    this.waves = 0;
  }

  ownShips() {
    return this.world.livingShips(this.faction);
  }

  producers() {
    return this.ownShips().filter((s) => s.def.produces);
  }

  countCollectors() {
    return this.ownShips().filter((s) => s.def.capacity).length;
  }

  combatShips() {
    return this.ownShips().filter((s) => s.def.dps > 0 && !s.def.produces);
  }

  chooseType() {
    const f = this.world.factions[this.faction];
    if (this.countCollectors() < 4) return 'collector';
    const affordable = BUILDABLE.filter(
      (t) => t !== 'collector' && canAfford(this.world, this.faction, t),
    );
    if (affordable.length === 0) return null;
    // Bias toward the most expensive hull the AI can pay for, but keep variety.
    if (f.resources > 900 && this.rng.next() < 0.55) {
      return affordable[affordable.length - 1];
    }
    return this.rng.pick(affordable);
  }

  enemyTarget() {
    let best = null;
    let bestScore = -Infinity;
    for (const s of this.world.ships) {
      if (!s.alive || s.faction === this.faction) continue;
      const score = (s.def.produces ? 1000 : 0) + s.def.cost * 0.1;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  update(dt) {
    this.think -= dt;
    if (this.think > 0) return;
    this.think = this.thinkInterval;

    const f = this.world.factions[this.faction];
    if (!f.alive) return;

    for (const p of this.producers()) {
      if (p.buildQueue.length >= 2) continue;
      const type = this.chooseType();
      if (type) queueBuild(this.world, p, type);
    }

    const army = this.combatShips();
    if (this.state !== AI_STATE.ATTACK && army.length >= this.waveSize) {
      this.state = AI_STATE.ATTACK;
    }
    if (this.state === AI_STATE.ATTACK && army.length < Math.max(2, this.waveSize * 0.35)) {
      this.state = AI_STATE.MASS;
      this.waveSize = Math.min(30, this.waveSize + 3);
      this.waves += 1;
    }

    if (this.state === AI_STATE.ATTACK) {
      const target = this.enemyTarget();
      if (!target) return;
      let slot = 0;
      for (const s of army) {
        if (s.order.kind === ORDER.ATTACK && this.world.get(s.order.targetId)) continue;
        const off = formationOffset('claw', slot++, RULES.formationSpacing * 2.4);
        s.order = { kind: ORDER.ATTACK, targetId: target.id, offset: off };
      }
    } else {
      // Hold near the production ship so the AI does not trickle units away.
      const home = this.producers()[0];
      if (!home) return;
      let slot = 0;
      for (const s of army) {
        if (s.order.kind !== ORDER.IDLE) continue;
        const off = formationOffset('sphere', slot++, RULES.formationSpacing * 6);
        const pos = {
          x: home.pos.x + off.x,
          y: home.pos.y + off.y,
          z: home.pos.z + off.z,
        };
        if (v3dist(s.pos, pos) > 400) s.order = { kind: ORDER.MOVE, pos };
      }
    }
  }
}

export function idleCollectorsToWork(world, faction) {
  let n = 0;
  for (const s of world.livingShips(faction)) {
    if (s.def.capacity && s.order.kind === ORDER.IDLE) {
      s.order = { kind: ORDER.HARVEST, asteroidId: 0 };
      n++;
    }
  }
  return n;
}
