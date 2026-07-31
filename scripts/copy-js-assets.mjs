/**
 * copy-js-assets.mjs — copy hand-written .cjs runtime assets into a tsc output
 * tree (Sprint 83 T2).
 *
 * WHY THIS EXISTS. `src/problem_signature_core.cjs` is deliberately plain
 * CommonJS JavaScript, not TypeScript, so TermDeck's CJS server can require or
 * vendor it verbatim (ORCH ruling: one normalizer implementation, three
 * consumers, two module systems). tsc only emits from `.ts`, so it walks past
 * the file entirely — and `dist/src/problem_signature.js` would then import a
 * sibling that does not exist. That failure appears at RUNTIME, on the first
 * bug_fix write, not at build time.
 *
 * The copy preserves the path relative to the repo root, so the compiled
 * `import './problem_signature_core.cjs'` resolves to a real sibling in both
 * `dist/` and `dist-tests/` with the same specifier tsc left untouched.
 *
 * Usage:  node scripts/copy-js-assets.mjs <outDir>
 */

import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_DIRS = ['src'];
const EXTENSIONS = ['.cjs', '.d.cts'];

const outDir = process.argv[2];
if (!outDir) {
  console.error('[copy-js-assets] usage: node scripts/copy-js-assets.mjs <outDir>');
  process.exit(1);
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

let copied = 0;
for (const sourceDir of SOURCE_DIRS) {
  for (const file of walk(join(ROOT, sourceDir), [])) {
    const dest = join(ROOT, outDir, relative(ROOT, file));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file, dest);
    copied++;
  }
}

// Loud on zero: a silent no-op here means the runtime import above is about to
// break, and a build that "succeeded" is the worst place to learn that.
if (copied === 0) {
  console.error(`[copy-js-assets] no assets matched ${EXTENSIONS.join('/')} — expected at least one`);
  process.exit(1);
}
console.error(`[copy-js-assets] copied ${copied} asset(s) into ${outDir}/`);
