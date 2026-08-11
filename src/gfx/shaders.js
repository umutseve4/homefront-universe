// GLSL ES 3.00 sources. These are plain strings here; they are only ever
// compiled by a real WebGL2 driver in the browser. Nothing in the Node test
// suite compiles them, so "the tests pass" does NOT mean "the shaders link".
// tools/validate.mjs does a static lint only (see docs/ARCHITECTURE.md).

export const VS_HULL = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
// Per-instance. Column-major model matrix split across four vec4 attributes.
layout(location = 2) in vec4 aModel0;
layout(location = 3) in vec4 aModel1;
layout(location = 4) in vec4 aModel2;
layout(location = 5) in vec4 aModel3;
layout(location = 6) in vec4 aTint;

uniform mat4 uViewProj;

out vec3 vNormal;
out vec3 vWorld;
out vec4 vTint;

void main() {
  mat4 model = mat4(aModel0, aModel1, aModel2, aModel3);
  vec4 world = model * vec4(aPos, 1.0);
  // Uniform scale only, so the upper 3x3 is a rotation times a scalar and the
  // inverse transpose reduces to a renormalise. No inverse() on the GPU.
  vNormal = normalize(mat3(model) * aNormal);
  vWorld = world.xyz;
  vTint = aTint;
  gl_Position = uViewProj * world;
}
`;

export const FS_HULL = `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vWorld;
in vec4 vTint;

uniform vec3 uKeyDir;
uniform vec3 uCameraPos;

out vec4 oColour;

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCameraPos - vWorld);
  vec3 l = normalize(uKeyDir);

  float key = max(dot(n, l), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.4, -0.7, 0.3))), 0.0) * 0.25;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.35;

  vec3 base = vTint.rgb;
  vec3 lit = base * (0.18 + key * 0.85 + fill) + vec3(0.55, 0.72, 1.0) * rim;

  // Specular from the key light only. Blinn-Phong, cheap.
  vec3 h = normalize(l + v);
  float spec = pow(max(dot(n, h), 0.0), 48.0) * 0.30;

  oColour = vec4(lit + vec3(spec), vTint.a);
}
`;

export const VS_STAR = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
// The starfield buffer is interleaved [x, y, z, brightness], so the second
// attribute is a single float, not a colour triple.
layout(location = 1) in float aBright;

uniform mat4 uViewProj;
uniform float uPointScale;

out vec3 vColour;

void main() {
  // Cheap stellar-class tint: dim stars lean red, bright ones lean blue.
  vec3 cool = vec3(0.72, 0.80, 1.00);
  vec3 warm = vec3(1.00, 0.86, 0.70);
  vColour = mix(warm, cool, aBright) * aBright;
  gl_Position = uViewProj * vec4(aPos, 1.0);
  // Stars sit on a huge shell; keep them on the far plane so nothing clips
  // them and no depth fighting is possible with real geometry.
  gl_Position.z = gl_Position.w;
  gl_PointSize = uPointScale * (0.6 + aBright);
}
`;

export const FS_STAR = `#version 300 es
precision highp float;

in vec3 vColour;
out vec4 oColour;

void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = dot(d, d);
  if (r > 0.25) discard;
  float fade = 1.0 - smoothstep(0.0, 0.25, r);
  oColour = vec4(vColour * fade, 1.0);
}
`;

export const VS_LINE = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aColour;

uniform mat4 uViewProj;

out vec4 vColour;

void main() {
  vColour = aColour;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const FS_LINE = `#version 300 es
precision highp float;

in vec4 vColour;
out vec4 oColour;

void main() {
  oColour = vColour;
}
`;

export const VS_SKY = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aClip;

uniform mat4 uInvViewProj;

out vec3 vRay;

void main() {
  vec4 near = uInvViewProj * vec4(aClip, -1.0, 1.0);
  vec4 far = uInvViewProj * vec4(aClip, 1.0, 1.0);
  vRay = far.xyz / far.w - near.xyz / near.w;
  gl_Position = vec4(aClip, 1.0, 1.0);
}
`;

export const FS_SKY = `#version 300 es
precision highp float;

in vec3 vRay;

uniform vec3 uNebulaA;
uniform vec3 uNebulaB;

out vec4 oColour;

// Value noise. Deterministic, no textures, no derivatives.
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * noise3(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

void main() {
  vec3 d = normalize(vRay);
  float n = fbm(d * 2.4);
  float m = fbm(d * 5.1 + vec3(11.3, 4.7, 2.9));
  float band = smoothstep(0.35, 0.85, n);
  vec3 col = mix(uNebulaA, uNebulaB, band) * (0.35 + 0.65 * m);
  col += vec3(0.02, 0.03, 0.06);
  oColour = vec4(col, 1.0);
}
`;
