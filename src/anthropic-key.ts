/**
 * Mnestra — ANTHROPIC_API_KEY resolution (Sprint 70 A-T3).
 *
 * TermDeck panels are being made key-free for billing safety: the server
 * now strips `ANTHROPIC_API_KEY` from the PTY environment it hands each
 * panel (`SECRETS_EXCLUDED_FROM_PTY`), so a subscription-billed CLI can
 * never silently fall back to per-token API billing. Mnestra's Haiku
 * paths (extraction, summarize, consolidation synthesis) inherit that
 * key-free env and would go permanently dark on `process.env` alone.
 *
 * So resolution is two-tier, in the same order the rest of the stack
 * uses: process env first (an explicitly exported key always wins), then
 * `~/.termdeck/secrets.env` — the stack's on-disk secret store, which
 * keeps the key even when the panel env doesn't.
 *
 * Fail-closed is the contract in both directions. A key that is present
 * resolves; a key that is *deliberately disabled* must NOT. TermDeck's
 * disable convention is to comment the line out in place —
 *
 *     # DISABLED-2026-08-05-billing : ANTHROPIC_API_KEY=sk-ant-...
 *
 * — and that line must resolve to '' , not to the key sitting after the
 * colon. Two independent defenses cover it: comment lines are skipped
 * before matching, and the match itself is anchored at line start.
 *
 * The line reader is a deliberate copy of the established
 * `resolveDatabaseUrl` pattern in `src/db-endpoint.ts` (quoted values
 * unwrapped, unexpanded `${VAR}` placeholders treated as unset, missing
 * or unreadable file → absent) rather than a shared extraction: A-T3's
 * lane fences it to key-resolution lines, and the two readers differing
 * later is a smaller hazard than restructuring a file another lane may be
 * reading this sprint. If a third consumer appears, fold all three into
 * one reader then.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { FsLike } from './doctor.js';

/** Strip ONE pair of matched surrounding quotes — parity with db-endpoint.ts. */
function stripSurroundingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }
  return value;
}

/** `${SOMETHING}` — an un-substituted template, i.e. effectively unset. */
function isUnexpandedPlaceholder(v: string): boolean {
  return v.startsWith('${') && v.endsWith('}');
}

const defaultFs: FsLike = {
  existsSync: (p) => existsSync(p),
  readFileSync: (p, enc) => readFileSync(p, enc),
};

export function defaultSecretsPath(): string {
  return join(homedir(), '.termdeck', 'secrets.env');
}

/** Memoized ambient result — populated only on the all-defaults path. */
let ambientCache: string | undefined;

/**
 * Resolve the Anthropic API key for Mnestra's Haiku calls.
 *
 * Returns the key, or '' when no usable key exists — callers treat ''
 * as "LLM features off" and degrade to their empty result rather than
 * throwing. Never throws: an unreadable secrets file is an absent key.
 *
 * Passing any argument explicitly bypasses the ambient memo and re-reads,
 * which is what keeps tests deterministic; the zero-arg call used by the
 * three consumers caches, since it can run per-item inside extraction
 * loops.
 */
export function resolveAnthropicKey(
  env?: Record<string, string | undefined>,
  fs?: FsLike,
  secretsPath?: string
): string {
  const ambient = env === undefined && fs === undefined && secretsPath === undefined;
  if (ambient && ambientCache !== undefined) return ambientCache;

  const key = readKey(env ?? process.env, fs ?? defaultFs, secretsPath ?? defaultSecretsPath());
  if (ambient) ambientCache = key;
  return key;
}

/** Drop the memo — for tests, and for any caller that rewrites secrets.env. */
export function resetAnthropicKeyCache(): void {
  ambientCache = undefined;
}

function readKey(
  env: Record<string, string | undefined>,
  fs: FsLike,
  secretsPath: string
): string {
  // Strip quotes BEFORE the placeholder check, matching the file branch below.
  // The other order is a real hole: `ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}"`
  // — a quoted, unsubstituted template, which is exactly what a shell exports
  // when a wrapper script forwards a variable that was never set — does not
  // start with '${' while the quotes are still on it, so it reads as a live
  // key and gets handed to the Anthropic SDK verbatim. The failure then
  // surfaces as a 401 from the API instead of the quiet secrets.env fallback
  // this module exists to provide.
  const fromEnv = stripSurroundingQuotes((env.ANTHROPIC_API_KEY ?? '').trim());
  if (fromEnv && !isUnexpandedPlaceholder(fromEnv)) return fromEnv;

  try {
    if (!fs.existsSync(secretsPath)) return '';
    for (const raw of fs.readFileSync(secretsPath, 'utf8').split('\n')) {
      const line = raw.trim();
      // Defense 1: a disabled/commented line is never a source of a key,
      // no matter what follows the '#'.
      if (!line || line.startsWith('#')) continue;
      // Defense 2: anchored at line start, so `... : ANTHROPIC_API_KEY=x`
      // cannot match even if defense 1 were ever relaxed.
      const match = line.match(/^(?:export\s+)?ANTHROPIC_API_KEY=(.*)$/);
      if (!match) continue;
      const value = stripSurroundingQuotes(match[1]!.trim());
      if (value && !isUnexpandedPlaceholder(value)) return value;
    }
  } catch {
    // Unreadable secrets file → treat as no key; callers degrade quietly.
  }
  return '';
}
