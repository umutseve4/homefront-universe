// Renders top-down (x-z plane) SVG snapshots of a headless skirmish.
// Pure Node, zero dependencies — same philosophy as the rest of the repo.
// Usage: node tools/render_map_svg.mjs [seed] [factions] [snapshotTicks...]
// Default: seed=1337 factions=3 snapshots at t=0, 1500, 3000.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from '../src/sim/game.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'docs', 'figures');
mkdirSync(outDir, { recursive: true });

const seed = Number(process.argv[2] ?? 1337) >>> 0;
const factions = Number(process.argv[3] ?? 3) | 0;
const snapshots = process.argv.length > 4
  ? process.argv.slice(4).map((s) => Number(s) | 0)
  : [0, 1500, 3000];

const SIZE = 900; // px, square canvas
const PAD = 40;
const BOUNDS = 26000; // world half-extent on x/z

const rgb = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
const px = (v) => PAD + ((v + BOUNDS) / (2 * BOUNDS)) * (SIZE - 2 * PAD);

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderSnapshot(g, tick) {
  const w = g.world;
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE + 130}" ` +
      `viewBox="0 0 ${SIZE} ${SIZE + 130}" font-family="ui-monospace,Consolas,monospace">`,
  );
  parts.push(`<rect width="${SIZE}" height="${SIZE + 130}" fill="#0b0e14"/>`);
  parts.push(`<rect x="${PAD}" y="${PAD}" width="${SIZE - 2 * PAD}" height="${SIZE - 2 * PAD}" fill="#101522" stroke="#2a3350"/>`);
  parts.push(
    `<text x="${PAD}" y="${PAD - 14}" fill="#e6e9f0" font-size="20">homefront-universe — headless skirmish, ` +
      `seed=${seed}, factions=${factions}, tick=${tick}</text>`,
  );

  // Asteroids: grey circles, opacity tracks remaining resource.
  for (const a of w.asteroids) {
    const frac = a.maxResource > 0 ? a.resource / a.maxResource : 0;
    const r = Math.max(2, (a.radius / (2 * BOUNDS)) * (SIZE - 2 * PAD));
    parts.push(
      `<circle cx="${px(a.pos.x).toFixed(1)}" cy="${px(a.pos.z).toFixed(1)}" r="${r.toFixed(1)}" ` +
        `fill="#8a8f98" fill-opacity="${(0.15 + 0.55 * frac).toFixed(2)}" stroke="#565b64" stroke-width="0.5"/>`,
    );
  }

  // Ships: faction-coloured. Production ships (motherships) get a large ring.
  for (const s of w.ships) {
    if (!s.alive) continue;
    const f = w.factions[s.faction];
    const c = rgb(f.rgb);
    const x = px(s.pos.x).toFixed(1);
    const y = px(s.pos.z).toFixed(1);
    if (s.def.produces) {
      parts.push(`<circle cx="${x}" cy="${y}" r="10" fill="${c}" stroke="#ffffff" stroke-width="1.5"/>`);
      parts.push(`<circle cx="${x}" cy="${y}" r="16" fill="none" stroke="${c}" stroke-width="1" stroke-opacity="0.6"/>`);
    } else if (s.def.capacity) {
      parts.push(`<rect x="${(px(s.pos.x) - 3).toFixed(1)}" y="${(px(s.pos.z) - 3).toFixed(1)}" width="6" height="6" fill="${c}"/>`);
    } else {
      parts.push(`<circle cx="${x}" cy="${y}" r="2.6" fill="${c}"/>`);
    }
  }

  // Legend + faction stats below the map.
  let ly = SIZE + 8;
  parts.push(`<text x="${PAD}" y="${ly}" fill="#9aa3b5" font-size="14">legend: ● combat ship   ■ collector   ◎ production ship   ○ asteroid (opacity = remaining resource)</text>`);
  ly += 26;
  for (const f of w.factions) {
    const ships = w.livingShips(f.index).length;
    parts.push(`<circle cx="${PAD + 6}" cy="${ly - 5}" r="6" fill="${rgb(f.rgb)}"/>`);
    parts.push(
      `<text x="${PAD + 20}" y="${ly}" fill="#e6e9f0" font-size="14">${esc(f.name)} — ` +
        `${f.alive ? 'alive' : 'dead'}, ships=${ships}, resources=${Math.round(f.resources)}, ` +
        `harvested=${Math.round(f.harvested)}, killed=${f.killed}, lost=${f.lost}</text>`,
    );
    ly += 22;
  }

  parts.push(`<text x="${SIZE - PAD}" y="${SIZE + 116}" fill="#5b647a" font-size="12" text-anchor="end">checksum(t=${tick}) = ${g.checksum()}</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

const g = new Game(seed, factions);
const targets = [...snapshots].sort((a, b) => a - b);
let tick = 0;
for (const t of targets) {
  while (tick < t && !g.over) {
    g.step();
    tick++;
  }
  const svg = renderSnapshot(g, tick);
  const file = join(outDir, `skirmish_t${t}.svg`);
  writeFileSync(file, svg);
  console.log(`wrote ${file} (tick=${tick}, checksum=${g.checksum()})`);
}
console.log('===== OTOMATIK KONTROL =====');
console.log(`final checksum=${g.checksum()} over=${g.over}`);
