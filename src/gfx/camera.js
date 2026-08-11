import { clamp, v3, v3sub, v3len, v3norm, mat4identity, mat4mul, mat4perspective, mat4lookAt, mat4invert, unproject, rayPlaneY } from '../core/math.js';

// Orbit camera in the Homeworld idiom: a focus point on the tactical plane,
// plus yaw/pitch/distance. Every matrix is written into a pre-allocated
// Float32Array; the per-frame path allocates nothing.
export class Camera {
  constructor(opts) {
    const o = opts || {};
    this.focus = o.focus ? v3(o.focus.x, o.focus.y, o.focus.z) : v3(0, 0, 0);
    this.yaw = o.yaw !== undefined ? o.yaw : 0.6;
    this.pitch = o.pitch !== undefined ? o.pitch : 0.55;
    this.distance = o.distance !== undefined ? o.distance : 900;

    this.minDistance = o.minDistance !== undefined ? o.minDistance : 60;
    this.maxDistance = o.maxDistance !== undefined ? o.maxDistance : 6000;
    // Clamped short of +/- PI/2 so the up vector never becomes degenerate.
    this.minPitch = o.minPitch !== undefined ? o.minPitch : -1.45;
    this.maxPitch = o.maxPitch !== undefined ? o.maxPitch : 1.45;

    this.fovy = o.fovy !== undefined ? o.fovy : 0.9;
    this.near = o.near !== undefined ? o.near : 1.0;
    this.far = o.far !== undefined ? o.far : 60000;
    this.aspect = o.aspect !== undefined ? o.aspect : 16 / 9;

    // Smoothed targets. update() eases the live values towards these.
    this.targetFocus = v3(this.focus.x, this.focus.y, this.focus.z);
    this.targetDistance = this.distance;
    this.smoothing = o.smoothing !== undefined ? o.smoothing : 10;

    this.view = mat4identity();
    this.proj = mat4identity();
    this.viewProj = mat4identity();
    this.invViewProj = mat4identity();
    this.eye = v3(0, 0, 0);
    this.up = v3(0, 1, 0);
    this._invValid = false;

    this.recompute();
  }

  setAspect(aspect) {
    if (aspect > 0 && aspect !== this.aspect) this.aspect = aspect;
  }

  orbit(dYaw, dPitch) {
    this.yaw += dYaw;
    // Keep yaw in [0, 2PI) so long sessions cannot accumulate float error.
    const twoPi = Math.PI * 2;
    this.yaw = ((this.yaw % twoPi) + twoPi) % twoPi;
    this.pitch = clamp(this.pitch + dPitch, this.minPitch, this.maxPitch);
  }

  zoom(factor) {
    this.targetDistance = clamp(this.targetDistance * factor, this.minDistance, this.maxDistance);
  }

  // Pans across the tactical plane in screen-relative directions.
  pan(dRight, dForward) {
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    const scale = this.distance * 0.0016;
    this.targetFocus.x += (c * dRight - s * dForward) * scale;
    this.targetFocus.z += (s * dRight + c * dForward) * scale;
  }

  focusOn(point, distance) {
    this.targetFocus.x = point.x;
    this.targetFocus.y = point.y;
    this.targetFocus.z = point.z;
    if (distance !== undefined) {
      this.targetDistance = clamp(distance, this.minDistance, this.maxDistance);
    }
  }

  // Frames a set of points. Uses the vertical FOV, so it is conservative on
  // wide viewports, which is what you want for a selection frame.
  frame(points, padding) {
    if (!points || points.length === 0) return;
    let cx = 0, cy = 0, cz = 0;
    for (const p of points) { cx += p.x; cy += p.y; cz += p.z; }
    const n = points.length;
    const centre = v3(cx / n, cy / n, cz / n);
    let radius = 0;
    for (const p of points) {
      const d = v3len(v3sub(p, centre));
      if (d > radius) radius = d;
    }
    radius = Math.max(radius, this.minDistance * 0.5);
    const dist = (radius * (padding || 1.6)) / Math.tan(this.fovy * 0.5);
    this.focusOn(centre, dist);
  }

  // dt in seconds. Exponential smoothing; frame-rate independent.
  update(dt) {
    const k = this.smoothing > 0 ? 1 - Math.exp(-this.smoothing * Math.max(0, dt)) : 1;
    this.focus.x += (this.targetFocus.x - this.focus.x) * k;
    this.focus.y += (this.targetFocus.y - this.focus.y) * k;
    this.focus.z += (this.targetFocus.z - this.focus.z) * k;
    this.distance += (this.targetDistance - this.distance) * k;
    this.recompute();
  }

  // Snaps live values to their targets and rebuilds the matrices. Used on
  // init and after a teleport, where smoothing would be wrong.
  snap() {
    this.focus.x = this.targetFocus.x;
    this.focus.y = this.targetFocus.y;
    this.focus.z = this.targetFocus.z;
    this.distance = this.targetDistance;
    this.recompute();
  }

  recompute() {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    this.eye.x = this.focus.x + this.distance * cp * sy;
    this.eye.y = this.focus.y + this.distance * sp;
    this.eye.z = this.focus.z + this.distance * cp * cy;

    mat4perspective(this.proj, this.fovy, this.aspect, this.near, this.far);
    mat4lookAt(this.view, this.eye, this.focus, this.up);
    mat4mul(this.viewProj, this.proj, this.view);
    // The inverse is only needed by the sky pass and by picking, so it is
    // computed lazily.
    this._invValid = false;
    return this.viewProj;
  }

  inverseViewProj() {
    if (!this._invValid) {
      const ok = mat4invert(this.invViewProj, this.viewProj);
      if (!ok) return null;
      this._invValid = true;
    }
    return this.invViewProj;
  }

  // ndc coordinates: x and y both in [-1, 1], y up.
  rayFromNdc(ndcX, ndcY) {
    const inv = this.inverseViewProj();
    if (!inv) return null;
    return unproject(inv, ndcX, ndcY);
  }

  // Where a screen ray meets the tactical plane. Returns null when the ray
  // runs away from the plane, which the caller must handle (no silent zero).
  pickPlane(ndcX, ndcY, height) {
    const ray = this.rayFromNdc(ndcX, ndcY);
    if (!ray) return null;
    return rayPlaneY(ray.origin, ray.dir, height || 0);
  }

  // Direction from the camera towards the focus point, normalised.
  forward() {
    return v3norm(v3sub(this.focus, this.eye));
  }

  // World-space offset of the eye relative to the focus. Handy for shaders
  // that want a stable light rig relative to the viewer.
  offset() {
    return v3sub(this.eye, this.focus);
  }

  // Serialisable state, for save/restore of the view between sessions.
  state() {
    return {
      focus: { x: this.focus.x, y: this.focus.y, z: this.focus.z },
      yaw: this.yaw,
      pitch: this.pitch,
      distance: this.distance,
    };
  }

  restore(s) {
    if (!s) return;
    if (s.focus) {
      this.targetFocus.x = s.focus.x;
      this.targetFocus.y = s.focus.y;
      this.targetFocus.z = s.focus.z;
    }
    if (typeof s.yaw === 'number') this.yaw = s.yaw;
    if (typeof s.pitch === 'number') this.pitch = clamp(s.pitch, this.minPitch, this.maxPitch);
    if (typeof s.distance === 'number') {
      this.targetDistance = clamp(s.distance, this.minDistance, this.maxDistance);
    }
    this.snap();
  }
}

// Screen-space radius of a world sphere, in normalised device units.
// Used for selection-ring sizing and for a cheap distance cull.
export function ndcRadius(camera, centre, radius) {
  const d = v3len(v3sub(centre, camera.eye));
  if (d <= radius) return Infinity;
  return radius / (d * Math.tan(camera.fovy * 0.5));
}

// Converts a pixel position to normalised device coordinates.
export function pixelToNdc(x, y, width, height) {
  return {
    x: (x / width) * 2 - 1,
    y: 1 - (y / height) * 2,
  };
}
