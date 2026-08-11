import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mat4identity, mat4mul, mat4perspective, mat4lookAt, mat4invert,
  mat4mulPoint, unproject, raySphere, rayPlaneY, v3, v3len, v3sub, v3dot,
} from '../src/core/math.js';
import { Camera, ndcRadius, pixelToNdc } from '../src/gfx/camera.js';
import { VS_HULL, FS_HULL, VS_STAR, FS_STAR, VS_LINE, FS_LINE, VS_SKY, FS_SKY } from '../src/gfx/shaders.js';
import { GL_CONSTS, INSTANCE_FLOATS, compileShader, linkProgram, uniformMap, setDefaultState } from '../src/gfx/gl.js';

// Float32Array round-tripping leaves a few ulps of residue; matrix identities
// are checked at 1e-4, consistent with tests/sim.test.mjs.
const MAT_TOL = 1e-4;

function assertMatClose(actual, expected, tol, label) {
  for (let i = 0; i < 16; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= (tol || MAT_TOL),
      `${label || 'matrix'}[${i}]: ${actual[i]} != ${expected[i]}`,
    );
  }
}

// ---------------------------------------------------------------- mat4invert

test('mat4invert of the identity is the identity', () => {
  const out = mat4identity();
  const r = mat4invert(out, mat4identity());
  assert.ok(r === out);
  assertMatClose(out, mat4identity(), 1e-9, 'inv(I)');
});

test('mat4invert returns null for a singular matrix', () => {
  const singular = mat4identity();
  singular[0] = 0;
  singular[5] = 0;
  singular[10] = 0;
  singular[15] = 0;
  assert.equal(mat4invert(mat4identity(), singular), null);
});

test('m * inv(m) is the identity for a view-projection matrix', () => {
  const proj = mat4perspective(mat4identity(), 0.9, 16 / 9, 1, 5000);
  const view = mat4lookAt(mat4identity(), v3(120, 300, -240), v3(10, 0, 40), v3(0, 1, 0));
  const vp = mat4mul(mat4identity(), proj, view);
  const inv = mat4invert(mat4identity(), vp);
  assert.ok(inv, 'view-projection must be invertible');
  const prod = mat4mul(mat4identity(), vp, inv);
  assertMatClose(prod, mat4identity(), 1e-3, 'vp * inv(vp)');
});

test('mat4mulPoint round-trips a world point through vp and its inverse', () => {
  const proj = mat4perspective(mat4identity(), 0.8, 1.5, 1, 4000);
  const view = mat4lookAt(mat4identity(), v3(0, 400, 600), v3(0, 0, 0), v3(0, 1, 0));
  const vp = mat4mul(mat4identity(), proj, view);
  const inv = mat4invert(mat4identity(), vp);

  const world = { x: 130, y: 25, z: -80 };
  const ndc = mat4mulPoint(vp, world.x, world.y, world.z);
  assert.ok(ndc, 'point must be in front of the camera');
  const back = mat4mulPoint(inv, ndc.x, ndc.y, ndc.z);
  assert.ok(back);
  assert.ok(v3len(v3sub(back, world)) < 0.5, `round trip drifted: ${JSON.stringify(back)}`);
});

test('mat4mulPoint returns null when w collapses to zero', () => {
  const m = mat4identity();
  m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 0;
  assert.equal(mat4mulPoint(m, 1, 2, 3), null);
});

// -------------------------------------------------------------------- unproject

test('unproject produces a normalised ray pointing away from the eye', () => {
  const proj = mat4perspective(mat4identity(), 0.9, 1.0, 1, 5000);
  const eye = v3(0, 200, 500);
  const view = mat4lookAt(mat4identity(), eye, v3(0, 0, 0), v3(0, 1, 0));
  const vp = mat4mul(mat4identity(), proj, view);
  const inv = mat4invert(mat4identity(), vp);

  const ray = unproject(inv, 0, 0);
  assert.ok(ray);
  assert.ok(Math.abs(v3len(ray.dir) - 1) < 1e-4, 'direction must be unit length');
  // Centre pixel looks at the focus point, so the ray must head towards it.
  const toFocus = v3sub(v3(0, 0, 0), ray.origin);
  assert.ok(v3dot(ray.dir, toFocus) > 0, 'centre ray must point at the focus');
});

// ------------------------------------------------------------------ ray tests

test('raySphere finds the near hit for a ray through the centre', () => {
  const t = raySphere(v3(0, 0, -10), v3(0, 0, 1), v3(0, 0, 0), 2);
  assert.ok(Math.abs(t - 8) < 1e-6, `expected 8, got ${t}`);
});

test('raySphere misses a sphere that is off to the side', () => {
  assert.equal(raySphere(v3(0, 50, -10), v3(0, 0, 1), v3(0, 0, 0), 2), -1);
});

test('raySphere ignores hits behind the ray origin', () => {
  assert.equal(raySphere(v3(0, 0, 10), v3(0, 0, 1), v3(0, 0, 0), 2), -1);
});

test('raySphere returns the exit point when the origin is inside', () => {
  const t = raySphere(v3(0, 0, 0), v3(0, 0, 1), v3(0, 0, 0), 5);
  assert.ok(Math.abs(t - 5) < 1e-6, `expected 5, got ${t}`);
});

test('rayPlaneY hits the tactical plane', () => {
  const hit = rayPlaneY(v3(0, 100, 0), v3(0, -1, 0), 0);
  assert.ok(hit);
  assert.ok(Math.abs(hit.y) < 1e-9);
  assert.ok(Math.abs(hit.x) < 1e-9 && Math.abs(hit.z) < 1e-9);
});

test('rayPlaneY returns null for a parallel ray and for a hit behind the origin', () => {
  assert.equal(rayPlaneY(v3(0, 100, 0), v3(1, 0, 0), 0), null);
  assert.equal(rayPlaneY(v3(0, 100, 0), v3(0, 1, 0), 0), null);
});

// --------------------------------------------------------------------- camera

test('camera places the eye at the requested distance from the focus', () => {
  const cam = new Camera({ distance: 800, yaw: 0.3, pitch: 0.4 });
  const d = v3len(v3sub(cam.eye, cam.focus));
  assert.ok(Math.abs(d - 800) < 1e-6, `expected 800, got ${d}`);
});

test('camera zoom clamps to the configured range', () => {
  const cam = new Camera({ distance: 900, minDistance: 60, maxDistance: 3000 });
  for (let i = 0; i < 40; i++) cam.zoom(0.8);
  cam.snap();
  assert.equal(cam.distance, 60);
  for (let i = 0; i < 80; i++) cam.zoom(1.25);
  cam.snap();
  assert.equal(cam.distance, 3000);
});

test('camera pitch clamps short of the pole so up never degenerates', () => {
  const cam = new Camera();
  for (let i = 0; i < 100; i++) cam.orbit(0, 0.2);
  assert.ok(cam.pitch <= cam.maxPitch + 1e-12);
  assert.ok(cam.pitch < Math.PI / 2, 'pitch must stay below the pole');
  for (let i = 0; i < 200; i++) cam.orbit(0, -0.2);
  assert.ok(cam.pitch >= cam.minPitch - 1e-12);
});

test('camera yaw stays wrapped into [0, 2PI)', () => {
  const cam = new Camera();
  for (let i = 0; i < 100; i++) cam.orbit(0.5, 0);
  assert.ok(cam.yaw >= 0 && cam.yaw < Math.PI * 2, `yaw escaped: ${cam.yaw}`);
  for (let i = 0; i < 300; i++) cam.orbit(-0.5, 0);
  assert.ok(cam.yaw >= 0 && cam.yaw < Math.PI * 2, `yaw escaped: ${cam.yaw}`);
});

test('camera update eases towards the target and eventually arrives', () => {
  const cam = new Camera({ distance: 500 });
  cam.focusOn({ x: 1000, y: 0, z: -500 }, 1200);
  const firstStep = { ...cam.focus };
  cam.update(1 / 60);
  assert.ok(cam.focus.x > firstStep.x, 'focus must move towards the target');
  assert.ok(cam.focus.x < 1000, 'a single 60 Hz step must not teleport');
  for (let i = 0; i < 600; i++) cam.update(1 / 60);
  assert.ok(Math.abs(cam.focus.x - 1000) < 1, `focus stalled at ${cam.focus.x}`);
  assert.ok(Math.abs(cam.distance - 1200) < 1, `distance stalled at ${cam.distance}`);
});

test('camera snap jumps straight to the target', () => {
  const cam = new Camera();
  cam.focusOn({ x: -300, y: 0, z: 700 }, 2000);
  cam.snap();
  assert.equal(cam.focus.x, -300);
  assert.equal(cam.focus.z, 700);
  assert.equal(cam.distance, 2000);
});

test('camera pan moves along screen axes and respects yaw', () => {
  const cam = new Camera({ yaw: 0, distance: 1000 });
  const before = { ...cam.targetFocus };
  cam.pan(100, 0);
  assert.ok(cam.targetFocus.x > before.x, 'pan right must increase x at yaw 0');
  assert.ok(Math.abs(cam.targetFocus.z - before.z) < 1e-9, 'pan right must not move z at yaw 0');

  const cam2 = new Camera({ yaw: Math.PI / 2, distance: 1000 });
  const b2 = { ...cam2.targetFocus };
  cam2.pan(100, 0);
  assert.ok(Math.abs(cam2.targetFocus.x - b2.x) < 1e-6, 'at yaw 90 deg, right is along z');
  assert.ok(cam2.targetFocus.z > b2.z);
});

test('camera frame encloses every supplied point', () => {
  const cam = new Camera();
  const pts = [
    { x: -400, y: 0, z: -400 },
    { x: 400, y: 0, z: 400 },
    { x: 0, y: 120, z: 0 },
  ];
  cam.frame(pts, 1.6);
  cam.snap();
  const vp = cam.viewProj;
  for (const p of pts) {
    const ndc = mat4mulPoint(vp, p.x, p.y, p.z);
    assert.ok(ndc, 'framed point must be in front of the camera');
    assert.ok(Math.abs(ndc.x) <= 1.0, `x out of frame: ${ndc.x}`);
    assert.ok(Math.abs(ndc.y) <= 1.0, `y out of frame: ${ndc.y}`);
  }
});

test('camera frame is a no-op for an empty set', () => {
  const cam = new Camera();
  const before = cam.state();
  cam.frame([], 1.6);
  assert.deepEqual(cam.state(), before);
});

test('camera pickPlane maps the centre pixel onto the focus point', () => {
  const cam = new Camera({ focus: { x: 250, y: 0, z: -80 }, distance: 900, pitch: 0.8 });
  cam.snap();
  const hit = cam.pickPlane(0, 0, 0);
  assert.ok(hit, 'centre ray must hit the tactical plane');
  assert.ok(Math.abs(hit.x - 250) < 1.0, `x drifted: ${hit.x}`);
  assert.ok(Math.abs(hit.z + 80) < 1.0, `z drifted: ${hit.z}`);
});

test('camera pickPlane returns null when looking away from the plane', () => {
  const cam = new Camera({ pitch: -1.4, distance: 500 });
  cam.snap();
  // Eye is below the plane looking up, so a plane further below is behind the
  // ray and must be reported as a miss rather than a negative-t "hit".
  assert.ok(cam.eye.y < 0, 'setup: eye must be below the tactical plane');
  assert.equal(cam.pickPlane(0, 0, -5000), null);
});

test('camera state round-trips through restore', () => {
  const cam = new Camera({ distance: 700 });
  cam.orbit(0.9, -0.3);
  cam.focusOn({ x: 42, y: 0, z: -17 }, 1500);
  cam.snap();
  const saved = cam.state();

  const other = new Camera();
  other.restore(saved);
  assert.deepEqual(other.state(), saved);
});

test('camera restore ignores a null state', () => {
  const cam = new Camera();
  const before = cam.state();
  cam.restore(null);
  assert.deepEqual(cam.state(), before);
});

test('camera setAspect rejects non-positive values', () => {
  const cam = new Camera({ aspect: 1.5 });
  cam.setAspect(0);
  assert.equal(cam.aspect, 1.5);
  cam.setAspect(-2);
  assert.equal(cam.aspect, 1.5);
  cam.setAspect(2.0);
  assert.equal(cam.aspect, 2.0);
});

test('camera forward points from the eye towards the focus', () => {
  const cam = new Camera({ distance: 600, yaw: 1.1, pitch: 0.3 });
  const f = cam.forward();
  assert.ok(Math.abs(v3len(f) - 1) < 1e-6);
  const toFocus = v3sub(cam.focus, cam.eye);
  assert.ok(v3dot(f, toFocus) > 0);
});

test('camera caches the inverse and invalidates it on recompute', () => {
  const cam = new Camera();
  const inv1 = cam.inverseViewProj();
  assert.ok(inv1);
  assert.equal(cam._invValid, true);
  cam.orbit(0.4, 0);
  cam.recompute();
  assert.equal(cam._invValid, false);
  const inv2 = cam.inverseViewProj();
  assert.ok(inv2);
  assert.equal(cam._invValid, true);
});

test('ndcRadius shrinks with distance and blows up inside the sphere', () => {
  const cam = new Camera({ distance: 1000, pitch: 0, yaw: 0 });
  cam.snap();
  const near = ndcRadius(cam, cam.focus, 50);
  const cam2 = new Camera({ distance: 3000, pitch: 0, yaw: 0 });
  cam2.snap();
  const far = ndcRadius(cam2, cam2.focus, 50);
  assert.ok(near > far, `${near} should exceed ${far}`);
  assert.equal(ndcRadius(cam, cam.eye, 10), Infinity);
});

test('pixelToNdc maps corners and centre correctly', () => {
  assert.deepEqual(pixelToNdc(0, 0, 800, 600), { x: -1, y: 1 });
  assert.deepEqual(pixelToNdc(800, 600, 800, 600), { x: 1, y: -1 });
  assert.deepEqual(pixelToNdc(400, 300, 800, 600), { x: 0, y: 0 });
});

// -------------------------------------------------------------------- shaders

const ALL_SHADERS = [
  ['VS_HULL', VS_HULL], ['FS_HULL', FS_HULL],
  ['VS_STAR', VS_STAR], ['FS_STAR', FS_STAR],
  ['VS_LINE', VS_LINE], ['FS_LINE', FS_LINE],
  ['VS_SKY', VS_SKY], ['FS_SKY', FS_SKY],
];

test('every shader declares the GLSL ES 3.00 version on the first line', () => {
  for (const [name, src] of ALL_SHADERS) {
    assert.equal(src.split('\n')[0], '#version 300 es', `${name} version directive`);
  }
});

test('every shader declares a float precision and a main entry point', () => {
  for (const [name, src] of ALL_SHADERS) {
    assert.ok(/precision\s+(low|medium|high)p\s+float;/.test(src), `${name} precision`);
    assert.ok(/void\s+main\s*\(\s*\)/.test(src), `${name} main`);
  }
});

test('shader braces and parentheses are balanced', () => {
  for (const [name, src] of ALL_SHADERS) {
    let braces = 0, parens = 0;
    for (const ch of src) {
      if (ch === '{') braces++;
      else if (ch === '}') braces--;
      else if (ch === '(') parens++;
      else if (ch === ')') parens--;
      assert.ok(braces >= 0, `${name} closed a brace too early`);
      assert.ok(parens >= 0, `${name} closed a paren too early`);
    }
    assert.equal(braces, 0, `${name} unbalanced braces`);
    assert.equal(parens, 0, `${name} unbalanced parens`);
  }
});

// Strip `//` line comments so prose about "attributes" is not mistaken for
// GLSL ES 1.00 syntax. Block comments are not used in these shaders.
function stripComments(src) {
  return src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

test('no shader uses GLSL ES 1.00 leftovers', () => {
  for (const [name, raw] of ALL_SHADERS) {
    const src = stripComments(raw);
    assert.ok(!/\bvarying\b/.test(src), `${name} still uses varying`);
    assert.ok(!/\battribute\b/.test(src), `${name} still uses attribute`);
    assert.ok(!/\bgl_FragColor\b/.test(src), `${name} still uses gl_FragColor`);
    assert.ok(!/\btexture2D\s*\(/.test(src), `${name} still uses texture2D`);
  }
});

test('stripComments removes line comments but keeps code', () => {
  assert.equal(stripComments('in vec3 a; // attribute note'), 'in vec3 a; ');
  assert.equal(stripComments('// all gone'), '');
  assert.equal(stripComments('void main() {}'), 'void main() {}');
});

test('fragment shaders declare exactly one output', () => {
  for (const [name, src] of ALL_SHADERS) {
    if (!name.startsWith('FS_')) continue;
    const outs = src.match(/^\s*out\s+vec4\s+\w+;/gm) || [];
    assert.equal(outs.length, 1, `${name} should have one out vec4, found ${outs.length}`);
  }
});

test('hull vertex shader consumes the five instance attribute slots', () => {
  for (let loc = 2; loc <= 6; loc++) {
    assert.ok(
      VS_HULL.includes(`layout(location = ${loc}) in vec4`),
      `VS_HULL missing instance attribute at location ${loc}`,
    );
  }
});

test('vertex and fragment stage interfaces match for each program', () => {
  const pairs = [
    ['hull', VS_HULL, FS_HULL],
    ['star', VS_STAR, FS_STAR],
    ['line', VS_LINE, FS_LINE],
    ['sky', VS_SKY, FS_SKY],
  ];
  const collect = (src, keyword) => {
    const found = [];
    const re = new RegExp(`^\\s*${keyword}\\s+(\\w+)\\s+(\\w+);`, 'gm');
    let m;
    while ((m = re.exec(src)) !== null) found.push(`${m[1]} ${m[2]}`);
    return found;
  };
  for (const [name, vs, fs] of pairs) {
    const outs = collect(vs, 'out').filter((s) => !s.startsWith('vec4 o'));
    const ins = collect(fs, 'in');
    assert.deepEqual(ins, outs, `${name}: fragment inputs must match vertex outputs`);
  }
});

// ------------------------------------------------------------------ gl helpers

// Minimal stub. Only the calls the helpers actually make are implemented, so
// an unimplemented call throws rather than silently passing.
function stubGl(opts) {
  const o = opts || {};
  const calls = [];
  return {
    calls,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ACTIVE_UNIFORMS: 0x8b86,
    DEPTH_TEST: 0x0b71,
    CULL_FACE: 0x0b44,
    BLEND: 0x0be2,
    LEQUAL: 0x0203,
    BACK: 0x0405,
    CCW: 0x0901,
    createShader() { calls.push('createShader'); return { id: calls.length }; },
    shaderSource() { calls.push('shaderSource'); },
    compileShader() { calls.push('compileShader'); },
    getShaderParameter() { return !o.failCompile; },
    getShaderInfoLog() { return 'ERROR: 0:12 syntax error'; },
    deleteShader() { calls.push('deleteShader'); },
    createProgram() { calls.push('createProgram'); return { prog: true }; },
    attachShader() { calls.push('attachShader'); },
    linkProgram() { calls.push('linkProgram'); },
    getProgramParameter(_p, pname) {
      if (pname === 0x8b82) return !o.failLink;
      if (pname === 0x8b86) return (o.uniforms || []).length;
      return 0;
    },
    getProgramInfoLog() { return 'ERROR: link failed'; },
    deleteProgram() { calls.push('deleteProgram'); },
    getActiveUniform(_p, i) { return (o.uniforms || [])[i] || null; },
    getUniformLocation(_p, name) { return `loc:${name}`; },
    enable(c) { calls.push(`enable:${c}`); },
    disable(c) { calls.push(`disable:${c}`); },
    depthFunc() { calls.push('depthFunc'); },
    cullFace() { calls.push('cullFace'); },
    frontFace() { calls.push('frontFace'); },
    clearColor() { calls.push('clearColor'); },
  };
}

test('compileShader surfaces the driver log instead of swallowing it', () => {
  const gl = stubGl({ failCompile: true });
  assert.throws(
    () => compileShader(gl, gl.VERTEX_SHADER, 'bad', 'hull.vert'),
    /hull\.vert[\s\S]*syntax error/,
  );
  assert.ok(gl.calls.includes('deleteShader'), 'a failed shader must be deleted');
});

test('linkProgram deletes both stages after a successful link', () => {
  const gl = stubGl();
  const prog = linkProgram(gl, VS_LINE, FS_LINE, 'line');
  assert.ok(prog);
  const deletes = gl.calls.filter((c) => c === 'deleteShader').length;
  assert.equal(deletes, 2, 'both shader objects must be released');
});

test('linkProgram surfaces the link log and deletes the program', () => {
  const gl = stubGl({ failLink: true });
  assert.throws(() => linkProgram(gl, VS_LINE, FS_LINE, 'line'), /link failed/);
  assert.ok(gl.calls.includes('deleteProgram'));
});

test('uniformMap strips the array suffix and caches every location', () => {
  const gl = stubGl({
    uniforms: [
      { name: 'uViewProj' },
      { name: 'uLights[0]' },
      { name: 'uCameraPos' },
    ],
  });
  const map = uniformMap(gl, {});
  assert.deepEqual(Object.keys(map).sort(), ['uCameraPos', 'uLights', 'uViewProj']);
  assert.equal(map.uLights, 'loc:uLights');
});

test('setDefaultState enables depth and culling and disables blending', () => {
  const gl = stubGl();
  setDefaultState(gl);
  assert.ok(gl.calls.includes(`enable:${gl.DEPTH_TEST}`));
  assert.ok(gl.calls.includes(`enable:${gl.CULL_FACE}`));
  assert.ok(gl.calls.includes(`disable:${gl.BLEND}`));
  assert.ok(gl.calls.includes('frontFace'), 'winding must be stated explicitly');
});

test('instance layout constants agree with the hull shader', () => {
  // 4 x vec4 model + 1 x vec4 tint.
  assert.equal(INSTANCE_FLOATS, 20);
  assert.equal(GL_CONSTS.FLOAT_BYTES, 4);
});
