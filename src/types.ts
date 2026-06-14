/**
 * Mnestra — core type definitions
 */

export type SourceType =
  | 'fact'
  | 'decision'
  | 'preference'
  | 'bug_fix'
  | 'architecture'
  | 'code_context';

export type Category =
  | 'technical'
  | 'business'
  | 'workflow'
  | 'debugging'
  | 'architecture'
  | 'convention'
  | 'relationship';

export type Importance = 'critical' | 'important' | 'minor';

export type RelationshipType =
  | 'supersedes'
  | 'relates_to'
  | 'contradicts'
  | 'elaborates'
  | 'caused_by'
  | 'blocks'
  | 'inspired_by'
  | 'cross_project_link';

export const RELATIONSHIP_TYPES: RelationshipType[] = [
  'supersedes',
  'relates_to',
  'contradicts',
  'elaborates',
  'caused_by',
  'blocks',
  'inspired_by',
  'cross_project_link',
];

export interface MemoryItem {
  id: string;
  content: string;
  source_type: SourceType;
  category: Category | null;
  project: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
  is_active: boolean;
  archived: boolean;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemorySession {
  id: string;
  project: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface MemoryRelationship {
  id: string;
  source_id: string;
  target_id: string;
  relationship_type: RelationshipType;
  created_at: string;
}

export interface RememberInput {
  content: string;
  project?: string;
  source_type?: SourceType;
  category?: Category | null;
  metadata?: Record<string, unknown>;
  /**
   * Sprint 74 T1: provenance of the writer, stored on
   * `memory_items.source_agent`. Loose `string` (not `SourceAgent`) on
   * purpose — same loose-at-core / strict-at-MCP-boundary pattern as
   * `RecallInput.source_agents`. remember.ts normalizes the value
   * (trim/lowercase/shape-check); well-formed values outside the known
   * taxonomy are stored as-is so a future agent's rows become
   * retro-filterable the day SOURCE_AGENTS adds the value — no
   * migration-022-style backfill archaeology. Omit/null = NULL column
   * (unknown provenance), the pre-Sprint-74 behavior.
   */
  source_agent?: string | null;
}

export type RememberResult = 'inserted' | 'updated' | 'skipped';

/**
 * Sprint 50 T2 (TermDeck): identity of the LLM that produced a memory row.
 * Stored on `memory_items.source_agent`; populated by SessionEnd hooks
 * (Claude direct, plus TermDeck's per-adapter panel-close trigger from
 * Sprint 50 T1). NULL for historical rows that pre-date the column —
 * see migrations/015_source_agent.sql for the backfill rule.
 *
 * Sprint 74 T1: web-surface agents (`*-web`) identify browser-chat panels
 * as distinct trust domains from their CLI counterparts — a filter for
 * `grok` deliberately does NOT match `grok-web` (exact-match semantics).
 * Only grok-web has a live producer today (TermDeck's web-chat-grok
 * panel); claude-web / chatgpt-web / gemini-web are forward declarations
 * for the queued memory-inbox sprint. The DB column stays plain nullable
 * text with NO CHECK constraint, so adding a value here (plus migration
 * 025's COMMENT refresh) is the entire schema story — fail-soft writers
 * can never lose capture to a constraint violation on taxonomy skew.
 */
export type SourceAgent =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'grok'
  | 'orchestrator'
  | 'claude-web'
  | 'chatgpt-web'
  | 'grok-web'
  | 'gemini-web';

export const SOURCE_AGENTS: SourceAgent[] = [
  'claude',
  'codex',
  'gemini',
  'grok',
  'orchestrator',
  'claude-web',
  'chatgpt-web',
  'grok-web',
  'gemini-web',
];

/**
 * Sprint 76 T1: the web-surface subset of SOURCE_AGENTS — the ONLY values
 * memory_propose() accepts ("CLIs write canonical; web chats write
 * proposals"). DERIVED from SOURCE_AGENTS by suffix filter rather than
 * declared as a second literal list, so the two cannot drift: adding a
 * fifth *-web value to SOURCE_AGENTS extends this const, the TS
 * mirror-validation in src/propose.ts, and the serialized whitelist in the
 * same change — the same single-source-of-truth pattern as the zod enum
 * the MCP recall gate derives from SOURCE_AGENTS (Sprint 74).
 *
 * NOTE: the authoritative SQL whitelist inside
 * migrations/026_memory_inbox.sql is necessarily a literal four-value list
 * (SQL cannot import this module); tests/migration-026-hygiene.test.ts
 * pins the two lists in lockstep.
 */
export type WebSourceAgent = Extract<SourceAgent, `${string}-web`>;

export const WEB_SOURCE_AGENTS: WebSourceAgent[] = SOURCE_AGENTS.filter(
  (a): a is WebSourceAgent => a.endsWith('-web')
);

/** Sprint 76 T1: lifecycle of a public.memory_inbox proposal row. */
export type MemoryInboxStatus = 'pending' | 'promoted' | 'rejected';

/**
 * Sprint 76 T1: a public.memory_inbox row (migration 026) — a quarantined
 * web-chat proposal. A row here is NOT a memory: no recall path reads the
 * inbox (pinned by tests/quarantine-proof.test.ts). The Rumen promotion
 * pass is the only consumer, stamping status='promoted' (+
 * promoted_memory_id) or status='rejected' (+ rejection_reason).
 */
export interface MemoryInboxRow {
  id: string;
  created_at: string;
  /** One of WEB_SOURCE_AGENTS — enforced by the RPC whitelist, not a CHECK. */
  source_agent: string;
  /** Proposer's claimed project; advisory only — Rumen may re-map. */
  project_hint: string | null;
  /** The proposal body (trimmed; <= 4000 chars). */
  text: string;
  status: MemoryInboxStatus;
  promoted_memory_id: string | null;
  rejection_reason: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Sprint 76 T1: input to memoryPropose / the webhook `propose` op. Loose
 * `string` for source_agent at the core (strict at the boundary) — the
 * same loose-at-core pattern as RememberInput.source_agent, except here a
 * non-whitelisted value is REJECTED rather than stored: proposals are a
 * trust boundary, not fail-soft capture.
 */
export interface ProposeInput {
  source_agent: string;
  text: string;
  project_hint?: string | null;
  metadata?: Record<string, unknown>;
}

/** Sprint 76 T1: result of a successful proposal — the new inbox row id. */
export interface ProposeResult {
  id: string;
}

/**
 * Sprint 78 T3 (recall telemetry): which retrieval surface produced a
 * recall-hit log row. Stored on `memory_recall_log.surface` (migration 027).
 * MCP-stdio paths log their native surface; the webhook server stamps
 * 'webhook' so over-the-wire recall is distinguishable in the telemetry.
 */
export type RecallSurface =
  | 'recall'
  | 'search'
  | 'index'
  | 'timeline'
  | 'graph'
  | 'webhook';

export interface RecallInput {
  query: string;
  project?: string | null;
  token_budget?: number;
  min_results?: number;
  /**
   * Sprint 78 T3 (recall telemetry) — fire-and-forget log context. These do
   * NOT affect retrieval; they only tag the recall-hit log rows written AFTER
   * the result is built (the write is never awaited, so recall latency is
   * unchanged). `log_surface` lets the webhook stamp over-the-wire recall as
   * 'webhook'; the MCP-stdio path leaves it undefined and the log falls back
   * to the native surface. `log_session_id` / `log_source_agent` carry caller
   * provenance when the client supplies it (NULL otherwise). Named `log_*` to
   * avoid any confusion with the `source_agents` retrieval FILTER above.
   */
  log_surface?: RecallSurface;
  log_session_id?: string | null;
  log_source_agent?: string | null;
  /**
   * Filter results by the source agent that produced each row. Omit (or
   * pass an empty array) for no filter — the default, returns all agents.
   * When set, rows with NULL source_agent (historical, pre-Sprint-50 except
   * the backfilled session_summary rows) are excluded — unless
   * include_null_source is set true.
   */
  source_agents?: string[] | null;
  /**
   * Sprint 62 T3: when true, rows with NULL source_agent pass the
   * source_agents filter alongside agent-matched rows. Default false
   * preserves the Sprint 50 silent-drop semantics. Use true to recover
   * the residual NULL slice (bare-call fact rows, etc.) that migration
   * 022 deliberately left NULL per migration 015's provenance bright
   * line. No effect when source_agents is omitted (NULL rows already
   * pass an unfiltered query).
   */
  include_null_source?: boolean;
  /**
   * Privacy-tags PR (Deck B): opt-in list of privacy-category tags to
   * surface. Default behavior — omitted or an empty array — EXCLUDES every
   * row carrying any privacy tag, keeping tagged-sensitive items out of
   * ordinary recalls (the one intentional, non-breaking behavior change Brad
   * specified). An explicit include_privacy: ['secret', …] surfaces rows that
   * share at least one tag with the list (any-overlap); untagged rows always
   * pass regardless. Filtered at the recall.ts layer — never added to the
   * memory_hybrid_search RPC arg list — to keep its 8-arg signature stable.
   */
  include_privacy?: string[];
}

export interface RecallHit {
  id: string;
  content: string;
  source_type: SourceType;
  category: Category | null;
  project: string;
  score: number;
  metadata: Record<string, unknown>;
  created_at: string;
  /**
   * Privacy-tags PR (Deck B): categorical sensitivity tags on the row,
   * surfaced by memory_hybrid_search's extended RETURNS TABLE (migration
   * 023). Absent/NULL on pre-migration rows and on RPC results that predate
   * the column; recall.ts reads it as (privacy_tags ?? []) so a missing value
   * degrades to "untagged" rather than throwing.
   */
  privacy_tags?: string[] | null;
}

export interface SearchInput {
  query: string;
  project?: string | null;
  source_type?: SourceType | null;
  limit?: number;
  /** Sprint 78 T3 (recall telemetry) — see RecallInput.log_surface. */
  log_surface?: RecallSurface;
  log_session_id?: string | null;
  log_source_agent?: string | null;
}

export interface StatusReport {
  total_active: number;
  sessions: number;
  by_project: Record<string, number>;
  by_source_type: Record<string, number>;
  by_category: Record<string, number>;
}
