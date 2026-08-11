import { ORDER } from './world.js';
import { damageMultiplier, RULES, ROLE } from './defs.js';
import { steerTo } from './movement.js';
import { v3dist, v3sub, v3scale, v3add, v3norm } from '../core/math.js';

// Returns the best hostile target for `ship` inside its sensor range, or null.
export function acquireTarget(world, ship) {
  const near = world.queryRadius(ship.pos, ship.def.sensor, []);
  let best = null;
  let bestScore = -Infinity;
  for (const o of near) {
    if (!o.alive || o.faction === ship.faction) continue;
    const d = v3dist(ship.pos, o.pos);
    // Prefer things this hull is good against, and prefer close things.
    const mult = damageMultiplier(ship.def.weapon, o.def.armour);
    const threat = o.def.dps / Math.max(1, o.def.hp / 400);
    const score = mult * 100 + threat * 6 - d * 0.05;
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best;
}

export function applyDamage(world, target, amount, attacker) {
  if (!target.alive) return false;
  target.hp -= amount;
  target.lastDamageTick = world.tick;
  if (target.hp > 0) return false;
  target.hp = 0;
  target.alive = false;
  world.factions[target.faction].population -= target.def.cap;
  world.factions[target.faction].lost += 1;
  if (attacker) world.factions[attacker.faction].killed += 1;
  world.events.push({
    tick: world.tick,
    kind: 'kill',
    victim: target.id,
    victimType: target.type,
    faction: target.faction,
    by: attacker ? attacker.id : 0,
    pos: { x: target.pos.x, y: target.pos.y, z: target.pos.z },
  });
  return true;
}

// One combat step for a single ship. `dt` is seconds.
// `fireOnly` keeps weapons live while another system (a move order, harvesting)
// owns the steering for this tick.
export function updateCombat(world, ship, dt, fireOnly) {
  if (ship.def.dps <= 0) return;
  if (ship.cooldown > 0) ship.cooldown = Math.max(0, ship.cooldown - dt);

  let target = ship.targetId ? world.get(ship.targetId) : null;
  if (target && (target.faction === ship.faction || v3dist(ship.pos, target.pos) > ship.def.sensor * 1.35)) {
    target = null;
  }
  if (!target && ship.order.kind === ORDER.ATTACK) {
    target = world.get(ship.order.targetId);
  }
  if (!target) target = acquireTarget(world, ship);

  ship.targetId = target ? target.id : 0;
  if (!target) return;

  const dist = v3dist(ship.pos, target.pos);
  const band = ship.def.range * RULES.engageBand;

  // Close to the engagement band; strike craft keep moving through it.
  if (!fireOnly && (ship.order.kind === ORDER.ATTACK || ship.order.kind === ORDER.IDLE)) {
    if (dist > band) {
      steerTo(ship, target.pos, dt, ship.def.radius * 12);
    } else if (dist < ship.def.range * 0.35 && ship.def.role === ROLE.FIGHTER) {
      const away = v3norm(v3sub(ship.pos, target.pos));
      steerTo(ship, v3add(ship.pos, v3scale(away, ship.def.range)), dt, 0);
    }
  }

  if (dist > ship.def.range || ship.cooldown > 0) return;

  const mult = damageMultiplier(ship.def.weapon, target.def.armour);
  const dmg = ship.def.dps * ship.def.fireInterval * mult;
  ship.cooldown = ship.def.fireInterval;
  const killed = applyDamage(world, target, dmg, ship);
  world.beams.push({
    from: { x: ship.pos.x, y: ship.pos.y, z: ship.pos.z },
    to: { x: target.pos.x, y: target.pos.y, z: target.pos.z },
    weapon: ship.def.weapon,
    faction: ship.faction,
    lethal: killed,
  });
  if (killed && ship.order.kind === ORDER.ATTACK && ship.order.targetId === target.id) {
    ship.order = { kind: ORDER.IDLE };
  }
}
