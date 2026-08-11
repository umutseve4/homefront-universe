import { hashU32 } from '../core/rng.js';
import { shipDef, RULES } from './defs.js';
import { v3, v3dist2 } from '../core/math.js';

// Entity ids and presentation seeds derive from a salted per-world counter, so
// two worlds built from the same seed produce identical ids regardless of how
// many other worlds exist in the process.

export const ORDER = {
  IDLE: 'idle',
  MOVE: 'move',
  ATTACK: 'attack',
  HARVEST: 'harvest',
};

export class World {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.tick = 0;
    this.time = 0;
    this.nextId = 1;
    this.ships = [];
    this.byId = new Map();
    this.asteroids = [];
    this.factions = [];
    this.beams = []; // transient, rebuilt every tick for presentation
    this.events = [];
    this.cellSize = 900;
    this.grid = new Map();
    this.bounds = 26000;
  }

  allocId() {
    const id = this.nextId++;
    return hashU32(this.seed ^ hashU32(id)) % 0x3fffffff || id;
  }

  addFaction(index, colour, isHuman) {
    const f = {
      index,
      name: colour.name,
      rgb: colour.rgb,
      isHuman,
      resources: RULES.startingResources,
      population: 0,
      alive: true,
      queue: [],
      lost: 0,
      killed: 0,
      harvested: 0,
    };
    this.factions.push(f);
    return f;
  }

  spawnShip(type, faction, pos, fwd) {
    const def = shipDef(type);
    const id = this.allocId();
    const s = {
      id,
      type,
      def,
      faction,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      vel: v3(0, 0, 0),
      fwd: fwd ? { x: fwd.x, y: fwd.y, z: fwd.z } : v3(0, 0, 1),
      hp: def.hp,
      maxHp: def.hp,
      alive: true,
      order: { kind: ORDER.IDLE },
      queue: [],
      targetId: 0,
      cargo: 0,
      cooldown: 0,
      buildTimer: 0,
      buildQueue: [],
      slot: 0,
      seed: hashU32(id ^ 0x5bf03635),
      lastDamageTick: -1,
      shield: 0,
    };
    this.ships.push(s);
    this.byId.set(id, s);
    this.factions[faction].population += def.cap;
    return s;
  }

  addAsteroid(pos, resource, radius) {
    const a = {
      id: this.allocId(),
      pos: { x: pos.x, y: pos.y, z: pos.z },
      resource,
      maxResource: resource,
      radius,
      seed: 0,
    };
    a.seed = hashU32(a.id ^ 0x2545f491);
    this.asteroids.push(a);
    return a;
  }

  get(id) {
    const s = this.byId.get(id);
    return s && s.alive ? s : null;
  }

  // --- spatial index -------------------------------------------------------

  cellKey(x, y, z) {
    const cs = this.cellSize;
    const i = Math.floor(x / cs);
    const j = Math.floor(y / cs);
    const k = Math.floor(z / cs);
    return `${i},${j},${k}`;
  }

  rebuildGrid() {
    this.grid.clear();
    for (const s of this.ships) {
      if (!s.alive) continue;
      const key = this.cellKey(s.pos.x, s.pos.y, s.pos.z);
      let arr = this.grid.get(key);
      if (!arr) {
        arr = [];
        this.grid.set(key, arr);
      }
      arr.push(s);
    }
  }

  // Ships within `radius` of `pos`. Scans the covered cells only.
  queryRadius(pos, radius, out) {
    const res = out || [];
    res.length = 0;
    const cs = this.cellSize;
    const r2 = radius * radius;
    const i0 = Math.floor((pos.x - radius) / cs);
    const i1 = Math.floor((pos.x + radius) / cs);
    const j0 = Math.floor((pos.y - radius) / cs);
    const j1 = Math.floor((pos.y + radius) / cs);
    const k0 = Math.floor((pos.z - radius) / cs);
    const k1 = Math.floor((pos.z + radius) / cs);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (let k = k0; k <= k1; k++) {
          const arr = this.grid.get(`${i},${j},${k}`);
          if (!arr) continue;
          for (const s of arr) {
            if (v3dist2(s.pos, pos) <= r2) res.push(s);
          }
        }
      }
    }
    return res;
  }

  livingShips(faction) {
    const out = [];
    for (const s of this.ships) {
      if (s.alive && (faction === undefined || s.faction === faction)) out.push(s);
    }
    return out;
  }

  // Called once per tick; keeps the ship array from growing without bound.
  compact() {
    if (this.ships.length < 512) return;
    let dead = 0;
    for (const s of this.ships) if (!s.alive) dead++;
    if (dead < this.ships.length / 3) return;
    const kept = [];
    for (const s of this.ships) {
      if (s.alive) kept.push(s);
      else this.byId.delete(s.id);
    }
    this.ships = kept;
  }
}
