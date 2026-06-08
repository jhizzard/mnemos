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
}

export type RememberResult = 'inserted' | 'updated' | 'skipped';

/**
 * Sprint 50 T2 (TermDeck): identity of the LLM that produced a memory row.
 * Stored on `memory_items.source_agent`; populated by SessionEnd hooks
 * (Claude direct, plus TermDeck's per-adapter panel-close trigger from
 * Sprint 50 T1). NULL for historical rows that pre-date the column —
 * see migrations/015_source_agent.sql for the backfill rule.
 */
export type SourceAgent = 'claude' | 'codex' | 'gemini' | 'grok' | 'orchestrator';

export const SOURCE_AGENTS: SourceAgent[] = [
  'claude',
  'codex',
  'gemini',
  'grok',
  'orchestrator',
];

export interface RecallInput {
  query: string;
  project?: string | null;
  token_budget?: number;
  min_results?: number;
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
}

export interface StatusReport {
  total_active: number;
  sessions: number;
  by_project: Record<string, number>;
  by_source_type: Record<string, number>;
  by_category: Record<string, number>;
}
