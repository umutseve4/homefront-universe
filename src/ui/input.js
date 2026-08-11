// Pointer and keyboard handling for the tactical view.
//
// This module deliberately contains no DOM code. It is a state machine that
// consumes already-normalised events ({ x, y, button, ... } in CSS pixels) and
// emits orders. `src/main.js` owns the listeners and feeds them in. Keeping the
// logic DOM-free is what makes selection, drag-boxes and order dispatch
// testable under `node --test` with no browser present.

import { pixelToNdc } from '../gfx/camera.js';
import { v3sub, v3len, clamp } from '../core/math.js';
import { BUILDABLE } from '../sim/defs.js';

// A press shorter than this and moving less than DRAG_SLOP counts as a click.
export const DRAG_SLOP = 6;
export const DOUBLE_CLICK_MS = 320;

export const CAMERA_KEYS = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  ArrowUp: 'forward',
  ArrowDown: 'back',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

// Digit1..Digit9 map onto BUILDABLE by index.
export function buildKeyToType(code) {
  const m = /^Digit([1-9])$/.exec(code);
  if (!m) return null;
  const idx = Number(m[1]) - 1;
  return idx < BUILDABLE.length ? BUILDABLE[idx] : null;
}

// Screen-space rectangle from two pixel points, normalised so x0<=x1.
export function normaliseRect(ax, ay, bx, by) {
  return {
    x0: Math.min(ax, bx),
    y0: Math.min(ay, by),
    x1: Math.max(ax, bx),
    y1: Math.max(ay, by),
  };
}

export function rectArea(r) {
  return (r.x1 - r.x0) * (r.y1 - r.y0);
}

// Project a world point to pixel coordinates. Returns null when the point sits
// behind the eye, which the caller must treat as "not selectable".
export function worldToPixel(camera, point, width, height) {
  const vp = camera.viewProj;
  const x = point.x, y = point.y, z = point.z;
  const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
  if (cw <= 1e-6) return null;
  const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
  const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
  return {
    x: (cx / cw * 0.5 + 0.5) * width,
    y: (0.5 - cy / cw * 0.5) * height,
    // Clip-space w equals view-space depth for this projection, so callers get
    // a front-to-back ordering key for free instead of recomputing a distance.
    depth: cw,
  };
}

// Ships of `faction` whose screen position lies inside `rect`.
export function shipsInRect(world, camera, rect, width, height, faction) {
  const out = [];
  for (const s of world.ships) {
    if (!s.alive) continue;
    if (faction !== undefined && faction !== null && s.faction !== faction) continue;
    const p = worldToPixel(camera, s.pos, width, height);
    if (!p) continue;
    if (p.x >= rect.x0 && p.x <= rect.x1 && p.y >= rect.y0 && p.y <= rect.y1) out.push(s.id);
  }
  return out;
}

// Nearest ship under the cursor. Uses a screen-space radius so small craft are
// still clickable at distance, then breaks ties by depth along the ray.
export function pickShip(world, camera, px, py, width, height, opts) {
  const o = opts || {};
  const slop = o.slop === undefined ? 14 : o.slop;
  let best = null;
  let bestScore = Infinity;
  for (const s of world.ships) {
    if (!s.alive) continue;
    if (o.faction !== undefined && o.faction !== null && s.faction !== o.faction) continue;
    const p = worldToPixel(camera, s.pos, width, height);
    if (!p) continue;
    const dx = p.x - px, dy = p.y - py;
    const d = Math.hypot(dx, dy);
    const r = Math.max(slop, ndcPixelRadius(camera, s, height));
    if (d > r) continue;
    const score = d * 4 + p.depth * 0.001;
    if (score < bestScore) { bestScore = score; best = s; }
  }
  return best;
}

// Screen-space radius of a ship in pixels. Only the vertical FOV matters
// because the projection preserves aspect on the y axis.
function ndcPixelRadius(camera, ship, height) {
  const dist = Math.max(1, v3len(v3sub(ship.pos, camera.eye)));
  const radius = (ship.def && ship.def.radius) || 8;
  // Vertical FOV is baked into the projection: proj[5] == 1/tan(fovY/2).
  const focal = camera.proj[5];
  return (radius / dist) * focal * height * 0.5;
}

// Nearest asteroid under the cursor, used for explicit harvest orders.
export function pickAsteroid(world, camera, px, py, width, height) {
  let best = null;
  let bestD = Infinity;
  for (const a of world.asteroids) {
    if (a.resource <= 0) continue;
    const p = worldToPixel(camera, a.pos, width, height);
    if (!p) continue;
    const d = Math.hypot(p.x - px, p.y - py);
    const dist = Math.max(1, v3len(v3sub(a.pos, camera.eye)));
    const r = Math.max(18, (a.radius / dist) * camera.proj[5] * height * 0.5);
    if (d <= r && d < bestD) { bestD = d; best = a; }
  }
  return best;
}

// The input state machine.
export class InputState {
  constructor(opts) {
    const o = opts || {};
    this.width = o.width || 1280;
    this.height = o.height || 720;
    this.faction = o.faction === undefined ? 0 : o.faction;
    this.selected = [];
    this.keys = new Set();
    this.dragging = false;
    this.dragStart = null;
    this.dragCurrent = null;
    this.orbiting = false;
    this.panning = false;
    this.lastClickMs = -1e9;
    this.lastClickId = -1;
    this.marker = null;
    this.markerAge = 0;
    this.buildRequest = null;
    this.paused = false;
    this.speed = 1;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
  }

  // --- selection ----------------------------------------------------------

  clearSelection() {
    this.selected = [];
  }

  setSelection(ids) {
    this.selected = Array.from(new Set(ids));
  }

  addToSelection(ids) {
    const set = new Set(this.selected);
    for (const id of ids) set.add(id);
    this.selected = Array.from(set);
  }

  toggleSelection(id) {
    const i = this.selected.indexOf(id);
    if (i >= 0) this.selected.splice(i, 1);
    else this.selected.push(id);
  }

  // Drop ids that are dead or gone. Called once per frame by main.js.
  pruneSelection(world) {
    if (this.selected.length === 0) return;
    this.selected = this.selected.filter((id) => {
      const s = world.get(id);
      return !!s && s.alive && s.faction === this.faction;
    });
  }

  // --- pointer ------------------------------------------------------------

  pointerDown(ev) {
    if (ev.button === 0) {
      this.dragging = true;
      this.dragStart = { x: ev.x, y: ev.y };
      this.dragCurrent = { x: ev.x, y: ev.y };
    } else if (ev.button === 1) {
      this.panning = true;
    } else if (ev.button === 2) {
      this.orbiting = true;
    }
  }

  pointerMove(ev, camera) {
    if (this.dragging) this.dragCurrent = { x: ev.x, y: ev.y };
    if (this.orbiting && camera) camera.orbit(-ev.dx * 0.006, -ev.dy * 0.006);
    if (this.panning && camera) camera.pan(-ev.dx, ev.dy);
  }

  // Returns an order descriptor, or null. The caller applies it to the Game so
  // this class never imports the simulation's mutating API.
  pointerUp(ev, world, camera, nowMs) {
    const wasDragging = this.dragging;
    const start = this.dragStart;
    this.dragging = false;
    this.dragStart = null;
    this.dragCurrent = null;
    if (ev.button === 1) this.panning = false;
    if (ev.button === 2) { this.orbiting = false; return null; }
    if (ev.button !== 0 || !wasDragging || !start) return null;

    const rect = normaliseRect(start.x, start.y, ev.x, ev.y);
    const moved = Math.hypot(ev.x - start.x, ev.y - start.y);

    if (moved > DRAG_SLOP) {
      const ids = shipsInRect(world, camera, rect, this.width, this.height, this.faction);
      if (ev.shift) this.addToSelection(ids);
      else this.setSelection(ids);
      return { kind: 'select', ids: this.selected.slice() };
    }

    const hit = pickShip(world, camera, ev.x, ev.y, this.width, this.height, { faction: this.faction });
    if (hit) {
      const t = nowMs === undefined ? 0 : nowMs;
      const isDouble = hit.id === this.lastClickId && (t - this.lastClickMs) < DOUBLE_CLICK_MS;
      this.lastClickId = hit.id;
      this.lastClickMs = t;
      if (isDouble) {
        const ids = world.ships
          .filter((s) => s.alive && s.faction === this.faction && s.type === hit.type)
          .map((s) => s.id);
        this.setSelection(ids);
        return { kind: 'select', ids: this.selected.slice(), reason: 'type' };
      }
      if (ev.shift) this.toggleSelection(hit.id);
      else this.setSelection([hit.id]);
      return { kind: 'select', ids: this.selected.slice() };
    }

    if (!ev.shift) this.clearSelection();
    return { kind: 'select', ids: this.selected.slice() };
  }

  // Right-click issues the context-sensitive order: attack an enemy, harvest a
  // rock, otherwise move to the ground plane.
  contextOrder(ev, world, camera) {
    if (this.selected.length === 0) return null;
    const ndc = pixelToNdc(ev.x, ev.y, this.width, this.height);

    const enemy = pickShip(world, camera, ev.x, ev.y, this.width, this.height, {});
    if (enemy && enemy.faction !== this.faction) {
      return { kind: 'attack', ids: this.selected.slice(), targetId: enemy.id };
    }

    const rock = pickAsteroid(world, camera, ev.x, ev.y, this.width, this.height);
    if (rock) {
      // A harvester is any hull with cargo capacity; `role` is 'support'.
      const collectors = this.selected.filter((id) => {
        const s = world.get(id);
        return s && s.def && s.def.capacity > 0;
      });
      if (collectors.length > 0) {
        return { kind: 'harvest', ids: collectors, asteroidId: rock.id };
      }
    }

    const ground = camera.pickPlane(ndc.x, ndc.y, 0);
    if (!ground) return null;
    this.marker = ground;
    this.markerAge = 0;
    return { kind: 'move', ids: this.selected.slice(), point: ground };
  }

  wheel(ev, camera) {
    if (!camera) return;
    const factor = Math.exp(clamp(ev.dy, -600, 600) * 0.0011);
    camera.zoom(factor);
  }

  // --- keyboard -----------------------------------------------------------

  keyDown(code) {
    this.keys.add(code);

    if (code === 'Space') { this.paused = !this.paused; return { kind: 'pause', paused: this.paused }; }
    if (code === 'Equal' || code === 'NumpadAdd') {
      this.speed = clamp(this.speed * 2, 0.25, 8);
      return { kind: 'speed', speed: this.speed };
    }
    if (code === 'Minus' || code === 'NumpadSubtract') {
      this.speed = clamp(this.speed / 2, 0.25, 8);
      return { kind: 'speed', speed: this.speed };
    }
    if (code === 'Escape') { this.clearSelection(); return { kind: 'select', ids: [] }; }
    if (code === 'KeyH') return { kind: 'harvest', ids: this.selected.slice() };
    if (code === 'KeyF') return { kind: 'focus', ids: this.selected.slice() };

    const type = buildKeyToType(code);
    if (type) return { kind: 'build', type };
    return null;
  }

  keyUp(code) {
    this.keys.delete(code);
    return null;
  }

  // Continuous camera motion from held keys, applied once per frame.
  applyCameraKeys(camera, dt) {
    if (!camera) return;
    let f = 0, r = 0;
    for (const code of this.keys) {
      const dir = CAMERA_KEYS[code];
      if (dir === 'forward') f += 1;
      else if (dir === 'back') f -= 1;
      else if (dir === 'left') r -= 1;
      else if (dir === 'right') r += 1;
    }
    if (f === 0 && r === 0) return;
    const speed = 900 * dt;
    camera.pan(r * speed, f * speed);
  }

  tick(dt) {
    if (this.marker) {
      this.markerAge += dt;
      if (this.markerAge > 2.4) this.marker = null;
    }
  }

  // What the renderer needs to draw the overlay this frame.
  overlay() {
    const out = { selected: this.selected };
    if (this.marker) { out.marker = this.marker; out.markerAge = this.markerAge; }
    if (this.dragging && this.dragStart && this.dragCurrent) {
      const moved = Math.hypot(this.dragCurrent.x - this.dragStart.x, this.dragCurrent.y - this.dragStart.y);
      if (moved > DRAG_SLOP) {
        out.screenRect = normaliseRect(this.dragStart.x, this.dragStart.y, this.dragCurrent.x, this.dragCurrent.y);
      }
    }
    return out;
  }
}
