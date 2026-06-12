/**
 * Mnestra — memory_propose (Sprint 76 T1)
 *
 * Quarantined write path for web-chat surfaces: "CLIs write canonical; web
 * chats write proposals." memoryPropose() calls the validating SECURITY
 * DEFINER RPC public.memory_propose() (migrations/026_memory_inbox.sql),
 * which is the ONLY insert path into public.memory_inbox. Pending inbox
 * rows are invisible to every recall path; the Rumen promotion pass
 * (Sprint 76 T3) later promotes or rejects them.
 *
 * Validation happens twice, on purpose:
 *   - HERE (TS mirror): fail fast with a clean client error before a DB
 *     round-trip. Slightly stricter than SQL in ways SQL cannot express
 *     (runtime type checks on a JSON payload; JS string length counts
 *     UTF-16 code units, so astral-plane-heavy text may be rejected here
 *     that SQL — counting characters — would accept: the conservative
 *     direction).
 *   - IN SQL (authoritative): the RPC re-validates everything; this module
 *     merely pre-empts it. The two share the MEMORY_PROPOSE_REJECTED
 *     message prefix so callers see one error shape regardless of which
 *     layer rejected.
 *
 * DELIBERATE NON-CHANGE: the stdio MCP server registers NO memory_propose
 * tool — local MCP callers are CLI trust domain and use memory_remember.
 * The webhook `propose` op (src/webhook-server.ts) exists for the MCP
 * bridge (Sprint 76 T2) only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabase } from './db.js';
import { WEB_SOURCE_AGENTS } from './types.js';
import type { ProposeInput, ProposeResult } from './types.js';

/**
 * Deps seam cloned from RememberDeps (remember.ts) minus the embedding
 * override — proposals are NOT embedded at propose time (the promotion
 * pass embeds the vetted text later), so the only injectable is the
 * client.
 */
export interface ProposeDeps {
  /** Override the Supabase client (tests inject a fake). */
  client?: SupabaseClient;
}

/**
 * Binding caps — the SQL RPC enforces the same numbers (authoritative);
 * the T2 bridge ingress and T3 promotion gates mirror them.
 * tests/migration-026-hygiene.test.ts pins TS <-> SQL lockstep.
 */
export const PROPOSE_TEXT_MAX_CHARS = 4000;
export const PROPOSE_PROJECT_HINT_MAX_CHARS = 128;
/**
 * SQL measures pg_column_size(jsonb) (authoritative); this mirror measures
 * serialized UTF-8 bytes — close but not identical encodings. Same
 * number on both sides; near-the-line payloads may pass here and still be
 * rejected by the RPC, which is the intended layering.
 */
export const PROPOSE_METADATA_MAX_BYTES = 8192;

/** Stable, machine-matchable prefix shared with the SQL RPC's raise. */
export const PROPOSE_REJECTED_PREFIX = 'MEMORY_PROPOSE_REJECTED';

/**
 * A proposal that failed validation — in the TS mirror or in the SQL RPC.
 * The webhook layer maps this (and only this) to HTTP 400; everything else
 * stays a 500. `message` always starts with MEMORY_PROPOSE_REJECTED.
 */
export class ProposeRejectedError extends Error {
  /** Stable reason code, e.g. 'invalid_source_agent', 'text_too_long'. */
  readonly reason: string;

  constructor(reason: string, detail?: string) {
    super(`${PROPOSE_REJECTED_PREFIX}: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'ProposeRejectedError';
    this.reason = reason;
  }
}

export function isProposeRejected(err: unknown): boolean {
  if (err instanceof ProposeRejectedError) return true;
  // Injected deps / RPC-originated errors keep the contract via the prefix.
  return err instanceof Error && err.message.startsWith(PROPOSE_REJECTED_PREFIX);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function memoryPropose(
  input: ProposeInput,
  deps: ProposeDeps = {}
): Promise<ProposeResult> {
  // ── TS mirror validation — everything below runs BEFORE any client is
  // created, so a rejected proposal costs zero DB round-trips (and the
  // rejection paths work without Supabase env at all).

  const agent =
    typeof input.source_agent === 'string'
      ? input.source_agent.trim().toLowerCase()
      : '';
  if (!(WEB_SOURCE_AGENTS as readonly string[]).includes(agent)) {
    throw new ProposeRejectedError(
      'invalid_source_agent',
      `must be ${WEB_SOURCE_AGENTS.join('|')}; got ${JSON.stringify(
        String(input.source_agent ?? '<null>').slice(0, 80)
      )}`
    );
  }

  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text) {
    throw new ProposeRejectedError('empty_text');
  }
  if (text.length > PROPOSE_TEXT_MAX_CHARS) {
    throw new ProposeRejectedError(
      'text_too_long',
      `${text.length} chars; max ${PROPOSE_TEXT_MAX_CHARS}`
    );
  }

  let hint: string | null = null;
  if (input.project_hint != null) {
    if (typeof input.project_hint !== 'string') {
      // TS-only strictness (the SQL parameter is typed text and can't see
      // this): a non-string hint is caller error, not coercible data.
      throw new ProposeRejectedError('project_hint_not_text');
    }
    hint = input.project_hint.trim() || null;
    if (hint && hint.length > PROPOSE_PROJECT_HINT_MAX_CHARS) {
      throw new ProposeRejectedError(
        'project_hint_too_long',
        `${hint.length} chars; max ${PROPOSE_PROJECT_HINT_MAX_CHARS}`
      );
    }
  }

  const metadata = input.metadata ?? {};
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new ProposeRejectedError('metadata_not_object');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    // TS-only strictness: circular / BigInt metadata can't even reach SQL.
    throw new ProposeRejectedError('metadata_not_serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > PROPOSE_METADATA_MAX_BYTES) {
    throw new ProposeRejectedError(
      'metadata_too_large',
      `${Buffer.byteLength(serialized, 'utf8')} bytes; max ${PROPOSE_METADATA_MAX_BYTES}`
    );
  }

  // ── Authoritative gate: the SECURITY DEFINER RPC.
  const supabase = deps.client ?? getSupabase();
  const { data, error } = await supabase.rpc('memory_propose', {
    p_source_agent: agent,
    p_text: text,
    p_project_hint: hint,
    p_metadata: metadata,
  });

  if (error) {
    if (error.message && error.message.includes(PROPOSE_REJECTED_PREFIX)) {
      // Re-throw the SQL rejection in the shared shape. Extract the reason
      // code (first token after the prefix) for programmatic callers.
      const tail = error.message.slice(
        error.message.indexOf(PROPOSE_REJECTED_PREFIX) + PROPOSE_REJECTED_PREFIX.length
      );
      const reason = (tail.match(/[a-z_]+/) ?? ['rejected'])[0];
      throw new ProposeRejectedError(reason, tail.replace(/^:?\s*[a-z_]+\s*/, '') || undefined);
    }
    throw new Error(`memory_propose rpc failed: ${error.message}`);
  }

  const id = typeof data === 'string' ? data : null;
  if (!id || !UUID_RE.test(id)) {
    throw new Error(
      `memory_propose rpc returned no row id (got ${JSON.stringify(data).slice(0, 80)})`
    );
  }
  return { id };
}
