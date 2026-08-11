// Static validator. Checks invariants that unit tests cannot reach because
// they live *between* files: the import graph, the module-syntax subset the
// bundler supports, and the contract between GLSL attribute declarations and
// the JavaScript that fills those buffers.
//
// The attribute cross-check is here because a mismatch there is invisible to
// every test in this repo — it only surfaces as garbage geometry on a real GPU.
// One such bug (a star buffer supplying one float while the shader declared a
// vec3) was found by hand during development; this check exists so it cannot
// come back.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const problems = [];
let checked = 0;

function check(name, cond, detail) {
  checked += 1;
  if (!cond) problems.push(detail ? `${name}: ${detail}` : name);
}

function rel(p) {
  return relative(ROOT, p).split('\\').join('/');
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(resolve(ROOT, 'src'), []).sort();
const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

// ---------------------------------------------------------------- module form

const FORBIDDEN = [
  [/^\s*export\s+default\b/m, 'default export'],
  [/^\s*export\s*\{/m, 'export block or re-export'],
  [/^\s*export\s*\*/m, 'star re-export'],
  [/^\s*import\s+[A-Za-z_$][\w$]*\s+from\b/m, 'default import'],
  [/^\s*import\s*\*\s*as\b/m, 'namespace import'],
  [/\bimport\s*\(/, 'dynamic import'],
  [/\brequire\s*\(/, 'CommonJS require'],
];

for (const [file, src] of sources) {
  for (const [re, label] of FORBIDDEN) {
    check(`${rel(file)} avoids ${label}`, !re.test(src));
  }
  // Every import must be a single line the bundler's regex can consume.
  const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
  for (const line of importLines) {
    check(
      `${rel(file)} import is single-line and named`,
      /^\s*import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?\s*$/.test(line),
      line.trim(),
    );
  }
}

// -------------------------------------------------------------- import graph

const edges = new Map();
for (const [file, src] of sources) {
  const targets = [];
  const re = /^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[2];
    check(`${rel(file)} import "${spec}" is relative`, spec.startsWith('.'));
    check(`${rel(file)} import "${spec}" has a .js extension`, spec.endsWith('.js'));
    const target = resolve(dirname(file), spec);
    check(`${rel(file)} import "${spec}" resolves`, sources.has(target), 'no such module');
    if (sources.has(target)) {
      targets.push(target);
      // Every imported name must actually be exported by the target.
      const exported = new Set();
      const ex = /^\s*export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
      let e;
      while ((e = ex.exec(sources.get(target))) !== null) exported.add(e[1]);
      for (const raw of m[1].split(',')) {
        const name = raw.trim();
        if (!name) continue;
        check(`${rel(file)} imports ${name} which ${rel(target)} exports`, exported.has(name));
      }
    }
  }
  edges.set(file, targets);
}

// Cycle detection over the whole graph, not just from the entry point.
const colour = new Map();
const cycles = [];
function dfs(node, trail) {
  const c = colour.get(node);
  if (c === 'black') return;
  if (c === 'grey') {
    cycles.push([...trail.slice(trail.indexOf(node)), node].map(rel).join(' -> '));
    return;
  }
  colour.set(node, 'grey');
  for (const next of edges.get(node) || []) dfs(next, [...trail, node]);
  colour.set(node, 'black');
}
for (const file of files) dfs(file, []);
check('import graph is acyclic', cycles.length === 0, cycles.join('; '));

// Nothing may import the entry point; it is a leaf consumer.
const entry = resolve(ROOT, 'src/main.js');
for (const [file, targets] of edges) {
  check(`${rel(file)} does not import the entry point`, !targets.includes(entry) || file === entry);
}

// --------------------------------------------------- GLSL / buffer contract

const shaderSrc = sources.get(resolve(ROOT, 'src/gfx/shaders.js')) || '';
const rendererSrc = sources.get(resolve(ROOT, 'src/gfx/renderer.js')) || '';
const glSrc = sources.get(resolve(ROOT, 'src/gfx/gl.js')) || '';

const COMPONENTS = { float: 1, vec2: 2, vec3: 3, vec4: 4 };

// Split shaders.js into its individual exported template literals so an
// attribute can be attributed to the shader that declares it.
function shaderBlocks(src) {
  const out = new Map();
  const re = /export const ([A-Z0-9_]+)\s*=\s*`([\s\S]*?)`;/g;
  let m;
  while ((m = re.exec(src)) !== null) out.set(m[1], m[2]);
  return out;
}

const blocks = shaderBlocks(shaderSrc);
check('shaders.js exposes at least 6 shader stages', blocks.size >= 6, `found ${blocks.size}`);

for (const [name, body] of blocks) {
  check(`${name} declares #version 300 es`, /^\s*#version 300 es/.test(body));
  check(`${name} sets a float precision`, /precision\s+(highp|mediump|lowp)\s+float;/.test(body));
  if (name.startsWith('VS_')) {
    check(`${name} has a main entry point`, /void\s+main\s*\(/.test(body));
  }
}

// The declared contract. Each entry names a shader, the code that fills its
// buffers, and the exact attribute layout both sides must agree on.
const CONTRACTS = [
  {
    shader: 'VS_STAR',
    filler: { name: 'renderer.js initStars', src: rendererSrc },
    attribs: [
      { loc: 0, type: 'vec3', name: 'aPos' },
      { loc: 1, type: 'float', name: 'aBright' },
    ],
  },
  {
    shader: 'VS_LINE',
    filler: { name: 'renderer.js initLines', src: rendererSrc },
    attribs: [
      { loc: 0, type: 'vec3', name: 'aPos' },
      { loc: 1, type: 'vec4', name: 'aColour' },
    ],
  },
  {
    shader: 'VS_HULL',
    filler: { name: 'gl.js meshVao + instanceVao', src: glSrc },
    attribs: [
      { loc: 0, type: 'vec3', name: 'aPos' },
      { loc: 1, type: 'vec3', name: 'aNormal' },
      { loc: 2, type: 'vec4', name: 'aModel0' },
      { loc: 3, type: 'vec4', name: 'aModel1' },
      { loc: 4, type: 'vec4', name: 'aModel2' },
      { loc: 5, type: 'vec4', name: 'aModel3' },
      { loc: 6, type: 'vec4', name: 'aTint' },
    ],
  },
];

for (const contract of CONTRACTS) {
  const body = blocks.get(contract.shader);
  check(`${contract.shader} exists`, !!body);
  if (!body) continue;

  // What the shader actually declares, comments stripped so prose cannot match.
  const code = body.replace(/\/\/[^\n]*/g, '');
  const declared = new Map();
  const re = /layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*in\s+(\w+)\s+(\w+)\s*;/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    declared.set(Number(m[1]), { type: m[2], name: m[3] });
  }

  check(
    `${contract.shader} declares exactly ${contract.attribs.length} inputs`,
    declared.size === contract.attribs.length,
    `declared ${declared.size}`,
  );

  for (const want of contract.attribs) {
    const got = declared.get(want.loc);
    check(
      `${contract.shader} location ${want.loc} is ${want.type} ${want.name}`,
      got && got.type === want.type && got.name === want.name,
      got ? `found ${got.type} ${got.name}` : 'not declared',
    );
    // And the JS that fills it must request the same component count.
    const comps = COMPONENTS[want.type];
    const call = new RegExp(
      `vertexAttribPointer\\(\\s*(?:${want.loc}|loc)\\s*,\\s*${comps}\\s*,`,
    );
    check(
      `${contract.filler.name} supplies ${comps} components for location ${want.loc}`,
      call.test(contract.filler.src),
    );
  }
}

// Every attribute location any shader declares must be enabled somewhere.
const allLocs = new Set();
for (const [, body] of blocks) {
  const code = body.replace(/\/\/[^\n]*/g, '');
  const re = /layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*in\b/g;
  let m;
  while ((m = re.exec(code)) !== null) allLocs.add(Number(m[1]));
}
const enabled = `${rendererSrc}\n${glSrc}`;
for (const loc of [...allLocs].sort((a, b) => a - b)) {
  check(
    `attribute location ${loc} is enabled in JS`,
    new RegExp(`enableVertexAttribArray\\(\\s*(?:${loc}|loc)\\s*\\)`).test(enabled),
  );
}

// GLSL ES 1.00 keywords must not survive into 3.00 shaders (comments ignored).
for (const [name, body] of blocks) {
  const code = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const word of ['attribute', 'varying', 'texture2D', 'gl_FragColor']) {
    check(`${name} avoids GLSL ES 1.00 "${word}"`, !new RegExp(`\\b${word}\\b`).test(code));
  }
}

// ------------------------------------------------------------------- report

console.log(`validate: ${checked} checks over ${files.length} modules`);
if (problems.length) {
  for (const p of problems) console.error(`  FAIL ${p}`);
  console.error(`\n${problems.length} of ${checked} checks failed`);
  process.exit(1);
}
console.log(`all ${checked} checks passed`);
