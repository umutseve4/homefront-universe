// Concatenating bundler. Produces dist/homefront.html: one self-contained file
// that runs from `file://` with no server, no npm install, no build step for
// the player.
//
// This is not a general-purpose bundler and does not pretend to be. It handles
// exactly the subset of ES modules this source tree uses, and it *fails loudly*
// on anything outside that subset rather than emitting a silently broken file.
// The constraints are enforced by tools/validate.mjs, so the two agree.
//
// Supported:
//   import { a, b } from './x.js';      (single line, named only)
//   export function f() {}
//   export const c = ...;
//   export class C {}
//
// Rejected:
//   default exports, namespace imports, re-exports, `export { ... }` blocks,
//   multi-line imports, dynamic import(), cyclic graphs.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');

const IMPORT_RE = /^\s*import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/;
const BAD_PATTERNS = [
  [/^\s*export\s+default\b/m, 'default export'],
  [/^\s*export\s*\{/m, 'export block / re-export'],
  [/^\s*export\s*\*/m, 'star re-export'],
  [/^\s*import\s+\w+\s+from\b/m, 'default import'],
  [/^\s*import\s*\*\s*as\b/m, 'namespace import'],
  [/\bimport\s*\(/, 'dynamic import'],
  [/^\s*import\s*\{[^}]*$/m, 'multi-line import'],
];

// Reads a module and splits it into its import edges and its body.
export function parseModule(source, id) {
  for (const [re, label] of BAD_PATTERNS) {
    if (re.test(source)) throw new Error(`${id}: unsupported syntax (${label})`);
  }
  const imports = [];
  const body = [];
  for (const line of source.split('\n')) {
    const m = IMPORT_RE.exec(line);
    if (m) {
      const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      imports.push({ spec: m[2], names });
      body.push(''); // keep line numbers stable for debugging
    } else {
      body.push(line);
    }
  }
  return { imports, body: body.join('\n') };
}

// Strips the `export ` keyword. Every module shares one scope in the bundle, so
// exported bindings simply become top-level bindings.
export function stripExports(body) {
  return body.replace(/^(\s*)export\s+(function|const|let|class|async)\b/gm, '$1$2');
}

// Collects every top-level binding a module exports, so duplicates across
// modules can be detected before they silently shadow each other.
export function exportedNames(source) {
  const names = [];
  const re = /^\s*export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(source)) !== null) names.push(m[1]);
  return names;
}

// Depth-first post-order walk. Throws on a cycle, naming the full path, because
// a cycle in a concatenating bundler produces a temporal-dead-zone crash at
// runtime that is far harder to diagnose than a build error.
export function orderModules(entry, read) {
  const order = [];
  const state = new Map(); // id -> 'visiting' | 'done'

  function visit(id, trail) {
    const s = state.get(id);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`import cycle: ${[...trail, id].join(' -> ')}`);
    state.set(id, 'visiting');
    const mod = parseModule(read(id), id);
    for (const imp of mod.imports) {
      const child = resolve(dirname(id), imp.spec);
      visit(child, [...trail, id]);
    }
    state.set(id, 'done');
    order.push(id);
  }

  visit(entry, []);
  return order;
}

export function escapeForScript(js) {
  // A literal `</script` inside a string would terminate the tag early.
  return js.replace(/<\/script/gi, '<\\/script');
}

export function buildBundle(entry, read) {
  const order = orderModules(entry, read);
  const seen = new Map();
  const chunks = [];

  for (const id of order) {
    const src = read(id);
    for (const name of exportedNames(src)) {
      if (seen.has(name)) {
        throw new Error(`duplicate export "${name}" in ${rel(id)} and ${rel(seen.get(name))}`);
      }
      seen.set(name, id);
    }
    const mod = parseModule(src, id);
    chunks.push(`// ===== ${rel(id)} =====\n${stripExports(mod.body).trim()}\n`);
  }

  return { order, code: chunks.join('\n'), exports: seen };
}

function rel(id) {
  const r = relative(ROOT, id);
  return r.split('\\').join('/');
}

export function htmlShell(js, meta) {
  const m = meta || {};
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HomeFront Universe</title>
<meta name="description" content="A deterministic real-time fleet-command simulation rendered with WebGL2.">
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #04060b; overflow: hidden;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #dce8ff; }
  #stage { position: fixed; inset: 0; }
  #stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  #scene { z-index: 0; }
  #hud { z-index: 1; touch-action: none; }
  #boot { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
    z-index: 2; font-size: 13px; opacity: 0.75; pointer-events: none; }
  #boot.gone { display: none; }
</style>
</head>
<body>
<div id="stage">
  <canvas id="scene"></canvas>
  <canvas id="hud"></canvas>
</div>
<div id="boot">HomeFront Universe — starting…</div>
<script>
// HomeFront Universe — generated bundle. Do not edit.
// Built ${m.date || 'unknown'} from ${m.modules || 0} modules, version ${m.version || '0.0.0'}.
// Source: https://github.com/umutseve4/homefront-universe
"use strict";
(function () {
${escapeForScript(js)}
})();
document.getElementById('boot').classList.add('gone');
</script>
</body>
</html>
`;
}

export function main() {
  const entry = resolve(ROOT, 'src/main.js');
  const read = (id) => readFileSync(id, 'utf8');
  let version = '0.0.0';
  try {
    version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version || version;
  } catch { /* package.json is optional for a bundle */ }

  const { order, code, exports } = buildBundle(entry, read);
  const html = htmlShell(code, {
    date: new Date().toISOString().slice(0, 10),
    modules: order.length,
    version,
  });

  mkdirSync(resolve(ROOT, 'dist'), { recursive: true });
  const out = resolve(ROOT, 'dist/homefront.html');
  writeFileSync(out, html, 'utf8');

  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log(`bundle: ${order.length} modules, ${exports.size} bindings, ${kb} KiB -> dist/homefront.html`);
  for (const id of order) console.log(`  ${rel(id)}`);
  return { modules: order.length, bytes: Buffer.byteLength(html, 'utf8') };
}

if (process.argv[1] && process.argv[1].endsWith('bundle.mjs')) main();
