/**
 * problem_signature core — Sprint 83 T2, interface I3.
 *
 * THE NORMALIZER CORE. Plain CommonJS, zero dependencies beyond `node:crypto`,
 * requireable AND importable. Everything that decides what a problem_signature
 * IS lives here; `src/problem_signature.ts` is a typed re-export shell over it.
 *
 * WHY THIS FILE IS .cjs AND DEPENDENCY-FREE (ORCH ruling, 2026-07-31):
 * three consumers must agree byte-for-byte on the hash, and they do not share
 * a module system —
 *
 *   1. mnestra (ESM TypeScript)      — write side, stamps the signature
 *   2. T3's recall-side expansion    — read side, matches on the hash
 *   3. TermDeck's server (CommonJS,  — flashback path; no TypeScript, no
 *      no build step, no mnestra dep)  build, and it does not depend on mnestra
 *
 * If any consumer re-implements the normalization, its hashes silently never
 * collide with the others'. The path stays warning-free and returns nothing
 * forever — a dead feature that looks alive, which is strictly worse than one
 * that errors. So: one file, no imports to resolve, vendorable by copy.
 *
 * DELIBERATE DUPLICATION: the secret-shape regexes below are a copy of the set
 * in `src/recall_log.ts`. Importing them would re-introduce exactly the
 * engram-internal dependency that makes this file un-vendorable, and a
 * redaction miss here leaks a secret into `metadata.problem_signature.symptom`
 * — a durable, recalled, exported field. The duplication is the cost of that
 * guarantee. `tests/problem-signature.test.ts` pins both copies against the
 * same vectors so a divergence fails a test rather than leaking quietly.
 *
 * CHANGING THE NORMALIZATION INVALIDATES EVERY STORED HASH. Bump
 * PROBLEM_SIGNATURE_VERSION, and expect old rows to stop matching new lookups
 * until they are re-signed.
 */

'use strict';

const { createHash } = require('node:crypto');

/** Bumped when normalization changes in a way that invalidates stored hashes. */
const PROBLEM_SIGNATURE_VERSION = 1;

/** Provenance stamp — `<producer>/<method>@<version>`. */
const PROBLEM_EXTRACTED_BY = 'write-time/regex@1';

/** Hard cap on the stored symptom: diagnostic enough to read, short enough to index. */
const SYMPTOM_MAX_CHARS = 200;

const SLUG_MAX_CHARS = 48;
const SLUG_MAX_TOKENS = 6;

/**
 * Seed problem classes — VENDORED from TermDeck `doctrine/registry.jsonl`
 * (the five `err-*` entries, `trigger: ["T-ERR"]`), pattern and flags verbatim.
 *
 * Vendored rather than read at runtime: mnestra ships as a standalone npm
 * package, so a TermDeck-relative path does not exist on a mnestra-only
 * install, and hydrating from the `source_type='doctrine'` rows would put a
 * network round-trip on a path whose whole justification is that it costs
 * microseconds and cannot fail. The cost is drift — the id list is pinned by
 * test so drift is loud in review rather than silent in production.
 */
const PROBLEM_CLASS_PATTERNS = [
  {
    id: 'err-git-push-rejected',
    re: /non-fast-forward|Updates were rejected|failed to push some refs/i,
  },
  {
    id: 'err-pg-permission-denied',
    re: /permission denied for (relation|table|function|schema|sequence)|code.?:.?.?42501|error: *42501/i,
  },
  {
    id: 'err-npm-publish-auth',
    re: /npm (error|ERR!).*(E403|ENEEDAUTH|EOTP|403 Forbidden|one-time)|this operation requires a one-time password/i,
  },
  {
    id: 'err-port-in-use',
    re: /EADDRINUSE|address already in use|listen EADDRINUSE/i,
  },
  {
    id: 'err-gitleaks-blocked',
    re: /gitleaks.*(leaks? found|finding)|secret detected|commit (blocked|rejected) by gitleaks|leaks found:/i,
  },
];

/** The closed half of the class vocabulary. `free:<slug>` is the open half. */
const PROBLEM_CLASSES = PROBLEM_CLASS_PATTERNS.map((p) => p.id);

// ── redaction (mirrors src/recall_log.ts — see the header note) ─────────────

const SECRET_SHAPES = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWT
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/g, // AWS temporary access key id
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI (incl. sk-proj-…)
  /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g, // Stripe
  /\bgh[pousr]_[0-9A-Za-z]{20,}\b/g, // GitHub PAT / OAuth / refresh / server
  /\bgithub_pat_[0-9A-Za-z_]{20,}\b/g, // GitHub fine-grained PAT
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, // Slack
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/g, // PEM private keys
  /(?:authorization\s*:\s*)?bearer\s+\S+/gi, // opaque bearer tokens
];

const SECRET_KV =
  /\b(?:secret|token|api[_-]?key|apikey|password|passwd|pwd|access[_-]?key|secret[_-]?key|bearer|authorization)\b\s*[:=]\s*\S+/gi;

/**
 * Supabase project-ref shape: exactly 20 lowercase letters. The backstop for
 * the forbidden internal-identifier pair (global CLAUDE.md) — it catches the
 * ref WITHOUT this file ever embedding the literal. Real 20-letter all-lowercase
 * words are vanishingly rare, and over-redaction in a diagnostic field is the
 * safe direction. Must run BEFORE lowercasing is irrelevant here (it only ever
 * matches lowercase), but it must run on text that has not yet been lowercased
 * so its semantics match recall_log's exactly.
 */
const REF_SHAPE = /\b[a-z]{20}\b/g;

/** Redact only — no whitespace collapsing, no truncation (the caller does those). */
function redactSecrets(text) {
  let s = String(text);
  for (const re of SECRET_SHAPES) s = s.replace(re, '[REDACTED]');
  s = s.replace(SECRET_KV, (m) => {
    const key = m.split(/[:=]/, 1)[0] || '';
    return `${key.trimEnd()}=[REDACTED]`;
  });
  s = s.replace(REF_SHAPE, '[REDACTED]');
  return s;
}

// ── normalization ───────────────────────────────────────────────────────────

/**
 * ANSI CSI + OSC. Written with \u001B escapes, never literal ESC bytes: a
 * control character in source survives neither a copy-paste nor most patch
 * tools, and this file exists to be copied.
 */
// eslint-disable-next-line no-control-regex -- ANSI CSI/OSC by construction
const ANSI_RE =
  /\u001B\[[0-9;?]*[ -\/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

/** Absolute POSIX/Windows paths and `file://` URLs → `<path>`. */
const PATH_RE =
  /(?:file:\/\/)?(?:[a-z]:)?(?:\/[\w.@+-]+){2,}\/?|(?:[a-z]:\\(?:[\w.@+-]+\\?)+)/gi;

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_RUN_RE = /\b(?:0x)?[0-9a-f]{7,}\b/gi;
const DIGIT_RUN_RE = /\b\d[\d.,:]*\b/g;

/** Lines that look like a failure even when no seed class matches. */
const ERROR_MARKER_RE =
  /\b(?:error|err!|failed|failure|cannot|can't|unable to|denied|refused|rejected|not found|missing|timed? ?out|exception|traceback|fatal|panic|EACCES|ENOENT|ECONN\w*|EADDR\w*|E\d{3}\b|exit code)\b/i;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'is', 'was', 'are', 'were', 'be', 'been', 'it', 'its', 'this',
  'that', 'from', 'by', 'as', 'has', 'have', 'had', 'not', 'no', 'you',
  'your', 'we', 'our', 'i', 'my', 'when', 'then', 'if', 'so', 'do', 'does',
]);

/**
 * Reduce a raw symptom to its stable core, so the SAME failure on two days in
 * two repos hashes identically.
 *
 * Order is load-bearing:
 *   1. strip ANSI   — a colorized and a plain copy of one error must agree
 *   2. redact       — BEFORE lowercasing: several shapes are case-sensitive
 *                     (`AKIA…`, `eyJ…`, `ghp_…`)
 *   3. lowercase
 *   4. paths → <path>; uuids / long hex / digit runs → <n> — the per-run noise
 *      (line numbers, ports, PIDs, tmp dirs, commit SHAs) that would otherwise
 *      make every single occurrence its own unique hash
 *   5. collapse whitespace, truncate
 *
 * Total: never throws, returns '' on anything unusable.
 */
function normalizeSymptom(raw, maxLen) {
  const cap = typeof maxLen === 'number' ? maxLen : SYMPTOM_MAX_CHARS;
  try {
    if (typeof raw !== 'string' || raw.length === 0) return '';
    let s = raw.replace(ANSI_RE, ' ');
    s = redactSecrets(s);
    s = s.toLowerCase();
    s = s.replace(PATH_RE, '<path>');
    s = s.replace(UUID_RE, '<n>');
    s = s.replace(HEX_RUN_RE, '<n>');
    s = s.replace(DIGIT_RUN_RE, '<n>');
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > cap) s = s.slice(0, cap).trimEnd();
    return s;
  } catch (_err) {
    return '';
  }
}

/** Stable 32-hex digest of an ALREADY-normalized symptom. */
function symptomHash(normalized) {
  return createHash('sha256').update(String(normalized), 'utf8').digest('hex').slice(0, 32);
}

/**
 * Classify text against the seed `err-*` vocabulary; null when nothing matches
 * (the caller falls back to `free:<slug>`). First match wins.
 */
function classifyProblem(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const entry of PROBLEM_CLASS_PATTERNS) {
    entry.re.lastIndex = 0; // defensive: no /g today, but a future pattern might
    if (entry.re.test(text)) return entry.id;
  }
  return null;
}

/** `free:<slug>` — the open half of the vocabulary, for unclassified failures. */
function freeClass(normalizedSymptom) {
  const tokens = String(normalizedSymptom)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && t !== 'path' && t !== 'redacted')
    .slice(0, SLUG_MAX_TOKENS);
  const slug = tokens.join('-').slice(0, SLUG_MAX_CHARS).replace(/-+$/, '');
  return `free:${slug || 'unclassified'}`;
}

/**
 * Pick the most symptom-like line out of a memory's content.
 *
 * A memory is prose ("KITCHEN — when a fail-soft writer starts emitting…"),
 * not a raw error dump, so hashing the whole body yields a signature that only
 * ever matches itself. Preference: a line that already classifies → a line
 * carrying an error marker → the first non-empty line.
 */
function pickSymptomLine(text) {
  if (typeof text !== 'string') return '';
  const lines = text
    .replace(ANSI_RE, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return '';
  for (const line of lines) {
    if (classifyProblem(line)) return line;
  }
  for (const line of lines) {
    if (ERROR_MARKER_RE.test(line)) return line;
  }
  return lines[0];
}

/**
 * Should this write carry a signature at all?
 *
 * `bug_fix` is the solved-problem source_type. `debugging` is ALSO a trigger
 * but is read off `category`, not `source_type` — per the Sprint 82 finding,
 * `debugging` and `convention` are Category values and are NOT legal
 * source_types. Keying only on source_type would silently miss every
 * `decision`-typed write about a bug, which is where many real fixes live.
 */
function shouldSignProblem(input) {
  if (!input) return false;
  return input.source_type === 'bug_fix' || input.category === 'debugging';
}

/**
 * Build the signature, or null when this write is not solved-problem-class or
 * carries nothing usable. Pure, synchronous, total — it never throws, because
 * its caller is a write path and a classification failure must never cost a
 * memory.
 */
function problemSignature(input, now) {
  try {
    if (!shouldSignProblem(input)) return null;

    const explicit =
      typeof input.symptom_text === 'string' && input.symptom_text.trim().length > 0
        ? input.symptom_text
        : null;
    const rawSymptom = explicit !== null ? explicit : pickSymptomLine(input.content || '');
    const symptom = normalizeSymptom(rawSymptom);
    if (!symptom) return null;

    // Classify the RAW line first — the patterns are written against raw error
    // text (`npm ERR!`, `42501`), and normalization deliberately destroys some
    // of what they match on (digit runs → <n>). Then the normalized form, then
    // the whole body for a pattern that straddles lines. Only then `free:`.
    const cls =
      classifyProblem(rawSymptom) ||
      classifyProblem(symptom) ||
      classifyProblem(input.content || '') ||
      freeClass(symptom);

    const stamp = now instanceof Date ? now : new Date();
    return {
      v: PROBLEM_SIGNATURE_VERSION,
      class: cls,
      symptom,
      symptom_hash: symptomHash(symptom),
      extracted_by: PROBLEM_EXTRACTED_BY,
      extracted_at: stamp.toISOString(),
    };
  } catch (_err) {
    return null;
  }
}

/**
 * Read side (T3 + TermDeck's flashback path): turn a live error line into the
 * same {class, symptom_hash} the write side stored, so expansion can
 * point-query `metadata->'problem_signature'->>'symptom_hash'` (exact
 * recurrence) and `->>'class'` (same failure class, different wording).
 */
function problemLookupKey(errorText) {
  try {
    const raw = pickSymptomLine(errorText || '');
    const symptom = normalizeSymptom(raw);
    if (!symptom) return null;
    const cls = classifyProblem(raw) || classifyProblem(symptom) || freeClass(symptom);
    return { class: cls, symptom, symptom_hash: symptomHash(symptom) };
  } catch (_err) {
    return null;
  }
}

// Individual `exports.X =` assignments (not a single `module.exports = {...}`)
// so cjs-module-lexer can statically detect the named exports — that is what
// lets `import { normalizeSymptom } from './problem_signature_core.cjs'` work
// from ESM instead of forcing default-import-then-destructure.
exports.PROBLEM_SIGNATURE_VERSION = PROBLEM_SIGNATURE_VERSION;
exports.PROBLEM_EXTRACTED_BY = PROBLEM_EXTRACTED_BY;
exports.SYMPTOM_MAX_CHARS = SYMPTOM_MAX_CHARS;
exports.PROBLEM_CLASSES = PROBLEM_CLASSES;
exports.redactSecrets = redactSecrets;
exports.normalizeSymptom = normalizeSymptom;
exports.symptomHash = symptomHash;
exports.classifyProblem = classifyProblem;
exports.freeClass = freeClass;
exports.pickSymptomLine = pickSymptomLine;
exports.shouldSignProblem = shouldSignProblem;
exports.problemSignature = problemSignature;
exports.problemLookupKey = problemLookupKey;
