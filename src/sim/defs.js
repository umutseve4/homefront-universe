// Single source of truth for balance. Nothing else in the codebase may hard
// code a hitpoint, damage or cost number.

export const ARMOUR = {
  LIGHT: 'light',
  MEDIUM: 'medium',
  HEAVY: 'heavy',
};

export const WEAPON = {
  KINETIC: 'kinetic',
  FLAK: 'flak',
  ION: 'ion',
  TORPEDO: 'torpedo',
};

// Damage multiplier: DAMAGE_TABLE[weapon][armour].
export const DAMAGE_TABLE = {
  kinetic: { light: 1.0, medium: 0.7, heavy: 0.35 },
  flak: { light: 1.8, medium: 0.5, heavy: 0.15 },
  ion: { light: 0.25, medium: 0.9, heavy: 1.8 },
  torpedo: { light: 0.2, medium: 1.1, heavy: 1.6 },
};

export const ROLE = {
  FIGHTER: 'fighter',
  CORVETTE: 'corvette',
  FRIGATE: 'frigate',
  CAPITAL: 'capital',
  SUPPORT: 'support',
};

// hp        - hull points
// armour    - class consumed by DAMAGE_TABLE
// speed     - metres per second
// turn      - radians per second
// range     - weapon range in metres
// dps       - damage per second before the armour multiplier
// cost      - resource units
// build     - seconds to produce
// radius    - collision and selection radius in metres
// cap       - population cost
export const SHIPS = {
  scout: {
    name: 'Scout', role: ROLE.FIGHTER, armour: ARMOUR.LIGHT, weapon: WEAPON.KINETIC,
    hp: 60, speed: 320, turn: 2.4, range: 340, dps: 9, cost: 45, build: 4,
    fireInterval: 0.4, radius: 7, cap: 1, sensor: 4200,
  },
  interceptor: {
    name: 'Interceptor', role: ROLE.FIGHTER, armour: ARMOUR.LIGHT, weapon: WEAPON.KINETIC,
    hp: 90, speed: 285, turn: 2.2, range: 380, dps: 26, cost: 65, build: 6,
    fireInterval: 0.35, radius: 8, cap: 1, sensor: 2400,
  },
  bomber: {
    name: 'Bomber', role: ROLE.FIGHTER, armour: ARMOUR.LIGHT, weapon: WEAPON.TORPEDO,
    hp: 120, speed: 210, turn: 1.5, range: 520, dps: 34, cost: 95, build: 9,
    fireInterval: 1.6, radius: 9, cap: 1, sensor: 2400,
  },
  corvette: {
    name: 'Corvette', role: ROLE.CORVETTE, armour: ARMOUR.MEDIUM, weapon: WEAPON.KINETIC,
    hp: 320, speed: 170, turn: 1.1, range: 620, dps: 42, cost: 160, build: 14,
    fireInterval: 0.5, radius: 14, cap: 2, sensor: 3000,
  },
  flak_frigate: {
    name: 'Flak Frigate', role: ROLE.FRIGATE, armour: ARMOUR.MEDIUM, weapon: WEAPON.FLAK,
    hp: 640, speed: 115, turn: 0.7, range: 780, dps: 58, cost: 280, build: 22,
    fireInterval: 0.6, radius: 22, cap: 4, sensor: 3400,
  },
  ion_frigate: {
    name: 'Ion Frigate', role: ROLE.FRIGATE, armour: ARMOUR.MEDIUM, weapon: WEAPON.ION,
    hp: 700, speed: 105, turn: 0.6, range: 1150, dps: 72, cost: 340, build: 26,
    fireInterval: 1.1, radius: 24, cap: 4, sensor: 3600,
  },
  destroyer: {
    name: 'Destroyer', role: ROLE.CAPITAL, armour: ARMOUR.HEAVY, weapon: WEAPON.ION,
    hp: 2400, speed: 80, turn: 0.34, range: 1450, dps: 140, cost: 900, build: 60,
    fireInterval: 1.4, radius: 44, cap: 10, sensor: 4600,
  },
  carrier: {
    name: 'Carrier', role: ROLE.CAPITAL, armour: ARMOUR.HEAVY, weapon: WEAPON.FLAK,
    hp: 3200, speed: 70, turn: 0.28, range: 900, dps: 60, cost: 1150, build: 78,
    fireInterval: 0.8, radius: 56, cap: 12, sensor: 5200, produces: true,
  },
  mothership: {
    name: 'Mothership', role: ROLE.CAPITAL, armour: ARMOUR.HEAVY, weapon: WEAPON.ION,
    hp: 9000, speed: 34, turn: 0.15, range: 1300, dps: 105, cost: 0, build: 0,
    fireInterval: 1.5, radius: 110, cap: 0, sensor: 7000, produces: true,
  },
  collector: {
    name: 'Collector', role: ROLE.SUPPORT, armour: ARMOUR.LIGHT, weapon: null,
    hp: 220, speed: 130, turn: 1.0, range: 0, dps: 0, cost: 120, build: 12,
    fireInterval: 0, radius: 13, cap: 1, sensor: 2600, capacity: 120, harvestRate: 26,
  },
};

export const SHIP_TYPES = Object.keys(SHIPS);

// Types a production building may queue, in menu order.
export const BUILDABLE = [
  'collector', 'scout', 'interceptor', 'bomber', 'corvette',
  'flak_frigate', 'ion_frigate', 'destroyer', 'carrier',
];

export const FACTION_COLOURS = [
  { name: 'Kushan', rgb: [0.22, 0.62, 1.0] },
  { name: 'Taiidan', rgb: [1.0, 0.36, 0.24] },
  { name: 'Bentusi', rgb: [0.98, 0.82, 0.25] },
  { name: 'Kadeshi', rgb: [0.36, 0.92, 0.55] },
];

export const RULES = {
  startingResources: 1400,
  populationCap: 120,
  asteroidResource: 2600,
  asteroidCount: 42,
  asteroidMin: 1200,
  asteroidMax: 4200,
  // Each faction gets its own small patch so the economy can start without a
  // long haul to the contested central belt.
  homePatchCount: 6,
  homePatchMin: 1600,
  homePatchMax: 3400,
  collectorUnloadRate: 240,
  // Ships hold station this far from their move target when in formation.
  formationSpacing: 46,
  // A unit stops closing once inside this fraction of its weapon range.
  engageBand: 0.85,
  tickRate: 30,
};

export function damageMultiplier(weapon, armour) {
  const row = DAMAGE_TABLE[weapon];
  if (!row) return 0;
  const m = row[armour];
  return m === undefined ? 0 : m;
}

export function shipDef(type) {
  const d = SHIPS[type];
  if (!d) throw new Error(`unknown ship type: ${type}`);
  return d;
}
