// HomeFront Universe — browser entry point.
//
// This module owns the DOM and nothing else. Every decision about the world
// belongs to src/sim, every decision about pixels belongs to src/gfx, and every
// decision about intent belongs to src/ui. main.js only wires the three
// together and runs the frame loop.
//
// The separation is deliberate: the whole simulation is testable under Node
// because nothing below this file touches `window`, `document` or a GL context.

import { Game } from './sim/game.js';
import { RULES, BUILDABLE, shipDef } from './sim/defs.js';
import { Camera } from './gfx/camera.js';
import { Renderer } from './gfx/renderer.js';
import { resizeCanvas } from './gfx/gl.js';
import { InputState, buildKeyToType } from './ui/input.js';
import { drawHud, drawMinimap, hudLayout, hitBuildMenu, hudConsumes } from './ui/hud.js';

const HUMAN_FACTION = 0;

// --- boot helpers -----------------------------------------------------------

// Reads `?seed=123&factions=3` so a specific match can be linked to and
// reproduced. Falls back to a random seed and three factions.
export function readOptions(search) {
  const params = new URLSearchParams(search || '');
  const rawSeed = params.get('seed');
  const rawFactions = params.get('factions');
  const seed = rawSeed !== null && /^\d+$/.test(rawSeed)
    ? (Number(rawSeed) >>> 0)
    : ((Math.random() * 0xffffffff) >>> 0);
  let factions = rawFactions !== null && /^\d+$/.test(rawFactions) ? Number(rawFactions) : 3;
  factions = Math.max(2, Math.min(4, factions));
  return { seed, factions };
}

// Exponentially smoothed frame rate. A raw 1/dt reading is unreadable.
export function makeFpsMeter(smoothing) {
  const k = smoothing === undefined ? 0.1 : smoothing;
  let value = 60;
  return {
    sample(dt) {
      if (dt > 0) value += (1 / dt - value) * k;
      return value;
    },
    get value() { return value; },
  };
}

// Converts a DOM pointer event into the plain record InputState expects.
// Keeping this pure means the input tests never need a fake DOM event.
export function pointerRecord(ev, rect, prev) {
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  return {
    x,
    y,
    dx: prev ? x - prev.x : 0,
    dy: prev ? y - prev.y : 0,
    button: ev.button,
    shift: !!ev.shiftKey,
  };
}

// The order descriptors InputState returns are intentionally inert. This is the
// single place where intent becomes a mutation of the simulation.
export function applyOrder(order, game, camera, input) {
  if (!order) return null;
  switch (order.kind) {
    case 'select':
      return 'select';
    case 'move':
      game.orderMove(order.ids, order.point, 'delta');
      return 'move';
    case 'attack':
      game.orderAttack(order.ids, order.targetId);
      return 'attack';
    case 'harvest': {
      const n = game.orderHarvest(order.ids, order.asteroidId || 0);
      return n > 0 ? 'harvest' : null;
    }
    case 'build': {
      const ok = game.build(HUMAN_FACTION, order.type);
      return ok ? `build ${order.type}` : `cannot afford ${order.type}`;
    }
    case 'focus': {
      const pts = order.ids.map((id) => game.world.get(id)).filter(Boolean).map((s) => s.pos);
      if (pts.length > 0 && camera) camera.frame(pts, 2.0);
      return 'focus';
    }
    case 'pause':
      return order.paused ? 'paused' : 'resumed';
    case 'speed':
      return `speed x${order.speed}`;
    default:
      return null;
  }
}

// --- main -------------------------------------------------------------------

export function start(root) {
  const doc = root || document;
  const glCanvas = doc.getElementById('scene');
  const hudCanvas = doc.getElementById('hud');
  const gl = glCanvas.getContext('webgl2', {
    antialias: true,
    depth: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    const msg = doc.getElementById('boot');
    if (msg) msg.textContent = 'WebGL2 is required and is not available in this browser.';
    throw new Error('WebGL2 unavailable');
  }

  const opts = readOptions(typeof location === 'undefined' ? '' : location.search);
  const game = new Game(opts.seed, opts.factions);
  const camera = new Camera();
  const renderer = new Renderer(gl, glCanvas);
  const input = new InputState({ width: 1, height: 1, faction: HUMAN_FACTION });
  const hud = hudCanvas.getContext('2d');
  const fps = makeFpsMeter(0.1);

  let message = `seed ${opts.seed}`;
  let messageUntil = 3;
  let prevPointer = null;

  // Open on the player's own fleet rather than the world origin.
  const own = game.world.livingShips(HUMAN_FACTION).map((s) => s.pos);
  if (own.length > 0) camera.frame(own, 2.2);
  camera.snap();

  function say(text) {
    if (!text) return;
    message = text;
    messageUntil = game.world.time + 2.5;
  }

  function layout() {
    const w = glCanvas.clientWidth;
    const h = glCanvas.clientHeight;
    hudCanvas.width = w;
    hudCanvas.height = h;
    input.resize(w, h);
    camera.setAspect(w / Math.max(1, h));
    resizeCanvas(gl, glCanvas, 2);
    return { w, h };
  }

  let size = layout();
  if (typeof addEventListener === 'function') {
    addEventListener('resize', () => { size = layout(); });
  }

  // --- pointer --------------------------------------------------------------

  hudCanvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  hudCanvas.addEventListener('pointerdown', (ev) => {
    const rect = hudCanvas.getBoundingClientRect();
    const p = pointerRecord(ev, rect, null);
    prevPointer = p;
    hudCanvas.setPointerCapture(ev.pointerId);

    if (ev.button === 0) {
      const l = hudLayout(size.w, size.h, input.selected.length);
      const item = hitBuildMenu(l.build, p.x, p.y);
      if (item) { say(applyOrder({ kind: 'build', type: item.type }, game, camera, input)); return; }
      if (hudConsumes(l, p.x, p.y)) return;
    }
    if (ev.button === 2) {
      const order = input.contextOrder(p, game.world, camera);
      say(applyOrder(order, game, camera, input));
    }
    input.pointerDown(p);
  });

  hudCanvas.addEventListener('pointermove', (ev) => {
    const rect = hudCanvas.getBoundingClientRect();
    const p = pointerRecord(ev, rect, prevPointer);
    prevPointer = p;
    input.pointerMove(p, camera);
  });

  hudCanvas.addEventListener('pointerup', (ev) => {
    const rect = hudCanvas.getBoundingClientRect();
    const p = pointerRecord(ev, rect, prevPointer);
    prevPointer = p;
    const order = input.pointerUp(p, game.world, camera, performance.now());
    if (order && order.reason === 'type') say(`selected all ${order.ids.length}`);
    if (hudCanvas.hasPointerCapture(ev.pointerId)) hudCanvas.releasePointerCapture(ev.pointerId);
  });

  hudCanvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    input.wheel({ dy: ev.deltaY }, camera);
  }, { passive: false });

  // --- keyboard -------------------------------------------------------------

  addEventListener('keydown', (ev) => {
    if (ev.repeat) return;
    const order = input.keyDown(ev.code);
    if (order || buildKeyToType(ev.code)) ev.preventDefault();
    say(applyOrder(order, game, camera, input));
  });

  addEventListener('keyup', (ev) => { input.keyUp(ev.code); });

  // --- frame loop -----------------------------------------------------------

  let last = performance.now();

  function frame(now) {
    const realDt = Math.min(0.25, (now - last) / 1000);
    last = now;
    fps.sample(realDt);

    const simDt = input.paused ? 0 : realDt * input.speed;
    if (simDt > 0) game.advance(simDt, 12);

    input.applyCameraKeys(camera, realDt);
    input.tick(realDt);
    input.pruneSelection(game.world);
    camera.update(realDt);

    const view = input.overlay();
    renderer.render(game.world, camera, view);

    if (game.world.time > messageUntil) message = '';

    drawHud(hud, {
      width: size.w,
      height: size.h,
      world: game.world,
      faction: HUMAN_FACTION,
      selected: input.selected,
      fps: fps.value,
      speed: input.speed,
      paused: input.paused,
      hover: null,
      message: game.over ? `${winnerName(game)} wins` : message,
    });

    const mm = Math.min(200, Math.floor(Math.min(size.w, size.h) * 0.24));
    drawMinimap(hud, {
      world: game.world,
      faction: HUMAN_FACTION,
      x: size.w - mm - 14,
      y: 44,
      size: mm,
    });

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  // Exposed for manual inspection from the browser console. Not used by the
  // game itself; nothing in src/ reads this.
  return { game, camera, renderer, input, options: opts };
}

export function winnerName(game) {
  if (!game.over || game.winner < 0) return 'nobody';
  const f = game.world.factions[game.winner];
  return f ? f.name : 'nobody';
}

// Auto-start only in a real browser. Under Node this module can be imported for
// its pure helpers without touching the DOM.
if (typeof document !== 'undefined' && typeof requestAnimationFrame === 'function') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { start(document); });
  } else {
    start(document);
  }
}

// Referenced so the bundler keeps the defs module even if tree-shaking is added
// later; also the console-friendly build list.
export const BUILD_ORDER = BUILDABLE.map((t) => ({ type: t, cost: shipDef(t).cost }));
export const TICK_RATE = RULES.tickRate;
