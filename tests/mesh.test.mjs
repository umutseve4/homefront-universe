import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MeshBuilder, faceNormal, boxMesh, sphereMesh, asteroidMesh,
  recomputeNormals, mergeMeshes, hullMesh, hullTypes,
  billboardQuad, fullscreenTriangle, starfield,
} from '../src/gfx/meshgen.js';

// A mesh is only usable by the renderer if all four of these hold. Every test
// below leans on this helper so a regression can never slip through on a hull
// that nobody wrote a bespoke test for.
function assertWellFormed(mesh, label) {
  assert.ok(mesh.positions instanceof Float32Array, `${label}: positions type`);
  assert.ok(mesh.normals instanceof Float32Array, `${label}: normals type`);
  assert.ok(mesh.indices instanceof Uint16Array, `${label}: indices type`);
  assert.equal(mesh.positions.length, mesh.normals.length, `${label}: attribute count mismatch`);
  assert.equal(mesh.positions.length % 3, 0, `${label}: positions not a multiple of 3`);
  assert.equal(mesh.indices.length % 3, 0, `${label}: indices not a multiple of 3`);
  assert.equal(mesh.vertexCount, mesh.positions.length / 3, `${label}: vertexCount`);
  assert.equal(mesh.triangleCount, mesh.indices.length / 3, `${label}: triangleCount`);
  for (let i = 0; i < mesh.indices.length; i++) {
    assert.ok(mesh.indices[i] < mesh.vertexCount, `${label}: index ${i} out of bounds`);
  }
  for (let i = 0; i < mesh.positions.length; i++) {
    assert.ok(Number.isFinite(mesh.positions[i]), `${label}: non-finite position at ${i}`);
    assert.ok(Number.isFinite(mesh.normals[i]), `${label}: non-finite normal at ${i}`);
  }
}

function assertUnitNormals(mesh, label) {
  const n = mesh.normals;
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]);
    assert.ok(Math.abs(len - 1) < 1e-3, `${label}: normal ${i / 3} has length ${len}`);
  }
}

// A closed surface has every edge shared by exactly two triangles.
function edgeManifoldReport(mesh) {
  const seen = new Map();
  const key = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  // Weld by position so the 24-vertex box still reads as closed.
  const weld = new Map();
  const id = new Int32Array(mesh.vertexCount);
  for (let v = 0; v < mesh.vertexCount; v++) {
    const k = `${mesh.positions[v * 3].toFixed(4)},${mesh.positions[v * 3 + 1].toFixed(4)},${mesh.positions[v * 3 + 2].toFixed(4)}`;
    if (!weld.has(k)) weld.set(k, weld.size);
    id[v] = weld.get(k);
  }
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = id[mesh.indices[t]], b = id[mesh.indices[t + 1]], c = id[mesh.indices[t + 2]];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = key(p, q);
      seen.set(k, (seen.get(k) || 0) + 1);
    }
  }
  let bad = 0;
  for (const count of seen.values()) if (count !== 2) bad++;
  return { edges: seen.size, nonManifold: bad };
}

// The signed volume of a closed, outward-wound surface is positive.
function signedVolume(mesh) {
  const p = mesh.positions, ix = mesh.indices;
  let vol = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    vol += (
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
    ) / 6;
  }
  return vol;
}

// --------------------------------------------------------------- the builder

test('MeshBuilder returns sequential vertex indices', () => {
  const b = new MeshBuilder();
  assert.equal(b.vertex(0, 0, 0, 0, 1, 0), 0);
  assert.equal(b.vertex(1, 0, 0, 0, 1, 0), 1);
  assert.equal(b.vertex(0, 0, 1, 0, 1, 0), 2);
  b.tri(0, 1, 2);
  const m = b.build();
  assert.equal(m.vertexCount, 3);
  assert.equal(m.triangleCount, 1);
});

test('MeshBuilder.quad emits two triangles sharing a diagonal', () => {
  const b = new MeshBuilder();
  for (let i = 0; i < 4; i++) b.vertex(i, 0, 0, 0, 1, 0);
  b.quad(0, 1, 2, 3);
  assert.deepEqual(Array.from(b.build().indices), [0, 1, 2, 0, 2, 3]);
});

test('MeshBuilder.face refuses a degenerate polygon', () => {
  const b = new MeshBuilder();
  assert.equal(b.face([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]), -1);
  assert.equal(b.build().vertexCount, 0);
});

test('faceNormal follows the right-hand rule', () => {
  const n = faceNormal({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  assert.ok(Math.abs(n.y - 1) < 1e-6, `expected +y, got ${JSON.stringify(n)}`);
});

// ------------------------------------------------------------- the primitives

test('boxMesh is a closed 12-triangle solid with hard normals', () => {
  const m = boxMesh(2, 2, 2);
  assertWellFormed(m, 'box');
  assertUnitNormals(m, 'box');
  assert.equal(m.vertexCount, 24, 'six faces of four unshared vertices');
  assert.equal(m.triangleCount, 12);
  assert.equal(edgeManifoldReport(m).nonManifold, 0);
});

test('boxMesh winds outward, so its signed volume is positive and exact', () => {
  const m = boxMesh(2, 3, 4);
  assert.ok(Math.abs(signedVolume(m) - 24) < 1e-3, `volume was ${signedVolume(m)}`);
});

test('boxMesh honours its offset without changing its size', () => {
  const m = boxMesh(2, 2, 2, 10, 0, 0);
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < m.positions.length; i += 3) {
    minX = Math.min(minX, m.positions[i]);
    maxX = Math.max(maxX, m.positions[i]);
  }
  assert.equal(minX, 9);
  assert.equal(maxX, 11);
});

test('sphereMesh puts every vertex on the requested radius', () => {
  const m = sphereMesh(7, 12, 8);
  assertWellFormed(m, 'sphere');
  assertUnitNormals(m, 'sphere');
  for (let i = 0; i < m.positions.length; i += 3) {
    const r = Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2]);
    assert.ok(Math.abs(r - 7) < 1e-3, `radius drifted to ${r}`);
  }
});

test('sphereMesh clamps absurd tessellation requests instead of throwing', () => {
  const m = sphereMesh(1, 0, 0);
  assertWellFormed(m, 'degenerate sphere');
  assert.ok(m.triangleCount > 0);
});

test('sphereMesh normals point away from the origin', () => {
  const m = sphereMesh(5, 10, 6);
  for (let i = 0; i < m.positions.length; i += 3) {
    const dot = (m.positions[i] * m.normals[i] +
      m.positions[i + 1] * m.normals[i + 1] +
      m.positions[i + 2] * m.normals[i + 2]);
    assert.ok(dot > 0, `inward normal at vertex ${i / 3}`);
  }
});

// -------------------------------------------------------------- the asteroids

test('asteroidMesh is deterministic for a given seed', () => {
  const a = asteroidMesh(40, 99);
  const b = asteroidMesh(40, 99);
  assert.deepEqual(Array.from(a.positions), Array.from(b.positions));
});

test('asteroidMesh differs between seeds', () => {
  const a = asteroidMesh(40, 1);
  const b = asteroidMesh(40, 2);
  let differs = false;
  for (let i = 0; i < a.positions.length; i++) {
    if (Math.abs(a.positions[i] - b.positions[i]) > 1e-4) { differs = true; break; }
  }
  assert.ok(differs, 'two seeds produced the same rock');
});

test('asteroidMesh stays inside a sane radius band', () => {
  const m = asteroidMesh(40, 7);
  assertWellFormed(m, 'asteroid');
  assertUnitNormals(m, 'asteroid');
  for (let i = 0; i < m.positions.length; i += 3) {
    const r = Math.hypot(m.positions[i], m.positions[i + 1], m.positions[i + 2]);
    assert.ok(r > 40 * 0.5 && r < 40 * 1.6, `displaced radius ${r} is out of band`);
  }
});

test('asteroidMesh remains closed after displacement', () => {
  assert.equal(edgeManifoldReport(asteroidMesh(30, 5)).nonManifold, 0);
});

test('recomputeNormals renormalises a hand-mangled mesh', () => {
  const m = sphereMesh(3, 8, 6);
  m.normals.fill(17);
  recomputeNormals(m);
  assertUnitNormals(m, 'recomputed');
});

// ------------------------------------------------------------------ the merge

test('mergeMeshes offsets indices so no triangle points at the wrong solid', () => {
  const a = boxMesh(1, 1, 1, -5, 0, 0);
  const b = boxMesh(1, 1, 1, 5, 0, 0);
  const m = mergeMeshes([a, b]);
  assertWellFormed(m, 'merged');
  assert.equal(m.vertexCount, a.vertexCount + b.vertexCount);
  assert.equal(m.triangleCount, a.triangleCount + b.triangleCount);
  assert.equal(edgeManifoldReport(m).nonManifold, 0, 'two disjoint boxes are still closed');
});

test('mergeMeshes of an empty list yields an empty mesh, not a crash', () => {
  const m = mergeMeshes([]);
  assert.equal(m.vertexCount, 0);
  assert.equal(m.triangleCount, 0);
});

// ------------------------------------------------------------------- the hulls

test('every hull type builds a well-formed mesh with unit normals', () => {
  const types = hullTypes();
  assert.ok(types.length >= 10, `expected the full roster, saw ${types.length}`);
  for (const t of types) {
    const m = hullMesh(t);
    assertWellFormed(m, t);
    assertUnitNormals(m, t);
    assert.ok(m.triangleCount >= 36, `${t} is suspiciously simple`);
  }
});

test('hulls stay well under the Uint16 index ceiling', () => {
  for (const t of hullTypes()) {
    assert.ok(hullMesh(t).vertexCount < 65536, `${t} overflows Uint16`);
  }
});

test('an unknown hull name degrades to the scout instead of throwing', () => {
  const fallback = hullMesh('battlecruiser-of-theseus');
  assert.deepEqual(Array.from(fallback.positions), Array.from(hullMesh('scout').positions));
});

test('hulls are longer along Z than they are wide, because they face -Z', () => {
  for (const t of ['scout', 'interceptor', 'frigate', 'destroyer', 'mothership']) {
    const m = hullMesh(t);
    let sx = 0, sz = 0;
    for (let i = 0; i < m.positions.length; i += 3) {
      sx = Math.max(sx, Math.abs(m.positions[i]));
      sz = Math.max(sz, Math.abs(m.positions[i + 2]));
    }
    assert.ok(sz > sx, `${t} is wider (${sx}) than it is long (${sz})`);
  }
});

// ------------------------------------------------------------------ the extras

test('billboardQuad is a unit square of two triangles', () => {
  const m = billboardQuad();
  assertWellFormed(m, 'billboard');
  assert.equal(m.vertexCount, 4);
  assert.equal(m.triangleCount, 2);
});

test('fullscreenTriangle covers the clip cube', () => {
  const t = fullscreenTriangle();
  assert.equal(t.length, 6);
  assert.ok(Math.max(...t) >= 3, 'the triangle must overhang the cube');
});

test('starfield is deterministic and lands on the requested shell', () => {
  const a = starfield(64, 42, 1000);
  const b = starfield(64, 42, 1000);
  assert.deepEqual(Array.from(a), Array.from(b));
  for (let i = 0; i < 64; i++) {
    const r = Math.hypot(a[i * 4], a[i * 4 + 1], a[i * 4 + 2]);
    assert.ok(Math.abs(r - 1000) < 1e-2, `star ${i} sits at ${r}`);
    assert.ok(a[i * 4 + 3] > 0 && a[i * 4 + 3] <= 1, 'brightness out of range');
  }
});
