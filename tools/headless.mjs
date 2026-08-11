// Headless driver: runs a full skirmish with no browser and prints a summary.
// Usage: node tools/headless.mjs [seed] [factions] [ticks]
import { Game } from '../src/sim/game.js';

const seed = Number(process.argv[2] ?? 1337) >>> 0;
const factions = Number(process.argv[3] ?? 3) | 0;
const ticks = Number(process.argv[4] ?? 9000) | 0;

const t0 = Date.now();
const g = new Game(seed, factions);
const start = g.world.livingShips().length;

let i = 0;
for (; i < ticks && !g.over; i++) g.step();

const ms = Date.now() - t0;
const rows = g.world.factions.map((f) => ({
  faction: f.name,
  alive: f.alive,
  resources: Math.round(f.resources),
  harvested: Math.round(f.harvested),
  population: f.population,
  ships: g.world.livingShips(f.index).length,
  killed: f.killed,
  lost: f.lost,
}));

console.log(`seed=${seed} factions=${factions} ticks=${i} startShips=${start}`);
console.table(rows);
console.log(
  `over=${g.over} winner=${g.winner} checksum=${g.checksum()} ` +
    `sim=${ms}ms (${(i / (ms / 1000)).toFixed(0)} ticks/s)`,
);
