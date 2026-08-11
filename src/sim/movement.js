import { ORDER } from './world.js';
import { RULES } from './defs.js';
import { v3add, v3sub, v3scale, v3len, v3norm, v3dot, v3dist, EPS, clamp } from '../core/math.js';

// Formation offsets are deterministic functions of the slot index, so the same
// order issued to the same selection always yields the same shape.
export function formationOffset(shape, slot, spacing) {
  const s = spacing || RULES.formationSpacing;
  switch (shape) {
    case 'wall': {
      const cols = 6;
      const c = slot % cols;
      const r = Math.floor(slot / cols);
      return { x: (c - (cols - 1) / 2) * s, y: r * s * 0.55, z: 0 };
    }
    case 'sphere': {
      // Fibonacci sphere - even coverage without trigonometric clustering.
      const n = slot + 1;
      const ga = Math.PI * (3 - Math.sqrt(5));
      const y = 1 - (2 * n) / 64;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const t = ga * n;
      const rad = s * 1.6 * (1 + Math.floor(slot / 64) * 0.5);
      return { x: Math.cos(t) * r * rad, y: y * rad, z: Math.sin(t) * r * rad };
    }
    case 'claw': {
      const arm = slot % 3;
      const depth = Math.floor(slot / 3);
      const a = (arm / 3) * Math.PI * 2;
      const rad = s * (1 + depth * 0.4);
      return { x: Math.cos(a) * rad, y: depth * s * 0.3, z: Math.sin(a) * rad - depth * s * 0.6 };
    }
    case 'delta':
    default: {
      const row = Math.floor((Math.sqrt(8 * slot + 1) - 1) / 2);
      const idxInRow = slot - (row * (row + 1)) / 2;
      return {
        x: (idxInRow - row / 2) * s,
        y: 0,
        z: -row * s * 0.8,
      };
    }
  }
}

export const FORMATIONS = ['delta', 'wall', 'sphere', 'claw'];

// Steers a ship toward `target`, respecting speed and turn rate.
// Returns the distance remaining.
export function steerTo(ship, target, dt, arriveRadius) {
  const def = ship.def;
  const toT = v3sub(target, ship.pos);
  const dist = v3len(toT);
  if (dist < EPS) {
    ship.vel = v3scale(ship.vel, 0.6);
    return 0;
  }
  const dir = v3scale(toT, 1 / dist);

  // Turn the facing toward the desired direction at the hull's turn rate.
  // This is a geodesic rotation, not a lerp: a lerp is degenerate when the
  // target sits exactly behind the hull (fwd == -dir renormalises to fwd, so
  // the ship can never turn around) and it under-rotates everywhere else
  // because it follows the chord instead of the arc.
  const maxTurn = def.turn * dt;
  const cosA = clamp(v3dot(ship.fwd, dir), -1, 1);
  const angle = Math.acos(cosA);
  if (angle > EPS) {
    const step = Math.min(maxTurn, angle);
    // Component of `dir` orthogonal to `fwd`: the direction we rotate into.
    let perp = v3sub(dir, v3scale(ship.fwd, cosA));
    let pl = v3len(perp);
    if (pl < EPS) {
      // Exactly antipodal. Any orthogonal axis is correct; pick one
      // deterministically so replays stay bit-identical.
      const seed = Math.abs(ship.fwd.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
      perp = v3sub(seed, v3scale(ship.fwd, v3dot(seed, ship.fwd)));
      pl = v3len(perp);
    }
    perp = v3scale(perp, 1 / pl);
    ship.fwd = v3norm(
      v3add(v3scale(ship.fwd, Math.cos(step)), v3scale(perp, Math.sin(step))),
    );
  }

  // Slow down on approach so ships settle instead of orbiting the target.
  // The ramp must reach zero *inside* the arrive radius, otherwise the hull
  // keeps a residual drift, sails past the target and never completes work
  // that depends on staying in range (harvesting, unloading, docking).
  const brake =
    arriveRadius > 0
      ? clamp((dist - arriveRadius * 0.35) / (arriveRadius * 0.65), 0, 1)
      : 1;
  // Thrust is applied along the facing, not the desired direction: a capital
  // ship that has not finished turning genuinely drifts wide.
  const speed = def.speed * brake * clamp(v3dot(ship.fwd, dir), 0.1, 1);
  const desired = v3scale(ship.fwd, speed);
  const accel = def.speed * 1.8;
  const dv = v3sub(desired, ship.vel);
  const dvLen = v3len(dv);
  const maxDv = accel * dt;
  ship.vel = dvLen > maxDv ? v3add(ship.vel, v3scale(dv, maxDv / dvLen)) : desired;
  return dist;
}

export function integrate(ship, dt, bounds) {
  ship.pos = v3add(ship.pos, v3scale(ship.vel, dt));
  const b = bounds;
  ship.pos.x = clamp(ship.pos.x, -b, b);
  ship.pos.y = clamp(ship.pos.y, -b * 0.35, b * 0.35);
  ship.pos.z = clamp(ship.pos.z, -b, b);
}

// Cheap separation so stacks of ships spread out instead of occupying one point.
export function separate(world, ship, dt) {
  const r = ship.def.radius * 3.2;
  const near = world.queryRadius(ship.pos, r, SCRATCH);
  let px = 0;
  let py = 0;
  let pz = 0;
  let n = 0;
  for (const o of near) {
    if (o === ship || !o.alive) continue;
    const dx = ship.pos.x - o.pos.x;
    const dy = ship.pos.y - o.pos.y;
    const dz = ship.pos.z - o.pos.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    const minD = ship.def.radius + o.def.radius;
    if (d2 > minD * minD || d2 < 1e-9) continue;
    const d = Math.sqrt(d2);
    const push = (minD - d) / minD;
    px += (dx / d) * push;
    py += (dy / d) * push;
    pz += (dz / d) * push;
    n++;
  }
  if (n === 0) return;
  const strength = ship.def.speed * 0.9 * dt;
  ship.pos.x += px * strength;
  ship.pos.y += py * strength;
  ship.pos.z += pz * strength;
}

const SCRATCH = [];

export function advanceOrders(ship) {
  if (ship.order.kind === ORDER.IDLE && ship.queue.length > 0) {
    ship.order = ship.queue.shift();
    return true;
  }
  return false;
}

export function updateMovement(world, ship, dt) {
  const o = ship.order;
  if (o.kind === ORDER.MOVE) {
    const target = o.slot !== undefined && o.offset
      ? { x: o.pos.x + o.offset.x, y: o.pos.y + o.offset.y, z: o.pos.z + o.offset.z }
      : o.pos;
    const dist = steerTo(ship, target, dt, ship.def.radius * 14);
    if (dist < ship.def.radius * 1.6) {
      ship.order = { kind: ORDER.IDLE };
    }
  } else if (ship.order.kind === ORDER.IDLE) {
    ship.vel = v3scale(ship.vel, Math.max(0, 1 - dt * 1.4));
  }
}

export function distanceTo(a, b) {
  return v3dist(a.pos, b.pos);
}
