// Heads-up display drawn on a 2D canvas layered over the WebGL2 view.
//
// Layout is computed by pure functions so it can be unit tested without a
// canvas; `drawHud` then walks that layout and issues 2D context calls. The
// context is duck-typed, which lets the tests pass a recording fake.

import { BUILDABLE, FACTION_COLOURS, RULES, shipDef } from '../sim/defs.js';
import { canAfford } from '../sim/economy.js';
import { clamp } from '../core/math.js';

export const HUD_FONT = '13px ui-monospace, SFMono-Regular, Menlo, monospace';
export const HUD_FONT_SMALL = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
export const PANEL_BG = 'rgba(6, 12, 22, 0.82)';
export const PANEL_EDGE = 'rgba(120, 180, 255, 0.35)';
export const TEXT_MAIN = 'rgba(226, 238, 255, 0.95)';
export const TEXT_DIM = 'rgba(150, 176, 208, 0.85)';

export function rgbaString(rgb, alpha) {
  const r = Math.round(clamp(rgb[0], 0, 1) * 255);
  const g = Math.round(clamp(rgb[1], 0, 1) * 255);
  const b = Math.round(clamp(rgb[2], 0, 1) * 255);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function formatNumber(n) {
  const v = Math.round(n);
  if (Math.abs(v) < 1000) return String(v);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

// --- layout -----------------------------------------------------------------

// Build-menu buttons laid out as a bottom-left grid.
export function buildMenuLayout(width, height, opts) {
  const o = opts || {};
  const cell = o.cell || 92;
  const gap = o.gap || 6;
  const margin = o.margin || 14;
  // Never let the panel exceed half the viewport width on narrow screens.
  const budget = Math.max(1, Math.floor((width * 0.5 - margin * 2 + gap) / (cell + gap)));
  const cols = Math.max(1, Math.min(o.cols || 3, budget));
  const rows = Math.ceil(BUILDABLE.length / cols);
  const panelW = cols * cell + (cols - 1) * gap + margin * 2;
  const panelH = rows * 34 + (rows - 1) * gap + margin * 2 + 18;
  const x = margin;
  const y = height - panelH - margin;
  const items = BUILDABLE.map((type, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    return {
      type,
      index: i,
      hotkey: String(i + 1),
      x: x + margin + c * (cell + gap),
      y: y + margin + 18 + r * (34 + gap),
      w: cell,
      h: 34,
    };
  });
  return { x, y, w: panelW, h: panelH, cols, rows, items };
}

export function hitBuildMenu(layout, px, py) {
  for (const it of layout.items) {
    if (px >= it.x && px <= it.x + it.w && py >= it.y && py <= it.y + it.h) return it;
  }
  return null;
}

// Whether a pixel lands on any HUD panel; main.js uses this to stop clicks
// falling through to the 3D view.
export function hudConsumes(layout, px, py) {
  const r = layout.build;
  if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return true;
  const t = layout.top;
  if (px >= t.x && px <= t.x + t.w && py >= t.y && py <= t.y + t.h) return true;
  const s = layout.selection;
  if (s && px >= s.x && px <= s.x + s.w && py >= s.y && py <= s.y + s.h) return true;
  return false;
}

export function hudLayout(width, height, selectionCount) {
  const build = buildMenuLayout(width, height);
  const top = { x: 0, y: 0, w: width, h: 30 };
  let selection = null;
  if (selectionCount > 0) {
    const w = 260;
    selection = { x: width - w - 14, y: height - 132, w, h: 118 };
  }
  return { width, height, build, top, selection };
}

// Aggregate the selection into "8x Interceptor" style rows.
export function summariseSelection(world, ids) {
  const counts = new Map();
  let hp = 0, maxHp = 0, cargo = 0, capacity = 0;
  let alive = 0;
  for (const id of ids) {
    const s = world.get(id);
    if (!s || !s.alive) continue;
    alive++;
    counts.set(s.type, (counts.get(s.type) || 0) + 1);
    hp += s.hp;
    maxHp += s.maxHp;
    if (s.def.capacity) { cargo += s.cargo; capacity += s.def.capacity; }
  }
  const rows = Array.from(counts.entries())
    .map(([type, count]) => ({ type, count, name: shipDef(type).name }))
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
  return {
    count: alive,
    rows,
    hp,
    maxHp,
    hullFraction: maxHp > 0 ? hp / maxHp : 0,
    cargo,
    capacity,
  };
}

// Per-faction status used by the top bar.
export function factionSummary(world, index) {
  const f = world.factions[index];
  if (!f) return null;
  let ships = 0;
  for (const s of world.ships) if (s.alive && s.faction === index) ships++;
  return {
    index,
    name: f.name,
    rgb: f.rgb || (FACTION_COLOURS[index] && FACTION_COLOURS[index].rgb) || [1, 1, 1],
    resources: f.resources,
    population: f.population,
    populationCap: RULES.populationCap,
    ships,
    harvested: f.harvested,
    killed: f.killed,
    lost: f.lost,
    alive: f.alive,
  };
}

// Production queue of the faction's first living producer. The simulation keeps
// the queue on the producing ship, not on the faction record.
export function productionQueue(world, faction) {
  for (const s of world.ships) {
    if (s.alive && s.faction === faction && s.def.produces) return s.buildQueue;
  }
  return [];
}

// --- drawing ----------------------------------------------------------------

function panel(ctx, x, y, w, h) {
  ctx.fillStyle = PANEL_BG;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PANEL_EDGE;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function bar(ctx, x, y, w, h, frac, colour) {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = colour;
  ctx.fillRect(x, y, w * clamp(frac, 0, 1), h);
}

export function drawHud(ctx, state) {
  const { width, height, world, faction, selected, fps, speed, paused, hover, message } = state;
  const layout = hudLayout(width, height, selected.length);

  ctx.clearRect(0, 0, width, height);
  ctx.textBaseline = 'middle';

  // Top bar: one block per faction, the local player first.
  panel(ctx, layout.top.x, layout.top.y, layout.top.w, layout.top.h);
  ctx.font = HUD_FONT;
  let tx = 14;
  for (let i = 0; i < world.factions.length; i++) {
    const f = factionSummary(world, i);
    if (!f) continue;
    ctx.fillStyle = rgbaString(f.rgb, f.alive ? 0.95 : 0.35);
    ctx.fillRect(tx, 11, 9, 9);
    tx += 15;
    const label = i === faction
      ? `${f.name}  ${formatNumber(f.resources)} RU  ${f.population}/${f.populationCap}`
      : `${f.name}  ${f.ships}`;
    ctx.fillStyle = f.alive ? TEXT_MAIN : TEXT_DIM;
    ctx.fillText(label, tx, 16);
    tx += ctx.measureText(label).width + 22;
  }

  const right = `${formatClock(world.time)}  x${speed}${paused ? '  PAUSED' : ''}  ${Math.round(fps)} fps`;
  ctx.fillStyle = TEXT_DIM;
  ctx.textAlign = 'right';
  ctx.fillText(right, width - 14, 16);
  ctx.textAlign = 'left';

  // Build menu.
  const b = layout.build;
  panel(ctx, b.x, b.y, b.w, b.h);
  ctx.font = HUD_FONT_SMALL;
  ctx.fillStyle = TEXT_DIM;
  ctx.fillText('BUILD  (1-9)', b.x + 14, b.y + 18);
  for (const it of b.items) {
    const def = shipDef(it.type);
    const ok = canAfford(world, faction, it.type);
    const hot = hover && hover.type === it.type;
    ctx.fillStyle = hot ? 'rgba(90, 150, 220, 0.35)' : 'rgba(255, 255, 255, 0.06)';
    ctx.fillRect(it.x, it.y, it.w, it.h);
    ctx.strokeStyle = ok ? PANEL_EDGE : 'rgba(120, 130, 150, 0.2)';
    ctx.strokeRect(it.x + 0.5, it.y + 0.5, it.w - 1, it.h - 1);
    ctx.fillStyle = ok ? TEXT_MAIN : 'rgba(150, 160, 180, 0.45)';
    ctx.font = HUD_FONT_SMALL;
    ctx.fillText(`${it.hotkey} ${def.name}`, it.x + 6, it.y + 13);
    ctx.fillStyle = TEXT_DIM;
    ctx.fillText(`${def.cost} RU`, it.x + 6, it.y + 26);
  }

  // Production queue of the local faction's producer.
  const queue = productionQueue(world, faction);
  if (queue.length > 0) {
    ctx.fillStyle = TEXT_DIM;
    ctx.font = HUD_FONT_SMALL;
    const names = queue.slice(0, 6).map((q) => shipDef(q.type).name).join('  ');
    ctx.fillText(`QUEUE  ${names}`, b.x + 14, b.y - 26);
  }

  // Selection panel.
  if (layout.selection) {
    const s = layout.selection;
    const sum = summariseSelection(world, selected);
    panel(ctx, s.x, s.y, s.w, s.h);
    ctx.font = HUD_FONT;
    ctx.fillStyle = TEXT_MAIN;
    ctx.fillText(`SELECTED  ${sum.count}`, s.x + 12, s.y + 18);
    ctx.font = HUD_FONT_SMALL;
    let ry = s.y + 40;
    for (const row of sum.rows.slice(0, 4)) {
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText(`${row.count}x ${row.name}`, s.x + 12, ry);
      ry += 16;
    }
    bar(ctx, s.x + 12, s.y + s.h - 26, s.w - 24, 6, sum.hullFraction, 'rgba(96, 214, 140, 0.9)');
    if (sum.capacity > 0) {
      bar(ctx, s.x + 12, s.y + s.h - 15, s.w - 24, 6, sum.cargo / sum.capacity, 'rgba(240, 200, 90, 0.9)');
    }
  }

  if (message) {
    ctx.font = HUD_FONT;
    ctx.fillStyle = 'rgba(255, 210, 120, 0.95)';
    ctx.textAlign = 'center';
    ctx.fillText(message, width / 2, height * 0.18);
    ctx.textAlign = 'left';
  }

  return layout;
}

// Minimap: world XZ projected into a square. Pure maths, drawn separately.
export function minimapTransform(x, y, size, bounds) {
  const s = size / (bounds * 2);
  return {
    toScreen(p) {
      return { x: x + (p.x + bounds) * s, y: y + (p.z + bounds) * s };
    },
    toWorld(px, py) {
      return { x: (px - x) / s - bounds, y: 0, z: (py - y) / s - bounds };
    },
  };
}

export function drawMinimap(ctx, state) {
  const { world, faction, x, y, size } = state;
  const t = minimapTransform(x, y, size, world.bounds);
  panel(ctx, x, y, size, size);
  for (const a of world.asteroids) {
    if (a.resource <= 0) continue;
    const p = t.toScreen(a.pos);
    ctx.fillStyle = 'rgba(150, 140, 120, 0.6)';
    ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
  }
  for (const s of world.ships) {
    if (!s.alive) continue;
    const p = t.toScreen(s.pos);
    const col = (world.factions[s.faction] && world.factions[s.faction].rgb) || [1, 1, 1];
    ctx.fillStyle = rgbaString(col, s.faction === faction ? 1 : 0.8);
    const r = s.def.radius > 30 ? 2 : 1;
    ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
  }
  return t;
}
