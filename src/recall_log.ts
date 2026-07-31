/**
 * Mnestra — recall-hit telemetry (Sprint 78 T3)
 *
 * Every recall surface (recall / search / index / timeline / graph / webhook)
 * fires a fire-and-forget write here AFTER it has built its returned set. The
 * point is to make "which memories actually get recalled, and which never do"
 * a measurable quantity so later pruning / elevation thresholds are
 * data-driven instead of guessed. Telemetry must start accumulating now;
 * nobody acts on `recall_count = 0` for ≥ 1 full sprint cycle (PLANNING §2
 * dec. 4, the pruning moratorium).
 *
 * THE CONTRACT — recall latency must be byte-for-byte unchanged:
 *
 *   1. NEVER awaited. The caller fires `logRecallHits(...)` and returns its
 *      result immediately; the RPC runs on a floating promise.
 *   2. NEVER throws into the caller. The whole body is wrapped in try/catch
 *      and the floating promise has a `.catch`, so a missing Supabase env, a
 *      dead RPC, or a malformed input can never surface on the recall path.
 *   3. RETURNED SET ONLY. Callers pass the hits they actually returned to the
 *      user (after dedup / rank / token-budget slicing) — not the 10–40
 *      over-fetched candidate rows. K returned hits → K log rows.
 *
 * TEST ISOLATION (deliberate): the client is resolved via `getSupabase()`
 * INTERNALLY, not handed in by the recall functions. In unit tests the recall
 * functions inject a fake Supabase client for their own RPCs; because the log
 * path uses `getSupabase()` (which throws when SUPABASE_URL is unset → caught
 * here → no-op), those fakes are never touched by a telemetry write and their
 * RPC-name / event-ordering assertions stay pristine. The optional `deps`
 * param exists only so recall_log's OWN unit tests can inject a fake.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'node:crypto';

import { getSupabase } from './db.js';
import type { RecallSurface } from './types.js';

export interface RecallLogHit {
  memory_id: string;
  score?: number | null;
  rank?: number | null;
  /**
   * Sprint 81 (migration 031): the recalled memory's source_type (per hit), so
   * the proof surface can show a recall's source_type mix from the log alone.
   * Optional/nullable — graph recall can't supply it (the memory_recall_graph
   * RPC doesn't return source_type), so it's omitted there → stored NULL.
   */
  source_type?: string | null;
}

export interface RecallLogContext {
  surface: RecallSurface;
  query: string;
  sourceSessionId?: string | null;
  sourceAgent?: string | null;
  /**
   * Sprint 81 (migration 031): the recall call's token budget (per call; the
   * same value on every one of this call's hit rows). Null for surfaces
   * without a token budget (search/index/timeline/graph). Powers the
   * cold-vs-warm "token-in" delta.
   */
  tokenBudget?: number | null;
  /**
   * Sprint 83 T2 (label producer): the caller's OWN group id for this recall.
   *
   * Migration 031 made a recall a discrete "reinjection event"; the id was
   * minted HERE, inside a fire-and-forget writer that returns void — so it
   * never escaped to the caller, and therefore never reached the agent, and
   * therefore nothing could ever cite a specific reinjection. That is the
   * structural reason the label channel has a producer on no dominant path.
   *
   * Callers that need to SURFACE the id (memoryRecall, memoryIndex,
   * memoryTimeline) now mint it themselves and pass it down. Omitted → minted
   * here exactly as before, so every other caller is byte-for-byte unchanged.
   */
  recallGroupId?: string | null;
}

export interface RecallLogDeps {
  /** Tests inject a fake client; production lets it default to getSupabase(). */
  client?: SupabaseClient;
}

const QUERY_PREVIEW_MAX = 120;

// Module-level counters so a diag / test can observe write health without the
// log path ever throwing. `attempted` increments when an RPC is dispatched;
// `failed` increments on getSupabase()-throw, RPC error, or rejection.
let attempted = 0;
let failed = 0;
const FAIL_LOG_EVERY = 25;

export function recallLogStats(): { attempted: number; failed: number } {
  return { attempted, failed };
}

/** Test helper — reset the health counters between cases. */
export function __resetRecallLogStats(): void {
  attempted = 0;
  failed = 0;
}

function noteFailure(message?: string): void {
  failed++;
  // Log at most ~1-in-FAIL_LOG_EVERY so a sustained outage can't spam stderr
  // on the hot path; the counters carry the real volume.
  if (failed % FAIL_LOG_EVERY === 1) {
    console.error(
      `[mnestra-recall-log] telemetry write failed (${failed} total): ${message ?? 'unknown error'}`
    );
  }
}

// ── query_preview redaction ────────────────────────────────────────────────
//
// Recall queries contain pasted secrets MORE often than memory content does
// (someone pastes an error containing a token and asks "have I seen this").
// We never store the raw query: mask common secret SHAPES with a small local
// regex set (no shell-out to the gitleaks binary on the hot path) and truncate
// to a short preview. Fail-soft: any error → empty preview, never the raw
// query.

const SECRET_SHAPES: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JWT (anon/service_role, GitHub, etc.)
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/g, // AWS temporary access key id
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI (incl. sk-proj-…)
  /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g, // Stripe
  /\bgh[pousr]_[0-9A-Za-z]{20,}\b/g, // GitHub PAT / OAuth / refresh / server
  /\bgithub_pat_[0-9A-Za-z_]{20,}\b/g, // GitHub fine-grained PAT
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, // Slack tokens
  /-----BEGIN[A-Z ]*PRIVATE KEY-----/g, // PEM private keys
  // Bearer tokens — masks the WHOLE "Bearer <token>" (and an "Authorization:"
  // prefix). Opaque (non-JWT) bearer tokens dodge the shape set above, and the
  // KEY=VALUE pass below only catches the keyword, leaking the token after it.
  /(?:authorization\s*:\s*)?bearer\s+\S+/gi,
];

// secret-ish `KEY=VALUE` / `KEY: VALUE` pairs — redact the VALUE, keep the key
// name so the preview still reads as "the query mentioned a token".
const SECRET_KV =
  /\b(?:secret|token|api[_-]?key|apikey|password|passwd|pwd|access[_-]?key|secret[_-]?key|bearer|authorization)\b\s*[:=]\s*\S+/gi;

// Supabase project-ref shape: exactly 20 lowercase letters. This is the
// backstop for the forbidden internal-identifier pair (global CLAUDE.md) — it
// catches the ref WITHOUT this source file ever embedding the literal. Real
// 20-letter all-lowercase words are vanishingly rare; over-redaction in a
// best-effort preview field is the safe direction.
const REF_SHAPE = /\b[a-z]{20}\b/g;

export function redactQueryPreview(query: unknown, maxLen = QUERY_PREVIEW_MAX): string {
  try {
    if (typeof query !== 'string' || query.length === 0) return '';
    let s = query;
    for (const re of SECRET_SHAPES) s = s.replace(re, '[REDACTED]');
    s = s.replace(SECRET_KV, (m) => {
      const key = m.split(/[:=]/, 1)[0] ?? '';
      return `${key.trimEnd()}=[REDACTED]`;
    });
    s = s.replace(REF_SHAPE, '[REDACTED]');
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + '…';
    return s;
  } catch {
    return '';
  }
}

/** Stable hash of the NORMALIZED query (case/whitespace-insensitive). */
export function hashQuery(query: unknown): string {
  try {
    if (typeof query !== 'string') return '';
    const norm = query.toLowerCase().replace(/\s+/g, ' ').trim();
    if (norm.length === 0) return '';
    return createHash('sha256').update(norm).digest('hex').slice(0, 32);
  } catch {
    return '';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the Supabase client for a telemetry write. An explicit deps.client
 * (recall_log's own unit tests) always wins. Otherwise fall through to the
 * production getSupabase() singleton — EXCEPT when MNESTRA_DISABLE_RECALL_LOG
 * is set, which the test harness uses so the suite never writes to a live
 * Supabase. This matters once migration 027 is applied: without the gate, a
 * credentialed `npm test` shell would INSERT fixture-derived junk into the real
 * memory_recall_log and bump recall_count on real rows — corrupting the very
 * signal Sprint 78 exists to make trustworthy. (Note the recall fns pass NO
 * client, so they hit this fallback; the comment in the module header about
 * getSupabase()-throw isolation only held when SUPABASE_URL was unset, which is
 * false in a credentialed shell — this flag makes the isolation structural.)
 * Disabling telemetry is fail-safe (no security/correctness impact), so this
 * purpose-built flag is NOT the ambient-infra-guard anti-pattern. getSupabase()
 * may still throw (no env) → caught by the callers' try/catch → no-op.
 */
function resolveClient(deps: RecallLogDeps): SupabaseClient | null {
  if (deps.client) return deps.client;
  if (process.env.MNESTRA_DISABLE_RECALL_LOG === '1') return null;
  return getSupabase();
}

/**
 * Sprint 81 (R2 — trusted-producer provenance): read a session/agent identity
 * from the environment. This is the UN-spoofable half of the G2 fix — the
 * webhook can thread caller provenance through its request args, but the
 * MCP-stdio recall tools expose no provenance args and boot prompts call plain
 * `memory_recall(project, query)`, so a self-reported arg would be blank or
 * forgeable. Instead, TermDeck exports MNESTRA_SESSION_ID (the panel's session
 * id) and MNESTRA_SOURCE_AGENT (claude/codex/…) into each spawned agent's env
 * at panel spawn; a panel cannot set another panel's id. Reading it HERE — the
 * single recall-log choke point — makes every recall surface
 * (recall/search/index/timeline/graph) carry non-null provenance, not just the
 * handlers a caller happened to wire. Per-call (not module-load) so it tracks
 * the live env and stays trivially testable; a `${VAR}` a launcher failed to
 * expand is treated as unset.
 */
function trustedEnv(name: string): string | null {
  const v = process.env[name];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length === 0 || (t.startsWith('${') && t.endsWith('}'))) return null;
  return t;
}

/**
 * Fire-and-forget: log the K returned hits for one recall. Builds the batched
 * payload and dispatches the `log_recall_hits(jsonb)` RPC (one statement-level
 * insert + one denorm-counter UPDATE server-side). Returns void synchronously;
 * the caller must NOT await it.
 */
export function logRecallHits(
  hits: RecallLogHit[],
  ctx: RecallLogContext,
  deps: RecallLogDeps = {}
): void {
  try {
    if (!Array.isArray(hits) || hits.length === 0) return;

    const queryHash = hashQuery(ctx.query);
    const queryPreview = redactQueryPreview(ctx.query);
    // Sprint 81: one uuid per recall CALL, shared across this call's K hit
    // rows — the identity of a single "reinjection event". One logRecallHits
    // call == one recall == one group, so generating it here (not per-hit) is
    // exactly the right granularity.
    //
    // Sprint 83 T2: prefer the caller's id when it supplied one (it needs to
    // hand the same id to the agent so a later memory_cite can name THIS
    // event). Validated, not trusted — a malformed value would silently
    // orphan the group from every row it was supposed to key.
    const recallGroupId =
      typeof ctx.recallGroupId === 'string' && UUID_RE.test(ctx.recallGroupId)
        ? ctx.recallGroupId
        : randomUUID();
    // Sprint 81 (R2): explicit ctx provenance (the webhook threads it from
    // request args) WINS; otherwise fall back to the trusted-producer env vars
    // TermDeck sets at panel spawn. Resolved once per call (per-call, not
    // per-hit — same identity on every row of this recall_group_id).
    const sessionId = ctx.sourceSessionId ?? trustedEnv('MNESTRA_SESSION_ID');
    const sourceAgent = ctx.sourceAgent ?? trustedEnv('MNESTRA_SOURCE_AGENT');

    const payload = hits
      .map((h, i) => ({
        memory_id: h?.memory_id,
        query_hash: queryHash,
        query_preview: queryPreview,
        score: h?.score ?? null,
        rank: h?.rank ?? i + 1,
        surface: ctx.surface,
        source_session_id: sessionId,
        source_agent: sourceAgent,
        source_type: h?.source_type ?? null,
        token_budget: ctx.tokenBudget ?? null,
        recall_group_id: recallGroupId,
      }))
      .filter(
        (p) => typeof p.memory_id === 'string' && UUID_RE.test(p.memory_id as string)
      );

    if (payload.length === 0) return;

    const client = resolveClient(deps);
    if (!client) return;
    attempted++;
    // `client.rpc(...)` is a thenable PostgrestBuilder, not a native Promise —
    // wrap so the .then/.catch are guaranteed and no unhandled rejection leaks.
    void Promise.resolve(client.rpc('log_recall_hits', { p_hits: payload }))
      .then((res: { error?: { message?: string } | null } | null) => {
        if (res && res.error) noteFailure(res.error.message);
      })
      .catch((err: unknown) => noteFailure((err as Error)?.message));
  } catch (err) {
    // getSupabase() throwing (no SUPABASE env) lands here → silent no-op.
    noteFailure((err as Error)?.message);
  }
}

/**
 * Fire-and-forget: record a recall-feedback signal on the MOST-RECENT log row
 * for each memory id. `event:'cited'` is the strongest "this was actually
 * used" signal (a memory_get / explicit citation); `event:'dismissed'` is the
 * negative signal. Batched: one `mark_recall_feedback(jsonb, text)` call for
 * the whole id set, one set-based UPDATE server-side. Never awaited.
 */
export function markRecallFeedback(
  memoryIds: string[],
  event: 'cited' | 'dismissed',
  deps: RecallLogDeps = {}
): void {
  try {
    const ids = (Array.isArray(memoryIds) ? memoryIds : []).filter(
      (id): id is string => typeof id === 'string' && UUID_RE.test(id)
    );
    if (ids.length === 0) return;
    if (event !== 'cited' && event !== 'dismissed') return;

    const client = resolveClient(deps);
    if (!client) return;
    attempted++;
    void Promise.resolve(
      client.rpc('mark_recall_feedback', { p_memory_ids: ids, p_event: event })
    )
      .then((res: { error?: { message?: string } | null } | null) => {
        if (res && res.error) noteFailure(res.error.message);
      })
      .catch((err: unknown) => noteFailure((err as Error)?.message));
  } catch (err) {
    noteFailure((err as Error)?.message);
  }
}

/** Convenience: mark a batch of ids cited (memory_get's "actually used" signal). */
export function markRecallCited(memoryIds: string[], deps: RecallLogDeps = {}): void {
  markRecallFeedback(memoryIds, 'cited', deps);
}

/** Convenience: single-id feedback for the webhook `op:'feedback'` receiver. */
export function recordRecallFeedback(
  memoryId: string,
  event: 'cited' | 'dismissed',
  deps: RecallLogDeps = {}
): void {
  markRecallFeedback([memoryId], event, deps);
}
