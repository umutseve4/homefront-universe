// Procedural mesh generation. Pure arithmetic: no WebGL, no DOM, no globals.
// Everything here is unit-testable under plain Node, which is the whole point
// of keeping it separate from gl.js.
//
// A mesh is { positions: Float32Array, normals: Float32Array,
//             indices: Uint16Array, vertexCount, triangleCount }
// Triangles are counter-clockwise when viewed from outside.

import { v3norm, v3sub, v3cross } from '../core/math.js';
import { Rng } from '../core/rng.js';

// A growable mesh builder. Cheaper than repeated array concatenation and it
// keeps the winding logic in exactly one place.
export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.idx = [];
  }

  vertex(x, y, z, nx, ny, nz) {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    return i;
  }

  tri(a, b, c) {
    this.idx.push(a, b, c);
  }

  quad(a, b, c, d) {
    this.idx.push(a, b, c, a, c, d);
  }

  // Adds a convex polygon as a triangle fan with a single flat normal derived
  // from its own winding. Returns the index of the first vertex.
  face(points) {
    if (points.length < 3) return -1;
    const n = faceNormal(points[0], points[1], points[2]);
    const base = this.pos.length / 3;
    for (const p of points) this.vertex(p.x, p.y, p.z, n.x, n.y, n.z);
    for (let i = 1; i < points.length - 1; i++) this.tri(base, base + i, base + i + 1);
    return base;
  }

  build() {
    const vertexCount = this.pos.length / 3;
    if (vertexCount > 65535) throw new Error(`mesh exceeds Uint16 index space: ${vertexCount}`);
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      indices: new Uint16Array(this.idx),
      vertexCount,
      triangleCount: this.idx.length / 3,
    };
  }
}

export function faceNormal(a, b, c) {
  return v3norm(v3cross(v3sub(b, a), v3sub(c, a)));
}

// ------------------------------------------------------------------ primitives

// An axis-aligned box centred on the origin. 24 vertices so each face keeps a
// hard normal; smoothing a hull box looks wrong on a warship.
export function boxMesh(sx, sy, sz, ox, oy, oz) {
  ox = ox || 0; oy = oy || 0; oz = oz || 0;
  const b = new MeshBuilder();
  const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
  const c = (x, y, z) => ({ x: ox + x * hx, y: oy + y * hy, z: oz + z * hz });
  b.face([c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)]);     // +z
  b.face([c(1, -1, -1), c(-1, -1, -1), c(-1, 1, -1), c(1, 1, -1)]); // -z
  b.face([c(1, -1, 1), c(1, -1, -1), c(1, 1, -1), c(1, 1, 1)]);     // +x
  b.face([c(-1, -1, -1), c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1)]); // -x
  b.face([c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1), c(-1, 1, -1)]);     // +y
  b.face([c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1)]); // -y
  return b.build();
}

// A UV sphere. Used for asteroids after displacement and for engine glow bulbs.
export function sphereMesh(radius, segments, rings) {
  segments = Math.max(3, segments | 0);
  rings = Math.max(2, rings | 0);
  const b = new MeshBuilder();
  // The poles are single vertices and the theta seam is not duplicated. That
  // costs us per-vertex UVs, which this renderer does not use, and buys a
  // genuinely closed manifold: no degenerate pole triangles, no orphan
  // vertices, and therefore no zero-length normals after a displacement pass.
  const top = b.vertex(0, radius, 0, 0, 1, 0);
  const rowStart = [];
  for (let r = 1; r < rings; r++) {
    const phi = (r / rings) * Math.PI;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    rowStart.push(b.pos.length / 3);
    for (let s = 0; s < segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const nx = sp * Math.cos(theta), ny = cp, nz = sp * Math.sin(theta);
      b.vertex(nx * radius, ny * radius, nz * radius, nx, ny, nz);
    }
  }
  const bottom = b.vertex(0, -radius, 0, 0, -1, 0);

  const first = rowStart[0];
  for (let s = 0; s < segments; s++) {
    b.tri(top, first + s, first + ((s + 1) % segments));
  }
  for (let r = 0; r < rowStart.length - 1; r++) {
    const upper = rowStart[r], lower = rowStart[r + 1];
    for (let s = 0; s < segments; s++) {
      const t = (s + 1) % segments;
      b.quad(upper + s, lower + s, lower + t, upper + t);
    }
  }
  const last = rowStart[rowStart.length - 1];
  for (let s = 0; s < segments; s++) {
    b.tri(last + s, bottom, last + ((s + 1) % segments));
  }
  return b.build();
}

// An asteroid: a sphere pushed around by three octaves of value noise keyed off
// the seed, so the same seed always yields the same rock.
export function asteroidMesh(radius, seed) {
  const base = sphereMesh(radius, 16, 12);
  const rng = new Rng(seed >>> 0);
  const lumps = [];
  for (let i = 0; i < 7; i++) {
    lumps.push({
      dir: rng.onSphere(),
      amp: rng.range(0.12, 0.34),
      tight: rng.range(1.6, 4.2),
    });
  }
  const p = base.positions;
  for (let i = 0; i < p.length; i += 3) {
    const len = Math.hypot(p[i], p[i + 1], p[i + 2]) || 1;
    const ux = p[i] / len, uy = p[i + 1] / len, uz = p[i + 2] / len;
    let disp = 0;
    for (const l of lumps) {
      const d = ux * l.dir.x + uy * l.dir.y + uz * l.dir.z;
      disp += l.amp * Math.pow(Math.max(0, d), l.tight);
    }
    const s = radius * (0.78 + disp);
    p[i] = ux * s; p[i + 1] = uy * s; p[i + 2] = uz * s;
  }
  recomputeNormals(base);
  return base;
}

// Area-weighted vertex normals. Called after any displacement pass.
export function recomputeNormals(mesh) {
  const { positions, normals, indices } = mesh;
  normals.fill(0);
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t] * 3, ib = indices[t + 1] * 3, ic = indices[t + 2] * 3;
    const ux = positions[ib] - positions[ia];
    const uy = positions[ib + 1] - positions[ia + 1];
    const uz = positions[ib + 2] - positions[ia + 2];
    const vx = positions[ic] - positions[ia];
    const vy = positions[ic + 1] - positions[ia + 1];
    const vz = positions[ic + 2] - positions[ia + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
    normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
    normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
  }
  return mesh;
}

// Merges b into a, offsetting b's indices. Both must be plain mesh objects.
export function mergeMeshes(list) {
  const b = new MeshBuilder();
  for (const m of list) {
    const base = b.pos.length / 3;
    for (let i = 0; i < m.positions.length; i++) b.pos.push(m.positions[i]);
    for (let i = 0; i < m.normals.length; i++) b.nrm.push(m.normals[i]);
    for (let i = 0; i < m.indices.length; i++) b.idx.push(m.indices[i] + base);
  }
  return b.build();
}

// ----------------------------------------------------------------- ship hulls

// Every hull is built from boxes so the silhouette reads at a distance and the
// triangle budget stays tiny. Ships face -Z, matching mat4model.
function hullFromParts(parts) {
  return mergeMeshes(parts.map((p) => boxMesh(p[0], p[1], p[2], p[3], p[4], p[5])));
}

const HULL_RECIPES = {
  // [sx, sy, sz, ox, oy, oz]
  scout: [
    [0.5, 0.4, 2.4, 0, 0, 0],
    [1.8, 0.15, 0.7, 0, 0, 0.5],
    [0.3, 0.3, 0.5, 0, 0, 1.3],
  ],
  interceptor: [
    [0.6, 0.5, 2.8, 0, 0, 0],
    [2.4, 0.18, 0.9, 0, -0.05, 0.4],
    [0.25, 0.5, 0.9, 0.9, 0.2, 0.6],
    [0.25, 0.5, 0.9, -0.9, 0.2, 0.6],
  ],
  bomber: [
    [1.0, 0.8, 3.0, 0, 0, 0],
    [2.6, 0.22, 1.1, 0, -0.1, 0.3],
    [0.5, 0.5, 1.2, 0, -0.5, -0.2],
  ],
  collector: [
    [1.4, 1.2, 3.2, 0, 0, 0],
    [0.9, 0.9, 1.4, 0, 0, -1.9],
    [0.4, 0.4, 1.0, 0.9, 0, 1.4],
    [0.4, 0.4, 1.0, -0.9, 0, 1.4],
  ],
  corvette: [
    [1.2, 1.0, 4.0, 0, 0, 0],
    [0.4, 0.9, 1.2, 1.0, 0.2, -0.4],
    [0.4, 0.9, 1.2, -1.0, 0.2, -0.4],
    [0.6, 0.6, 1.0, 0, 0.4, 1.6],
  ],
  frigate: [
    [1.8, 1.4, 6.0, 0, 0, 0],
    [3.0, 0.4, 1.6, 0, 0.3, -1.2],
    [0.8, 0.8, 1.6, 0, -0.6, 1.8],
    [0.5, 1.2, 1.2, 0, 1.0, -0.6],
  ],
  destroyer: [
    [2.6, 1.8, 9.0, 0, 0, 0],
    [4.2, 0.5, 2.2, 0, 0.4, -2.0],
    [1.2, 1.2, 2.4, 0, -0.8, 2.6],
    [0.9, 1.6, 2.0, 0, 1.4, -1.0],
    [0.7, 0.7, 1.4, 1.5, 0.2, 2.0],
    [0.7, 0.7, 1.4, -1.5, 0.2, 2.0],
  ],
  carrier: [
    [4.0, 2.4, 13.0, 0, 0, 0],
    [6.5, 0.6, 4.0, 0, 1.2, -1.0],
    [1.6, 1.6, 3.0, 0, -1.2, 4.0],
    [1.2, 2.0, 2.6, 0, 2.0, -3.0],
  ],
  mothership: [
    [6.0, 4.0, 20.0, 0, 0, 0],
    [9.0, 1.0, 7.0, 0, 2.2, -2.0],
    [3.0, 3.0, 5.0, 0, -2.0, 7.0],
    [2.0, 3.4, 4.0, 0, 3.4, -5.0],
    [1.4, 1.4, 3.0, 3.4, 0.5, 4.0],
    [1.4, 1.4, 3.0, -3.4, 0.5, 4.0],
  ],
  shipyard: [
    [5.0, 3.0, 12.0, 0, 0, 0],
    [1.2, 6.0, 1.2, 3.2, 0, -2.0],
    [1.2, 6.0, 1.2, -3.2, 0, -2.0],
    [7.4, 1.0, 2.0, 0, 3.0, -2.0],
  ],
};

// Builds one hull by type name. Unknown names fall back to the scout so a bad
// def can never crash the renderer.
export function hullMesh(type) {
  const recipe = HULL_RECIPES[type] || HULL_RECIPES.scout;
  return hullFromParts(recipe);
}

export function hullTypes() {
  return Object.keys(HULL_RECIPES);
}

// A screen-filling triangle used by the sky pass. Bigger than the clip cube on
// purpose so no seam ever shows.
export function fullscreenTriangle() {
  return new Float32Array([-1, -1, 3, -1, -1, 3]);
}

// A unit billboard quad in the XY plane, used for engine flares.
export function billboardQuad() {
  const b = new MeshBuilder();
  b.vertex(-0.5, -0.5, 0, 0, 0, 1);
  b.vertex(0.5, -0.5, 0, 0, 0, 1);
  b.vertex(0.5, 0.5, 0, 0, 0, 1);
  b.vertex(-0.5, 0.5, 0, 0, 0, 1);
  b.quad(0, 1, 2, 3);
  return b.build();
}

// Deterministic starfield points on a large sphere. Returns interleaved
// [x,y,z,brightness] so one buffer feeds the whole pass.
export function starfield(count, seed, radius) {
  const rng = new Rng(seed >>> 0);
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const d = rng.onSphere();
    const b = Math.pow(rng.next(), 3.0) * 0.9 + 0.1;
    out[i * 4] = d.x * radius;
    out[i * 4 + 1] = d.y * radius;
    out[i * 4 + 2] = d.z * radius;
    out[i * 4 + 3] = b;
  }
  return out;
}
