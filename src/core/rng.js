// Deterministic pseudo-randomness.
//
// Two distinct facilities, deliberately kept apart:
//   * Rng      - a seeded stream, for map generation and AI decisions.
//   * hash2/3  - stateless value hashing, for per-entity jitter that must be
//                reproducible without depending on call order.
//
// Simulation code must never call Math.random().

const MASK = 0xffffffff;

export function hashU32(x) {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// Stateless hash of two integers to [0,1).
export function hash2(a, b) {
  const h = hashU32((Math.imul(a >>> 0, 0x9e3779b1) ^ (b >>> 0)) >>> 0);
  return h / 4294967296;
}

// Stateless hash of three integers to [0,1).
export function hash3(a, b, c) {
  const m = (Math.imul(a >>> 0, 0x9e3779b1) ^ Math.imul(b >>> 0, 0x85ebca6b) ^ (c >>> 0)) >>> 0;
  return hashU32(m) / 4294967296;
}

// Signed variant, [-1,1).
export function hash3s(a, b, c) {
  return hash3(a, b, c) * 2 - 1;
}

export class Rng {
  constructor(seed = 1) {
    this.state = (seed >>> 0) || 1;
  }

  // xorshift32 - small, fast, and adequate for content generation.
  nextU32() {
    let x = this.state;
    x ^= (x << 13) & MASK;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) & MASK;
    x >>>= 0;
    this.state = x || 1;
    return this.state;
  }

  next() {
    return this.nextU32() / 4294967296;
  }

  range(lo, hi) {
    return lo + (hi - lo) * this.next();
  }

  int(lo, hi) {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }

  // Uniform point on the unit sphere.
  onSphere() {
    const z = this.range(-1, 1);
    const t = this.range(0, Math.PI * 2);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return { x: r * Math.cos(t), y: z, z: r * Math.sin(t) };
  }

  // Derives an independent child stream. Used so that adding a call site in
  // one subsystem cannot shift the numbers another subsystem sees.
  fork(salt) {
    return new Rng(hashU32(this.state ^ hashU32(salt >>> 0)));
  }
}
