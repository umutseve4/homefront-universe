// Thin WebGL2 helpers. Every function takes the context explicitly, so this
// module imports cleanly under Node (no globals touched at module scope) and
// can be unit-tested with a stub context. Nothing here allocates on the
// per-frame path except where noted.

export const GL_CONSTS = {
  FLOAT_BYTES: 4,
  UINT16_BYTES: 2,
  UINT32_BYTES: 4,
};

// Compiles one stage and throws with the driver log on failure. The log is the
// only useful diagnostic a browser gives us, so never swallow it.
export function compileShader(gl, type, source, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed (${label || 'unnamed'}):\n${log}`);
  }
  return sh;
}

export function linkProgram(gl, vsSource, fsSource, label) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource, `${label}.vert`);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource, `${label}.frag`);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  // Shaders can be deleted immediately after a successful link; the program
  // holds its own reference.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`program link failed (${label || 'unnamed'}):\n${log}`);
  }
  return prog;
}

// Caches every active uniform location once. Looking a location up per frame
// is a synchronous driver call and shows up in profiles.
export function uniformMap(gl, prog) {
  const out = {};
  const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(prog, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, '');
    out[name] = gl.getUniformLocation(prog, name);
  }
  return out;
}

export function createBuffer(gl, target, data, usage) {
  const buf = gl.createBuffer();
  gl.bindBuffer(target, buf);
  gl.bufferData(target, data, usage);
  return buf;
}

// Uploads into an existing buffer without reallocating when the new data fits.
// Returns true when a full reallocation happened.
export function uploadDynamic(gl, target, buf, data, capacityBytes) {
  gl.bindBuffer(target, buf);
  const needed = data.byteLength;
  if (needed > capacityBytes) {
    gl.bufferData(target, data, gl.DYNAMIC_DRAW);
    return true;
  }
  gl.bufferSubData(target, 0, data);
  return false;
}

// Builds the VAO for a static mesh: position at 0, normal at 1.
export function meshVao(gl, mesh) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const pos = createBuffer(gl, gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

  const nrm = createBuffer(gl, gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

  const idx = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

  gl.bindVertexArray(null);
  return { vao, pos, nrm, idx, indexCount: mesh.indices.length };
}

// Attaches the per-instance stream to an existing mesh VAO. Layout is
// 4 x vec4 model matrix (locations 2..5) then vec4 tint (location 6),
// tightly packed, 20 floats per instance.
export const INSTANCE_FLOATS = 20;

export function attachInstanceAttribs(gl, vao, instanceBuffer) {
  const stride = INSTANCE_FLOATS * GL_CONSTS.FLOAT_BYTES;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  for (let i = 0; i < 5; i++) {
    const loc = 2 + i;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, stride, i * 4 * GL_CONSTS.FLOAT_BYTES);
    gl.vertexAttribDivisor(loc, 1);
  }
  gl.bindVertexArray(null);
}

export function resizeCanvas(gl, canvas, maxDpr) {
  const dpr = Math.min(maxDpr || 2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1));
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    return true;
  }
  return false;
}

// Sets the state this renderer assumes on every frame. Called once at init and
// again after any state-dirtying operation.
export function setDefaultState(gl) {
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.frontFace(gl.CCW);
  gl.disable(gl.BLEND);
  gl.clearColor(0.01, 0.012, 0.02, 1.0);
}
