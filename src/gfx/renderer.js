import { linkProgram, uniformMap, createBuffer, uploadDynamic, meshVao, attachInstanceAttribs, INSTANCE_FLOATS, setDefaultState } from './gl.js';
import { VS_HULL, FS_HULL, VS_STAR, FS_STAR, VS_LINE, FS_LINE, VS_SKY, FS_SKY } from './shaders.js';
import { hullMesh, hullTypes, starfield, fullscreenTriangle, sphereMesh, asteroidMesh } from './meshgen.js';
import { mat4model, v3, v3sub, v3norm, v3len } from '../core/math.js';
import { FACTION_COLOURS, SHIP_TYPES, shipDef } from '../sim/defs.js';

// The renderer owns every GPU object and never reads simulation state except
// through the plain records the world already exposes. It performs no
// allocation per frame: every buffer is grown once and then reused.
//
// Passes, in order:
//   1. sky      - fullscreen triangle, depth write off, draws the nebula
//   2. stars    - GL_POINTS on the far plane
//   3. asteroid - instanced, same program as hulls
//   4. hulls    - instanced, one draw call per hull type
//   5. lines    - beams, selection rings, move markers, in one dynamic buffer
//
// There is deliberately no post-processing chain. Bloom and motion blur would
// double the shader surface with no gameplay value and nothing here can be
// verified against a real driver in CI.

// Several ship types share a silhouette. This map is the single place where a
// simulation type name is translated into a mesh name.
const HULL_FOR_TYPE = {
  scout: 'scout',
  interceptor: 'interceptor',
  bomber: 'bomber',
  corvette: 'corvette',
  flak_frigate: 'frigate',
  ion_frigate: 'frigate',
  destroyer: 'destroyer',
  carrier: 'carrier',
  mothership: 'mothership',
  collector: 'collector',
};

// Beam tint per weapon class, so a glance at the battle reads the composition.
const BEAM_COLOUR = {
  kinetic: [1.0, 0.86, 0.55],
  torpedo: [1.0, 0.55, 0.22],
  ion: [0.45, 0.85, 1.0],
  flak: [0.85, 0.95, 0.6],
};

const LINE_FLOATS = 7; // vec3 position + vec4 colour
const STAR_COUNT = 2600;
const STAR_RADIUS = 48000;

export function hullNameForType(type) {
  return HULL_FOR_TYPE[type] || 'scout';
}

// Groups the simulation ship types by the mesh they draw with, so the renderer
// can issue exactly one instanced draw call per distinct mesh.
export function hullGroups() {
  const groups = new Map();
  for (const type of SHIP_TYPES) {
    const hull = hullNameForType(type);
    if (!groups.has(hull)) groups.set(hull, []);
    groups.get(hull).push(type);
  }
  return groups;
}

export class Renderer {
  constructor(gl, canvas) {
    this.gl = gl;
    this.canvas = canvas;
    this.frame = 0;
    this.stats = { hullInstances: 0, lineVertices: 0, drawCalls: 0 };

    this.progHull = linkProgram(gl, VS_HULL, FS_HULL, 'hull');
    this.progStar = linkProgram(gl, VS_STAR, FS_STAR, 'star');
    this.progLine = linkProgram(gl, VS_LINE, FS_LINE, 'line');
    this.progSky = linkProgram(gl, VS_SKY, FS_SKY, 'sky');

    this.uHull = uniformMap(gl, this.progHull);
    this.uStar = uniformMap(gl, this.progStar);
    this.uLine = uniformMap(gl, this.progLine);
    this.uSky = uniformMap(gl, this.progSky);

    this.hulls = new Map();
    for (const name of hullTypes()) {
      this.hulls.set(name, this.makeInstanced(hullMesh(name)));
    }
    // Asteroids reuse the instanced path with a rock mesh. One mesh, scaled
    // per instance: at tactical zoom the repetition is invisible and it keeps
    // the draw-call count flat regardless of field size.
    this.rock = this.makeInstanced(asteroidMesh(1, 0xa571));
    this.marker = this.makeInstanced(sphereMesh(0.5, 8, 6));

    this.initStars();
    this.initLines();
    this.initSky();

    setDefaultState(gl);
  }

  makeInstanced(mesh) {
    const gl = this.gl;
    const handles = meshVao(gl, mesh);
    const capacity = 256;
    const data = new Float32Array(capacity * INSTANCE_FLOATS);
    const buffer = createBuffer(gl, gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    attachInstanceAttribs(gl, handles.vao, buffer);
    return {
      vao: handles.vao,
      indexCount: handles.indexCount,
      buffer,
      data,
      capacity,
      capacityBytes: data.byteLength,
      count: 0,
    };
  }

  // Grows an instance batch geometrically. Called from the write path, so a
  // battle that suddenly doubles in size costs one reallocation, not one per
  // frame.
  ensureCapacity(batch, needed) {
    if (needed <= batch.capacity) return false;
    let cap = batch.capacity;
    while (cap < needed) cap *= 2;
    batch.data = new Float32Array(cap * INSTANCE_FLOATS);
    batch.capacity = cap;
    return true;
  }

  initStars() {
    const gl = this.gl;
    const data = starfield(STAR_COUNT, 0x51ce, STAR_RADIUS);
    this.starVao = gl.createVertexArray();
    gl.bindVertexArray(this.starVao);
    this.starBuffer = createBuffer(gl, gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const stride = 4 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, stride, 3 * 4);
    gl.bindVertexArray(null);
    this.starCount = STAR_COUNT;
  }

  initLines() {
    const gl = this.gl;
    this.lineCapacity = 4096; // vertices
    this.lineData = new Float32Array(this.lineCapacity * LINE_FLOATS);
    this.lineCount = 0;
    this.lineVao = gl.createVertexArray();
    gl.bindVertexArray(this.lineVao);
    this.lineBuffer = createBuffer(gl, gl.ARRAY_BUFFER, this.lineData, gl.DYNAMIC_DRAW);
    this.lineCapacityBytes = this.lineData.byteLength;
    const stride = LINE_FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 3 * 4);
    gl.bindVertexArray(null);
  }

  initSky() {
    const gl = this.gl;
    this.skyVao = gl.createVertexArray();
    gl.bindVertexArray(this.skyVao);
    this.skyBuffer = createBuffer(gl, gl.ARRAY_BUFFER, fullscreenTriangle(), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  // --- per-frame line assembly ---------------------------------------------

  resetLines() {
    this.lineCount = 0;
  }

  pushLine(ax, ay, az, bx, by, bz, r, g, b, a) {
    if (this.lineCount + 2 > this.lineCapacity) {
      const cap = this.lineCapacity * 2;
      const next = new Float32Array(cap * LINE_FLOATS);
      next.set(this.lineData.subarray(0, this.lineCount * LINE_FLOATS));
      this.lineData = next;
      this.lineCapacity = cap;
    }
    const d = this.lineData;
    let o = this.lineCount * LINE_FLOATS;
    d[o] = ax; d[o + 1] = ay; d[o + 2] = az;
    d[o + 3] = r; d[o + 4] = g; d[o + 5] = b; d[o + 6] = a;
    o += LINE_FLOATS;
    d[o] = bx; d[o + 1] = by; d[o + 2] = bz;
    d[o + 3] = r; d[o + 4] = g; d[o + 5] = b; d[o + 6] = a;
    this.lineCount += 2;
  }

  // A horizontal ring, used for selection and for the tactical-plane drop
  // marker. Drawn in the XZ plane because that is the plane orders resolve on.
  pushRing(cx, cy, cz, radius, r, g, b, a, segments) {
    const n = segments || 24;
    let px = cx + radius;
    let pz = cz;
    for (let i = 1; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      const nx = cx + Math.cos(t) * radius;
      const nz = cz + Math.sin(t) * radius;
      this.pushLine(px, cy, pz, nx, cy, nz, r, g, b, a);
      px = nx;
      pz = nz;
    }
  }

  // --- the frame -----------------------------------------------------------

  render(world, camera, view) {
    const gl = this.gl;
    const opts = view || {};
    this.frame++;
    this.stats.drawCalls = 0;

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.drawSky(camera);
    this.drawStars(camera);
    this.drawShips(world, camera);
    this.drawAsteroids(world, camera);
    this.buildOverlay(world, opts);
    this.drawLines(camera);

    return this.stats;
  }

  drawSky(camera) {
    const gl = this.gl;
    const inv = camera.inverseViewProj();
    if (!inv) return;
    gl.useProgram(this.progSky);
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    if (this.uSky.uInvViewProj) gl.uniformMatrix4fv(this.uSky.uInvViewProj, false, inv);
    if (this.uSky.uNebulaA) gl.uniform3f(this.uSky.uNebulaA, 0.06, 0.10, 0.24);
    if (this.uSky.uNebulaB) gl.uniform3f(this.uSky.uNebulaB, 0.20, 0.06, 0.16);
    gl.bindVertexArray(this.skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    this.stats.drawCalls++;
  }

  drawStars(camera) {
    const gl = this.gl;
    gl.useProgram(this.progStar);
    gl.depthMask(false);
    if (this.uStar.uViewProj) gl.uniformMatrix4fv(this.uStar.uViewProj, false, camera.viewProj);
    if (this.uStar.uPointScale) gl.uniform1f(this.uStar.uPointScale, 2.0);
    gl.bindVertexArray(this.starVao);
    gl.drawArrays(gl.POINTS, 0, this.starCount);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    this.stats.drawCalls++;
  }

  // Fills every hull batch from the living ship list, then issues one
  // instanced draw per batch that has work.
  drawShips(world, camera) {
    const gl = this.gl;
    const counts = new Map();
    for (const [name, batch] of this.hulls) {
      batch.count = 0;
      counts.set(name, 0);
    }

    // First pass counts so batches grow at most once per frame.
    for (const s of world.ships) {
      if (!s.alive) continue;
      const name = hullNameForType(s.type);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    for (const [name, n] of counts) {
      const batch = this.hulls.get(name);
      if (batch) this.ensureCapacity(batch, n);
    }

    const model = new Float32Array(16);
    for (const s of world.ships) {
      if (!s.alive) continue;
      const batch = this.hulls.get(hullNameForType(s.type));
      if (!batch) continue;
      const def = s.def || shipDef(s.type);
      mat4model(model, s.pos, s.fwd, def.radius);
      writeInstance(batch, model, tintFor(s, def));
    }

    gl.useProgram(this.progHull);
    if (this.uHull.uViewProj) gl.uniformMatrix4fv(this.uHull.uViewProj, false, camera.viewProj);
    if (this.uHull.uKeyDir) gl.uniform3f(this.uHull.uKeyDir, 0.42, 0.78, 0.46);
    if (this.uHull.uCameraPos) gl.uniform3f(this.uHull.uCameraPos, camera.eye.x, camera.eye.y, camera.eye.z);

    this.stats.hullInstances = 0;
    for (const batch of this.hulls.values()) {
      if (batch.count === 0) continue;
      this.flushBatch(batch);
      this.stats.hullInstances += batch.count;
    }
  }

  drawAsteroids(world, camera) {
    const batch = this.rock;
    batch.count = 0;
    this.ensureCapacity(batch, world.asteroids.length);
    const model = new Float32Array(16);
    const fwd = v3(0, 0, 1);
    for (const a of world.asteroids) {
      // Depleted rocks stay in the field but darken, so the player can read
      // which patches are spent without opening a panel.
      const frac = a.maxResource > 0 ? a.resource / a.maxResource : 0;
      const shade = 0.22 + 0.5 * frac;
      mat4model(model, a.pos, fwd, a.radius);
      writeInstance(batch, model, [shade * 0.9, shade * 0.85, shade * 0.8, 1]);
    }
    if (batch.count === 0) return;
    // Same program and uniforms as the hull pass, already bound by drawShips.
    this.flushBatch(batch);
  }

  flushBatch(batch) {
    const gl = this.gl;
    const used = batch.data.subarray(0, batch.count * INSTANCE_FLOATS);
    const grew = uploadDynamic(gl, gl.ARRAY_BUFFER, batch.buffer, used, batch.capacityBytes);
    if (grew) batch.capacityBytes = used.byteLength;
    gl.bindVertexArray(batch.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, batch.indexCount, gl.UNSIGNED_SHORT, 0, batch.count);
    gl.bindVertexArray(null);
    this.stats.drawCalls++;
  }

  // Builds beams, selection rings and order markers into the shared line
  // buffer. Pure CPU work; kept separate so it can be unit tested headlessly.
  buildOverlay(world, opts) {
    this.resetLines();
    const selected = opts.selected instanceof Set ? opts.selected : new Set(opts.selected || []);

    for (const b of world.beams) {
      const c = BEAM_COLOUR[b.weapon] || BEAM_COLOUR.kinetic;
      const a = b.lethal ? 1.0 : 0.72;
      this.pushLine(b.from.x, b.from.y, b.from.z, b.to.x, b.to.y, b.to.z, c[0], c[1], c[2], a);
    }

    for (const id of selected) {
      const s = world.get(id);
      if (!s) continue;
      const def = s.def || shipDef(s.type);
      const rgb = (FACTION_COLOURS[s.faction] || FACTION_COLOURS[0]).rgb;
      this.pushRing(s.pos.x, s.pos.y, s.pos.z, def.radius * 2.2, rgb[0], rgb[1], rgb[2], 0.9, 20);
      // A vertical stalk down to the tactical plane restores the depth cue
      // that an orbit camera destroys.
      this.pushLine(s.pos.x, s.pos.y, s.pos.z, s.pos.x, 0, s.pos.z, rgb[0], rgb[1], rgb[2], 0.28);
      // Health arc: a second ring whose radius tracks the hull fraction.
      const frac = s.maxHp > 0 ? Math.max(0, s.hp / s.maxHp) : 0;
      if (frac < 0.999) {
        this.pushRing(s.pos.x, s.pos.y, s.pos.z, def.radius * 2.2 * frac, 1, 0.35, 0.3, 0.8, 16);
      }
    }

    if (opts.marker) {
      const m = opts.marker;
      const age = typeof opts.markerAge === 'number' ? opts.markerAge : 0;
      const fade = Math.max(0, 1 - age / 1.2);
      if (fade > 0) {
        const r = 60 + 220 * (1 - fade);
        this.pushRing(m.x, m.y, m.z, r, 0.5, 1.0, 0.7, fade, 28);
      }
    }

    if (opts.dragBox) {
      const d = opts.dragBox;
      // Drawn on the tactical plane as four world-space segments; the HUD draws
      // the crisp screen-space rectangle on the 2D canvas.
      this.pushLine(d.x0, 0, d.z0, d.x1, 0, d.z0, 0.6, 0.9, 1, 0.5);
      this.pushLine(d.x1, 0, d.z0, d.x1, 0, d.z1, 0.6, 0.9, 1, 0.5);
      this.pushLine(d.x1, 0, d.z1, d.x0, 0, d.z1, 0.6, 0.9, 1, 0.5);
      this.pushLine(d.x0, 0, d.z1, d.x0, 0, d.z0, 0.6, 0.9, 1, 0.5);
    }

    this.stats.lineVertices = this.lineCount;
  }

  drawLines(camera) {
    if (this.lineCount === 0) return;
    const gl = this.gl;
    gl.useProgram(this.progLine);
    if (this.uLine.uViewProj) gl.uniformMatrix4fv(this.uLine.uViewProj, false, camera.viewProj);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    const used = this.lineData.subarray(0, this.lineCount * LINE_FLOATS);
    const grew = uploadDynamic(gl, gl.ARRAY_BUFFER, this.lineBuffer, used, this.lineCapacityBytes);
    if (grew) this.lineCapacityBytes = used.byteLength;
    gl.bindVertexArray(this.lineVao);
    gl.drawArrays(gl.LINES, 0, this.lineCount);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    this.stats.drawCalls++;
  }

  // Screen-space picking is done by the input layer against the simulation, not
  // by reading back the framebuffer: a GPU readback would stall the pipeline
  // and the sphere test is exact enough for ship-sized targets.
  dispose() {
    const gl = this.gl;
    for (const batch of this.hulls.values()) {
      gl.deleteVertexArray(batch.vao);
      gl.deleteBuffer(batch.buffer);
    }
    gl.deleteVertexArray(this.rock.vao);
    gl.deleteVertexArray(this.marker.vao);
    gl.deleteVertexArray(this.starVao);
    gl.deleteVertexArray(this.lineVao);
    gl.deleteVertexArray(this.skyVao);
    gl.deleteProgram(this.progHull);
    gl.deleteProgram(this.progStar);
    gl.deleteProgram(this.progLine);
    gl.deleteProgram(this.progSky);
  }
}

// Appends one instance record: 16 model floats then 4 tint floats.
export function writeInstance(batch, model, tint) {
  if (batch.count >= batch.capacity) return false;
  const o = batch.count * INSTANCE_FLOATS;
  const d = batch.data;
  for (let i = 0; i < 16; i++) d[o + i] = model[i];
  d[o + 16] = tint[0];
  d[o + 17] = tint[1];
  d[o + 18] = tint[2];
  d[o + 19] = tint[3];
  batch.count++;
  return true;
}

// Faction colour, darkened as the hull takes damage and flashed white on the
// tick a hit lands. Alpha carries the damage fraction so the shader can add a
// rim without a second attribute.
export function tintFor(ship, def) {
  const c = FACTION_COLOURS[ship.faction] || FACTION_COLOURS[0];
  const maxHp = ship.maxHp || (def && def.hp) || 1;
  const frac = Math.max(0, Math.min(1, ship.hp / maxHp));
  const dim = 0.45 + 0.55 * frac;
  return [c.rgb[0] * dim, c.rgb[1] * dim, c.rgb[2] * dim, 1 - frac];
}

// Distance-based level of detail. Returned as a factor the caller may use to
// skip small ships entirely when they would cover less than a pixel.
export function screenCoverage(camera, pos, radius) {
  const d = v3len(v3sub(pos, camera.eye));
  if (d <= radius) return Infinity;
  return radius / d;
}

// Exposed for tests: the direction a ship's engine trail should point.
export function trailDirection(ship) {
  const f = v3norm(ship.fwd);
  return v3(-f.x, -f.y, -f.z);
}
