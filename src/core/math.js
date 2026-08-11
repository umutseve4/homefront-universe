// Minimal linear algebra. Column-major mat4, matching GLSL's layout.
// Every function is pure and allocation-light; out params are used on hot paths.

export const EPS = 1e-6;

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function v3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

export function v3add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function v3sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function v3scale(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function v3dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function v3cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function v3len(a) {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function v3dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function v3dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function v3norm(a) {
  const l = v3len(a);
  if (l < EPS) return { x: 0, y: 0, z: 0 };
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

export function v3lerp(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
}

export function mat4identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

// out = a * b, column-major.
export function mat4mul(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4 + 0];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    out[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

export function mat4perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function mat4lookAt(out, eye, target, up) {
  const z = v3norm(v3sub(eye, target));
  let x = v3cross(up, z);
  if (v3len(x) < EPS) x = v3cross({ x: 0, y: 0, z: 1 }, z);
  x = v3norm(x);
  const y = v3cross(z, x);
  out[0] = x.x; out[1] = y.x; out[2] = z.x; out[3] = 0;
  out[4] = x.y; out[5] = y.y; out[6] = z.y; out[7] = 0;
  out[8] = x.z; out[9] = y.z; out[10] = z.z; out[11] = 0;
  out[12] = -v3dot(x, eye);
  out[13] = -v3dot(y, eye);
  out[14] = -v3dot(z, eye);
  out[15] = 1;
  return out;
}

// Builds a model matrix from position, a forward direction and a uniform scale.
export function mat4model(out, pos, fwd, scale) {
  const z = v3norm(v3scale(fwd, -1)); // model looks down -Z
  let x = v3cross({ x: 0, y: 1, z: 0 }, z);
  if (v3len(x) < EPS) x = v3cross({ x: 0, y: 0, z: 1 }, z);
  x = v3norm(x);
  const y = v3cross(z, x);
  out[0] = x.x * scale; out[1] = x.y * scale; out[2] = x.z * scale; out[3] = 0;
  out[4] = y.x * scale; out[5] = y.y * scale; out[6] = y.z * scale; out[7] = 0;
  out[8] = z.x * scale; out[9] = z.y * scale; out[10] = z.z * scale; out[11] = 0;
  out[12] = pos.x; out[13] = pos.y; out[14] = pos.z; out[15] = 1;
  return out;
}

// Projects a world point with a view-projection matrix.
// Returns null when the point is behind the camera.
export function projectPoint(vp, p) {
  const x = vp[0] * p.x + vp[4] * p.y + vp[8] * p.z + vp[12];
  const y = vp[1] * p.x + vp[5] * p.y + vp[9] * p.z + vp[13];
  const w = vp[3] * p.x + vp[7] * p.y + vp[11] * p.z + vp[15];
  if (w <= EPS) return null;
  return { x: x / w, y: y / w, w };
}

// General 4x4 inverse via cofactor expansion. Returns null for a singular
// matrix rather than emitting NaNs, so callers can fail loudly.
// Out-param first, matching the rest of the mat4 API.
export function mat4invert(out, m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * id;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * id;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * id;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * id;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * id;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * id;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * id;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * id;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * id;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * id;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * id;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * id;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * id;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * id;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * id;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * id;
  return out;
}

// Turns a normalised-device-coordinate pair into a world-space ray.
// invVp must be the inverse of the same view-projection used for rendering.
export function unproject(invVp, ndcX, ndcY) {
  const near = mat4mulPoint(invVp, ndcX, ndcY, -1);
  const far = mat4mulPoint(invVp, ndcX, ndcY, 1);
  if (!near || !far) return null;
  const dir = v3norm(v3sub(far, near));
  return { origin: near, dir };
}

// Multiplies a homogeneous point and performs the perspective divide.
export function mat4mulPoint(m, x, y, z) {
  const px = m[0] * x + m[4] * y + m[8] * z + m[12];
  const py = m[1] * x + m[5] * y + m[9] * z + m[13];
  const pz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const pw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (Math.abs(pw) < 1e-12) return null;
  return { x: px / pw, y: py / pw, z: pz / pw };
}

// Closest approach between a ray and a sphere. Returns the ray parameter t of
// the nearest hit, or -1 when there is no hit in front of the origin.
export function raySphere(origin, dir, centre, radius) {
  const oc = v3sub(origin, centre);
  const b = v3dot(oc, dir);
  const c = v3dot(oc, oc) - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  if (t0 >= 0) return t0;
  const t1 = -b + s;
  return t1 >= 0 ? t1 : -1;
}

// Intersects a ray with the plane y = height. Returns null when parallel or
// when the hit is behind the ray origin.
export function rayPlaneY(origin, dir, height) {
  if (Math.abs(dir.y) < 1e-9) return null;
  const t = (height - origin.y) / dir.y;
  if (t < 0) return null;
  return { x: origin.x + dir.x * t, y: height, z: origin.z + dir.z * t };
}
