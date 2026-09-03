# Contributing

## Local verification

Use Node.js 20 or newer. The repository intentionally declares no runtime or development package dependencies, so do not run an install step.

```bash
npm run verify
node tools/headless.mjs 1337 3 3000
```

`npm run verify` performs static validation, the Node test suite, the single-file build, and bundle checks. The headless command exposes the deterministic checksum used by CI.

## Change discipline

- Keep simulation randomness behind the seeded PRNG.
- Preserve the fixed-timestep model and the acyclic ES-module graph.
- If a source change affects the generated bundle, rebuild it locally for verification; `dist/` remains uncommitted.
- Never weaken a failing assertion or update the recorded checksum without explaining and reviewing the behavioral change.
- Do not commit generated dependency directories, credentials, tokens, browser profiles, or private data.

## Evidence boundaries

Passing CI proves the documented Node-based checks on the exact tested revision. It does not prove real-browser rendering, real-GPU shader compilation, accessibility, visual correctness, frame-rate performance, networking, persistence, or production readiness. Changes in those areas need purpose-built evidence.
