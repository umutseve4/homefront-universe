// Verifies dist/homefront.html: extracts the inlined script, syntax-checks it
// with the real JS parser, and asserts the DOM contract main.js depends on.
// A bundler that emits a file is not a bundler that emits a *working* file.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(ROOT, 'dist/homefront.html');
const html = readFileSync(file, 'utf8');

const checks = [];
function ok(name, cond, detail) {
  checks.push({ name, cond: !!cond, detail: detail || '' });
}

const m = /<script>([\s\S]*?)<\/script>/.exec(html);
ok('html contains exactly one inline script', m && html.split('<script>').length === 2);
if (!m) {
  console.error('FATAL: no inline script found');
  process.exit(1);
}
const js = m[1];

// The DOM ids main.js queries. If the shell and the entry point disagree the
// game boots to a black screen, which no unit test would catch.
for (const id of ['scene', 'hud', 'boot', 'stage']) {
  ok(`shell declares #${id}`, new RegExp(`id="${id}"`).test(html));
}
ok('scene is a canvas', /<canvas id="scene">/.test(html));
ok('hud is a canvas', /<canvas id="hud">/.test(html));
ok('doctype is html5', /^<!doctype html>/i.test(html.trim()));
ok('charset declared', /<meta charset="utf-8">/i.test(html));

// No module syntax may survive into a classic <script>.
ok('no surviving import statement', !/^\s*import\s/m.test(js));
ok('no surviving export keyword', !/^\s*export\s/m.test(js));
ok('no unescaped closing script tag', !/<\/script/i.test(js));
ok('bundle is wrapped in an IIFE', /\(function \(\) \{/.test(js));
ok('strict mode enabled', /"use strict";/.test(js));

// The real test: does V8 parse it?
const tmp = resolve(ROOT, 'dist/.syntax-check.js');
let parsed = false;
let parseError = '';
try {
  writeFileSync(tmp, js, 'utf8');
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  parsed = true;
} catch (err) {
  parseError = String(err.stderr || err.message).split('\n').slice(0, 6).join('\n');
} finally {
  try { unlinkSync(tmp); } catch { /* already gone */ }
}
ok('inlined script parses under node --check', parsed, parseError);

// Entry point must be invoked, not merely defined.
ok('bundle calls start() on load', /startWhenReady|start\(document\)|start\(\s*document/.test(js) || /addEventListener\('DOMContentLoaded'/.test(js));

const failed = checks.filter((c) => !c.cond);
for (const c of checks) {
  console.log(`${c.cond ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `\n     ${c.detail.replace(/\n/g, '\n     ')}` : ''}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} bundle checks passed`);
if (failed.length) process.exit(1);
