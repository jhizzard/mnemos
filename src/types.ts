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
   * Filter results by privacy_tags. Omit (or pass an empty array) for
   * default behavior — items with any privacy_tags are EXCLUDED from
   * results. When set to a non-empty array, items whose privacy_tags
   * overlap the requested set are INCLUDED (and items with no tags
   * remain included as before). Recognized values: 'finance', 'health',
   * 'legal', 'family', 'work-confidential' — open-ended.
   *
   * Examples:
   *   include_privacy: undefined / []  → no tagged items returned (default)
   *   include_privacy: ['finance']      → finance-tagged items appear; other tagged items don't
   *   include_privacy: ['finance','health'] → both finance AND health-tagged items appear
   *
   * Added 2026-05-22 — required by external Brad project `pkachu`
   * (Personal Knowledge Archive) which mirrors sensitive personal
   * corpus rows into memory_items. F3 lock: context-filter, not firewall.
   * See migrations/023_privacy_tags_column.sql.
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
