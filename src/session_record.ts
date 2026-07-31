/**
 * Mnestra — memory_session_record (Sprint 84 T2)
 *
 * End-of-conversation capture for WEB surfaces. A CLI panel that closes gets a
 * `memory_sessions` row from the bundled SessionEnd hook, and the Rumen tick
 * sweeps unprocessed rows into synthesized insights. A web chat has no panel
 * and no hook, so its conversations never entered that loop. This module is
 * the web equivalent: it calls the validating SECURITY DEFINER RPC
 * public.memory_session_record() (migrations/035_memory_session_record.sql),
 * which is the ONLY web-reachable insert path into public.memory_sessions.
 *
 * WHY THIS IS NOT A HOLE IN THE QUARANTINE DOCTRINE. "CLIs write canonical;
 * web chats write proposals" (migration 026) governs `memory_items`, which
 * recall reads directly. `memory_sessions` is read by no recall path — it is
 * the Rumen tick's input queue, and that tick's extract → relate → synthesize
 * pass is itself a gate. Nothing recorded here becomes recallable without
 * passing through it. What a session record DOES buy a caller is influence
 * over synthesis inputs, which is why validation here is as strict as
 * memory_propose's and why the RPC mints `session_id` server-side.
 *
 * Validation happens twice, on purpose — same layering as src/propose.ts:
 *   - HERE (TS mirror): fail fast with a clean client error before a DB
 *     round-trip, and slightly stricter in ways SQL cannot express (runtime
 *     type checks on a JSON payload; JS string length counts UTF-16 code
 *     units, so astral-heavy text may be rejected here that SQL — counting
 *     characters — would accept: the conservative direction).
 *   - IN SQL (authoritative): the RPC re-validates everything. Both layers
 *     share the MEMORY_SESSION_RECORD_REJECTED prefix so callers see one
 *     error shape regardless of which rejected.
 *
 * DELIBERATE NON-CHANGE: the stdio MCP server registers NO session-record
 * tool. Local MCP callers are the CLI trust domain and already have the
 * SessionEnd hook. The webhook `session_record` op exists for the MCP bridge
 * only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabase } from './db.js';
import { WEB_SOURCE_AGENTS } from './types.js';
import type { SessionRecordInput, SessionRecordResult } from './types.js';

/** Deps seam cloned from ProposeDeps — the client is the only injectable. */
export interface SessionRecordDeps {
  /** Override the Supabase client (tests inject a fake). */
  client?: SupabaseClient;
}

/**
 * Binding caps — the SQL RPC enforces the same numbers (authoritative); the
 * bridge tool mirrors them at its own boundary.
 * tests/migration-035-hygiene.test.ts pins TS <-> SQL lockstep.
 */
export const SESSION_SUMMARY_MAX_CHARS = 8000;
export const SESSION_CONVERSATION_KEY_MAX_CHARS = 200;
export const SESSION_PROJECT_MAX_CHARS = 128;
/**
 * SQL measures pg_column_size(jsonb) (authoritative); these mirrors measure
 * serialized UTF-8 bytes — close but not identical encodings. Same numbers on
 * both sides; near-the-line payloads may pass here and still be rejected by
 * the RPC, which is the intended layering.
 */
export const SESSION_TOPICS_MAX_BYTES = 4096;
export const SESSION_METADATA_MAX_BYTES = 8192;

/**
 * The conversation key is the only caller-controlled component of the minted
 * `session_id`, so it is charset-bounded — not for injection reasons (the
 * insert is parameterized) but so a session_id stays a legible, greppable
 * operator-facing key.
 */
export const SESSION_CONVERSATION_KEY_RE = /^[A-Za-z0-9._:@-]+$/;

/** Stable, machine-matchable prefix shared with the SQL RPC's raise. */
export const SESSION_RECORD_REJECTED_PREFIX = 'MEMORY_SESSION_RECORD_REJECTED';

/**
 * A session record that failed validation — in the TS mirror or in the SQL
 * RPC. The webhook layer maps this (and only this) to HTTP 400; everything
 * else stays a 500.
 */
export class SessionRecordRejectedError extends Error {
  /** Stable reason code, e.g. 'invalid_source_agent', 'session_locked'. */
  readonly reason: string;

  constructor(reason: string, detail?: string) {
    super(`${SESSION_RECORD_REJECTED_PREFIX}: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'SessionRecordRejectedError';
    this.reason = reason;
  }
}

export function isSessionRecordRejected(err: unknown): boolean {
  if (err instanceof SessionRecordRejectedError) return true;
  return err instanceof Error && err.message.startsWith(SESSION_RECORD_REJECTED_PREFIX);
}

/**
 * The session_id the RPC will mint. Duplicated here (rather than read back
 * from the DB) so the caller can report the key without a second round-trip.
 * The formula is pinned against the SQL by
 * tests/migration-035-hygiene.test.ts — if one side changes, that test fails.
 */
export function webSessionId(sourceAgent: string, conversationKey: string): string {
  return `web:${sourceAgent}:${conversationKey}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts a Date or an ISO string; returns an ISO string or null. */
function toIso(v: unknown, field: string): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new SessionRecordRejectedError(`invalid_${field}`);
    return v.toISOString();
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new SessionRecordRejectedError(`invalid_${field}`, 'not a parseable timestamp');
    return new Date(t).toISOString();
  }
  throw new SessionRecordRejectedError(`invalid_${field}`, 'must be a Date or an ISO-8601 string');
}

export async function memorySessionRecord(
  input: SessionRecordInput,
  deps: SessionRecordDeps = {}
): Promise<SessionRecordResult> {
  // ── TS mirror validation — everything below runs BEFORE any client is
  // created, so a rejected record costs zero DB round-trips (and the
  // rejection paths work without Supabase env at all).

  const agent =
    typeof input.source_agent === 'string' ? input.source_agent.trim().toLowerCase() : '';
  if (!(WEB_SOURCE_AGENTS as readonly string[]).includes(agent)) {
    throw new SessionRecordRejectedError(
      'invalid_source_agent',
      `must be ${WEB_SOURCE_AGENTS.join('|')}; got ${JSON.stringify(
        String(input.source_agent ?? '<null>').slice(0, 80)
      )}`
    );
  }

  const key =
    typeof input.conversation_key === 'string' ? input.conversation_key.trim() : '';
  if (!key) {
    throw new SessionRecordRejectedError('empty_conversation_key');
  }
  if (key.length > SESSION_CONVERSATION_KEY_MAX_CHARS) {
    throw new SessionRecordRejectedError(
      'conversation_key_too_long',
      `${key.length} chars; max ${SESSION_CONVERSATION_KEY_MAX_CHARS}`
    );
  }
  if (!SESSION_CONVERSATION_KEY_RE.test(key)) {
    throw new SessionRecordRejectedError(
      'invalid_conversation_key',
      'allowed: A-Z a-z 0-9 . _ - : @'
    );
  }

  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
  if (!summary) {
    throw new SessionRecordRejectedError('empty_summary');
  }
  if (summary.length > SESSION_SUMMARY_MAX_CHARS) {
    throw new SessionRecordRejectedError(
      'summary_too_long',
      `${summary.length} chars; max ${SESSION_SUMMARY_MAX_CHARS}`
    );
  }

  let project: string | null = null;
  if (input.project != null) {
    if (typeof input.project !== 'string') {
      // TS-only strictness (the SQL parameter is typed text and can't see
      // this): a non-string project is caller error, not coercible data.
      throw new SessionRecordRejectedError('project_not_text');
    }
    project = input.project.trim() || null;
    if (project && project.length > SESSION_PROJECT_MAX_CHARS) {
      throw new SessionRecordRejectedError(
        'project_too_long',
        `${project.length} chars; max ${SESSION_PROJECT_MAX_CHARS}`
      );
    }
  }

  let messagesCount: number | null = null;
  if (input.messages_count != null) {
    if (typeof input.messages_count !== 'number' || !Number.isFinite(input.messages_count)) {
      throw new SessionRecordRejectedError('messages_count_not_number');
    }
    messagesCount = Math.trunc(input.messages_count);
    if (messagesCount < 0) {
      throw new SessionRecordRejectedError('negative_messages_count', `got ${messagesCount}`);
    }
  }

  const startedAt = toIso(input.started_at, 'started_at');
  const endedAt = toIso(input.ended_at, 'ended_at');
  if (startedAt && endedAt && Date.parse(startedAt) > Date.parse(endedAt)) {
    throw new SessionRecordRejectedError(
      'started_after_ended',
      `started_at ${startedAt} is after ended_at ${endedAt}`
    );
  }

  const topics = input.topics ?? [];
  if (!Array.isArray(topics)) {
    throw new SessionRecordRejectedError('topics_not_array');
  }
  let topicsSerialized: string;
  try {
    topicsSerialized = JSON.stringify(topics);
  } catch {
    throw new SessionRecordRejectedError('topics_not_serializable');
  }
  if (Buffer.byteLength(topicsSerialized, 'utf8') > SESSION_TOPICS_MAX_BYTES) {
    throw new SessionRecordRejectedError(
      'topics_too_large',
      `${Buffer.byteLength(topicsSerialized, 'utf8')} bytes; max ${SESSION_TOPICS_MAX_BYTES}`
    );
  }

  const metadata = input.metadata ?? {};
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new SessionRecordRejectedError('metadata_not_object');
  }
  let metaSerialized: string;
  try {
    metaSerialized = JSON.stringify(metadata);
  } catch {
    throw new SessionRecordRejectedError('metadata_not_serializable');
  }
  if (Buffer.byteLength(metaSerialized, 'utf8') > SESSION_METADATA_MAX_BYTES) {
    throw new SessionRecordRejectedError(
      'metadata_too_large',
      `${Buffer.byteLength(metaSerialized, 'utf8')} bytes; max ${SESSION_METADATA_MAX_BYTES}`
    );
  }

  // ── Authoritative gate: the SECURITY DEFINER RPC.
  const supabase = deps.client ?? getSupabase();
  const { data, error } = await supabase.rpc('memory_session_record', {
    p_source_agent: agent,
    p_conversation_key: key,
    p_summary: summary,
    p_project: project,
    p_messages_count: messagesCount,
    p_started_at: startedAt,
    p_ended_at: endedAt,
    p_topics: topics,
    p_metadata: metadata,
  });

  if (error) {
    if (error.message && error.message.includes(SESSION_RECORD_REJECTED_PREFIX)) {
      const tail = error.message.slice(
        error.message.indexOf(SESSION_RECORD_REJECTED_PREFIX) +
          SESSION_RECORD_REJECTED_PREFIX.length
      );
      const reason = (tail.match(/[a-z_]+/) ?? ['rejected'])[0];
      // The SQL detail already arrives parenthesized; the error constructor
      // adds its own pair. Unwrap so the connector sees `reason (detail)`
      // rather than `reason ((detail))`.
      const detail = tail
        .replace(/^:?\s*[a-z_]+\s*/, '')
        .replace(/^\((.*)\)$/s, '$1')
        .trim();
      throw new SessionRecordRejectedError(reason, detail || undefined);
    }
    throw new Error(`memory_session_record rpc failed: ${error.message}`);
  }

  const id = typeof data === 'string' ? data : null;
  if (!id || !UUID_RE.test(id)) {
    throw new Error(
      `memory_session_record rpc returned no row id (got ${JSON.stringify(data).slice(0, 80)})`
    );
  }
  return { id, session_id: webSessionId(agent, key) };
}
