/**
 * Mnestra — tier 0: per-project objectives (Sprint 71 B-T1)
 *
 * Tier 0 is the one layer of the memory hierarchy that is NOT retrieved.
 * Doctrine (029), kitchen-level decisions and leaf evidence all reach an agent
 * through recall, and recall is a ranking function — which means a project's
 * founding constraint competes against whatever is semantically near the
 * current question, and loses on every turn that is about something else. That
 * is the drift this tier exists to stop. Objectives are pinned into context at
 * session start and re-pinned at PreCompact, above results, unranked, undecayed.
 *
 * WHERE THE ENFORCEMENT ACTUALLY LIVES: migrations/038_objective_tier.sql.
 * public.memory_objectives takes NO insert/update/delete grant for any role —
 * including service_role, whose default Supabase privileges would otherwise
 * hand full DML to the exact key TermDeck reads with — and the sole write path
 * is the SECURITY DEFINER pair objective_ratify() / objective_retire(). This
 * module is a typed client for that surface plus a fail-soft fetch helper. It
 * is deliberately NOT the security boundary: anyone holding the service key can
 * skip this file, and the SQL still refuses them.
 *
 * Validation happens twice, same layering as src/propose.ts and
 * src/session_record.ts:
 *   - HERE (mirror): fail fast with a clean error before a DB round-trip, and
 *     stricter in ways SQL cannot express (runtime type checks; JS string
 *     length counts UTF-16 code units where SQL counts characters, so
 *     astral-heavy text may be rejected here that SQL would accept — the
 *     conservative direction).
 *   - IN SQL (authoritative): the RPCs re-validate everything. Both layers
 *     share the OBJECTIVE_RATIFY_REJECTED prefix so a caller sees one error
 *     shape regardless of which side rejected.
 *
 * tests/migration-038-hygiene.test.ts pins every constant below against the
 * migration text, so the two cannot drift.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabase } from './db.js';

/**
 * RPC names — PostgREST binds by name; renaming one is a breaking change.
 *
 * There are exactly TWO: one read, one mutation. Retirement is a MODE of
 * objective_ratify (supersede with no content), not a function of its own —
 * "mutation only through ratification" has to be checkable by counting entry
 * points, and the count has to be one. Migration 038's GATE 6 enforces that as
 * a live privilege fact, so adding a third here would fail the migration's own
 * receipt rather than quietly widening the surface.
 */
export const OBJECTIVE_LIST_RPC = 'objective_list';
export const OBJECTIVE_RATIFY_RPC = 'objective_ratify';

/** The table, for consumers that read it directly (TermDeck's fallback path). */
export const OBJECTIVE_TABLE = 'memory_objectives';

/**
 * Binding caps. The SQL enforces the same numbers (authoritative).
 *
 * OBJECTIVE_MAX_ACTIVE is not a performance limit — it is the feature. A tier
 * that is injected into every session is only affordable while it is small, and
 * a tier 0 of sixty rows is a context tax that has stopped meaning anything.
 *
 * OBJECTIVE_TEXT_MAX_CHARS is in lockstep with TIER0_MAX_TEXT_CHARS in TermDeck's
 * packages/server/src/tier0.js, which CLAMPS at that length. Rejecting at the
 * same number means an operator finds out at ratification time, when they can
 * rewrite it — instead of discovering months later that the second half of an
 * objective has never been injected into anything.
 */
export const OBJECTIVE_MAX_ACTIVE = 15;
export const OBJECTIVE_TEXT_MAX_CHARS = 600;
export const OBJECTIVE_PROJECT_MAX_CHARS = 120;
export const OBJECTIVE_RATIFIED_BY_MAX_CHARS = 120;
export const OBJECTIVE_METADATA_MAX_BYTES = 8192;
export const OBJECTIVE_RANK_MIN = 1;
export const OBJECTIVE_RANK_MAX = 99;

/** The live status; everything else is history. */
export const OBJECTIVE_STATUS_ACTIVE = 'active';
/** Full vocabulary, mirroring the SQL CHECK. */
export const OBJECTIVE_STATUSES = ['active', 'superseded', 'retired'] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

/**
 * Operator gate for the two mutation paths, mirroring the `termdeck doctrine
 * ratify` precedent and engram's MNESTRA_* env convention.
 *
 * EXACT MATCH on '1', not truthiness: a gate that opens on the string 'false'
 * (or on '0', or on an empty-but-present value some shell exported) is not a
 * gate. Same reasoning as TERMDECK_ALLOW_PANEL_ANTHROPIC_KEY on the TermDeck
 * side.
 *
 * This is a usability gate, NOT the security boundary — it stops an agent from
 * casually rewriting the operator's objectives mid-session. The boundary is the
 * grant posture in 038.
 */
export const OBJECTIVE_RATIFY_GATE_ENV = 'MNESTRA_ALLOW_OBJECTIVE_RATIFY';

/** Stable, machine-matchable prefix shared with the SQL raises. */
export const OBJECTIVE_RATIFY_REJECTED_PREFIX = 'OBJECTIVE_RATIFY_REJECTED';

/** A ratification refused — by this mirror or by the SQL. */
export class ObjectiveRejectedError extends Error {
  /** Stable reason code, e.g. 'rank_taken', 'too_many_active'. */
  readonly reason: string;

  constructor(reason: string, detail?: string) {
    super(`${OBJECTIVE_RATIFY_REJECTED_PREFIX}: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'ObjectiveRejectedError';
    this.reason = reason;
  }
}

export function isObjectiveRejected(err: unknown): boolean {
  if (err instanceof ObjectiveRejectedError) return true;
  return err instanceof Error && err.message.startsWith(OBJECTIVE_RATIFY_REJECTED_PREFIX);
}

/** One tier-0 row, exactly the column set objective_list returns. */
export interface Objective {
  id: string;
  project: string;
  rank: number;
  content: string;
  status: ObjectiveStatus | string;
  supersedes: string | null;
  ratified_by: string;
  ratified_at: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface ObjectiveRatifyInput {
  project: string;
  ratified_by: string;
  /**
   * The objective prose, <= OBJECTIVE_TEXT_MAX_CHARS. Omit ONLY together with a
   * `supersedes` — that combination is the retire mode (supersede with nothing).
   */
  content?: string | null;
  /** Omit only when superseding — a replacement inherits its predecessor's rank. */
  rank?: number | null;
  /** The active objective this one replaces. It is marked, never deleted. */
  supersedes?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ObjectiveRetireInput {
  /** The project the objective belongs to — validated against the row server-side. */
  project: string;
  id: string;
  ratified_by: string;
  reason?: string | null;
}

export interface ObjectiveDeps {
  /** Override the Supabase client (tests inject a fake). */
  client?: SupabaseClient;
  /** Override the environment the operator gate reads (tests inject a fake). */
  env?: Record<string, string | undefined>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse the reason code back out of a SQL raise so callers can branch on it
 * without string-matching the whole message. Returns null for anything that
 * is not one of our rejections (a network error, a missing function, …) —
 * those must stay ordinary errors rather than being laundered into rejections.
 */
export function parseRejection(message: string | undefined | null): string | null {
  if (!message) return null;
  const m = /OBJECTIVE_RATIFY_REJECTED:\s*([a-z_]+)/.exec(message);
  return m ? m[1]! : null;
}

function rethrowRpcError(err: { message?: string } | null): void {
  if (!err) return;
  const reason = parseRejection(err.message);
  if (reason) throw new ObjectiveRejectedError(reason, err.message);
  throw new Error(err.message || 'objective RPC failed');
}

function assertOperatorGate(deps: ObjectiveDeps): void {
  const env = deps.env ?? process.env;
  if (env[OBJECTIVE_RATIFY_GATE_ENV] !== '1') {
    throw new ObjectiveRejectedError(
      'operator_gate_closed',
      `ratification is an operator act; set ${OBJECTIVE_RATIFY_GATE_ENV}=1 to allow it in this process`
    );
  }
}

function requireText(
  value: unknown,
  field: string,
  emptyCode: string,
  tooLongCode: string,
  max: number
): string {
  if (typeof value !== 'string') {
    throw new ObjectiveRejectedError(emptyCode, `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new ObjectiveRejectedError(emptyCode);
  if (trimmed.length > max) {
    throw new ObjectiveRejectedError(tooLongCode, `${trimmed.length} chars; max ${max}`);
  }
  return trimmed;
}

// ── reads ───────────────────────────────────────────────────────────────────

/**
 * The active objectives for one project, rank ascending.
 *
 * THROWS on transport failure — this is the operator-facing read (the MCP
 * tool), where a silent empty list is indistinguishable from "this project has
 * no objectives" and would send someone off to re-ratify a set that already
 * exists. The INJECTION read is the opposite; see fetchTier0Block.
 */
export async function objectiveList(
  project: string,
  deps: ObjectiveDeps = {}
): Promise<Objective[]> {
  const client = deps.client ?? getSupabase();
  const { data, error } = await client.rpc(OBJECTIVE_LIST_RPC, { p_project: project });
  if (error) rethrowRpcError(error);
  return Array.isArray(data) ? (data as Objective[]) : [];
}

/**
 * The full history for a project, newest ratification first — including
 * superseded and retired rows.
 *
 * A plain table read, not an RPC: it is a read, so it bypasses nothing, and
 * keeping objective_list itself single-purpose (active rows only, one project,
 * cheap) matters more than symmetry. objective_list is on the hot injection
 * path of every session and every compaction; history is looked at by a human,
 * occasionally.
 */
export async function objectiveHistory(
  project: string,
  deps: ObjectiveDeps = {}
): Promise<Objective[]> {
  const client = deps.client ?? getSupabase();
  const { data, error } = await client
    .from(OBJECTIVE_TABLE)
    .select('*')
    .eq('project', project)
    .order('rank', { ascending: true })
    .order('ratified_at', { ascending: false });
  if (error) rethrowRpcError(error as { message?: string });
  return Array.isArray(data) ? (data as Objective[]) : [];
}

/** The pinned block, in the shape Deck A's recall envelope reserves (seam §1). */
export interface Tier0Block {
  /** Always an array — never null, never absent. */
  tier0: Objective[];
  /** How it was obtained; 'unavailable' means degraded, not empty. */
  tier0_source: 'rpc' | 'unavailable';
}

/**
 * The injection fetch — the helper Deck A's envelope stub calls, and the shape
 * TermDeck's provider already reserves: `{ tier0: [...] }` first, never
 * interleaved with results, never ranked or decayed by recall logic.
 *
 * FAIL-SOFT, unlike objectiveList: this runs on the recall path, and a store
 * that has not applied 038 yet — or a transient network fault — must degrade to
 * "no tier 0" rather than taking recall down with it. An agent with no
 * objectives is the pre-Sprint-71 status quo; an agent with no recall is a
 * broken session. `tier0_source: 'unavailable'` is what distinguishes the two
 * for anyone reading telemetry, which is why it is not merely an empty array.
 *
 * A null/blank project returns an empty block WITHOUT a round-trip, matching
 * objective_list(null)'s deliberate zero rows: tier 0 is per-project, and
 * handing an agent every project's binding constraints is worse than handing it
 * none — it would defend constraints belonging to code it is not editing.
 */
export async function fetchTier0Block(
  project: string | null | undefined,
  deps: ObjectiveDeps = {}
): Promise<Tier0Block> {
  if (typeof project !== 'string' || !project.trim()) {
    return { tier0: [], tier0_source: 'unavailable' };
  }
  try {
    const rows = await objectiveList(project.trim(), deps);
    return { tier0: rows, tier0_source: 'rpc' };
  } catch (err) {
    console.error(
      `[mnestra] tier-0 fetch degraded for project ${JSON.stringify(project)}:`,
      err instanceof Error ? err.message : String(err)
    );
    return { tier0: [], tier0_source: 'unavailable' };
  }
}

/**
 * The adapter for Deck A's recall seam (§Seam 1).
 *
 * `RecallDeps.fetchTier0` (src/recall.ts) is the wiring point A-T1/A-T2
 * reserved; this returns a function with exactly that signature, mapping each
 * objective onto their `Tier0Item` shape. Supplying it makes the pinned block
 * fill on BOTH the default and graph recall paths with no other change on their
 * side:
 *
 *     memoryRecall(input, { fetchTier0: tier0FetcherForRecall() })
 *
 * NOT wired as a default here, deliberately. Two reasons, and the second is the
 * one that matters: (a) at authoring time A-T2's envelope SCHEMA-READY had not
 * been posted, which is the gate the brief puts on wiring; (b) recall.ts and
 * recall_graph.ts are another lane's files under active edit, and a default
 * that changes what every existing memoryRecall call does belongs to whoever
 * owns that call path, not to whoever wrote the fetch.
 *
 * `source_type: 'objective'` on the projected item is the reserved sentinel
 * from the marker post. It is synthesized HERE, on a projection — no row with
 * that source_type is ever written to memory_items, which is precisely why the
 * value is safe to use as a walk-exclusion marker.
 *
 * The `query` argument is ignored on purpose. Tier 0 is not retrieval: the same
 * objectives are pinned regardless of what was asked, which is the whole point
 * of a tier that a ranking function cannot outvote.
 */
export function tier0FetcherForRecall(
  deps: ObjectiveDeps = {}
): (input: { query: string; project: string | null }) => Promise<
  Array<{
    memory_id: string;
    content: string;
    project: string | null;
    source_type: string;
    metadata: Record<string, unknown>;
  }>
> {
  return async ({ project }) => {
    const { tier0 } = await fetchTier0Block(project, deps);
    return tier0.map((o) => ({
      memory_id: o.id,
      content: o.content,
      project: o.project,
      source_type: 'objective',
      metadata: {
        rank: o.rank,
        status: o.status,
        ratified_by: o.ratified_by,
        ratified_at: o.ratified_at,
        tier: 0,
      },
    }));
  };
}

// ── the two mutation paths ──────────────────────────────────────────────────

export interface ObjectiveRatifyResult {
  /** The new objective's id — or, in retire mode, the id of the row retired. */
  id: string;
  project: string;
  rank: number | null;
  /** The id this replaced or retired, if any — marked, never deleted. */
  superseded: string | null;
  /** True when this call retired an objective without replacing it. */
  retired: boolean;
}

/**
 * The single mutation entry point. Three modes:
 *
 *   CREATE   content + rank                    → a new objective
 *   REPLACE  content + supersedes              → predecessor marked 'superseded'
 *   RETIRE   supersedes, NO content            → predecessor marked 'retired'
 *
 * Operator-gated. Everything below the gate is mirror validation; the SQL
 * re-checks all of it and additionally enforces what only it can see — rank
 * uniqueness among active rows, the active-row cap (serialized on a per-project
 * advisory lock), and that a superseded target exists, belongs to this project,
 * and is still active.
 */
export async function objectiveRatify(
  input: ObjectiveRatifyInput,
  deps: ObjectiveDeps = {}
): Promise<ObjectiveRatifyResult> {
  assertOperatorGate(deps);

  const project = requireText(
    input.project,
    'project',
    'empty_project',
    'project_too_long',
    OBJECTIVE_PROJECT_MAX_CHARS
  );
  const ratifiedBy = requireText(
    input.ratified_by,
    'ratified_by',
    'empty_ratified_by',
    'ratified_by_too_long',
    OBJECTIVE_RATIFIED_BY_MAX_CHARS
  );

  let supersedes: string | null = null;
  if (input.supersedes != null) {
    if (typeof input.supersedes !== 'string' || !UUID_RE.test(input.supersedes)) {
      throw new ObjectiveRejectedError('supersedes_not_uuid', String(input.supersedes).slice(0, 80));
    }
    supersedes = input.supersedes;
  }

  let content: string | null = null;
  if (input.content != null && String(input.content).trim() !== '') {
    content = requireText(
      input.content,
      'content',
      'empty_content',
      'content_too_long',
      OBJECTIVE_TEXT_MAX_CHARS
    );
  }

  // Retire is "supersede with nothing" — the ONLY shape in which content may be
  // absent. Absent content AND absent supersedes is a call that would do
  // nothing, which is far more likely to be a bug than an intent.
  const retiring = content === null && supersedes !== null;
  if (content === null && supersedes === null) {
    throw new ObjectiveRejectedError(
      'content_or_supersedes_required',
      'pass content to create, or supersedes alone to retire'
    );
  }

  let rank: number | null = null;
  if (input.rank != null) {
    if (retiring) {
      // Ignoring it would let an operator believe they had moved an objective
      // they were in fact retiring.
      throw new ObjectiveRejectedError(
        'rank_not_allowed_on_retire',
        'a retirement has no rank to set'
      );
    }
    if (typeof input.rank !== 'number' || !Number.isFinite(input.rank)) {
      throw new ObjectiveRejectedError('rank_not_number', String(input.rank).slice(0, 80));
    }
    rank = Math.trunc(input.rank);
    if (rank < OBJECTIVE_RANK_MIN || rank > OBJECTIVE_RANK_MAX) {
      throw new ObjectiveRejectedError(
        'rank_out_of_range',
        `${rank}; allowed ${OBJECTIVE_RANK_MIN}-${OBJECTIVE_RANK_MAX}`
      );
    }
  } else if (!supersedes) {
    // A replacement inherits its predecessor's slot; a brand-new objective has
    // no slot to inherit, so the operator has to say where it goes.
    throw new ObjectiveRejectedError('rank_required', 'rank is required unless superseding');
  }

  let metadata: Record<string, unknown> = {};
  if (input.metadata != null) {
    if (typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
      throw new ObjectiveRejectedError('metadata_not_object');
    }
    metadata = input.metadata;
    const bytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8');
    if (bytes > OBJECTIVE_METADATA_MAX_BYTES) {
      throw new ObjectiveRejectedError(
        'metadata_too_large',
        `${bytes} bytes; max ${OBJECTIVE_METADATA_MAX_BYTES}`
      );
    }
  }

  const client = deps.client ?? getSupabase();
  const { data, error } = await client.rpc(OBJECTIVE_RATIFY_RPC, {
    p_project: project,
    p_ratified_by: ratifiedBy,
    p_content: content,
    p_rank: rank,
    p_supersedes: supersedes,
    p_metadata: metadata,
  });
  if (error) rethrowRpcError(error);

  return {
    id: typeof data === 'string' ? data : String(data ?? ''),
    project,
    rank,
    superseded: supersedes,
    retired: retiring,
  };
}

/**
 * Retire an objective with no replacement.
 *
 * A CONVENIENCE WRAPPER, not a second path: it calls objective_ratify in retire
 * mode. The first draft of this module had its own objective_retire RPC; B-T4
 * declined to ratify that and ORCH upheld the contract, because a second
 * grant-reachable mutation path is not a smaller version of "mutation only
 * through ratification" — it is the absence of it. Keeping a named TS function
 * costs nothing (it is one door with a readable handle); keeping a second SQL
 * function would have cost the property.
 *
 * `reason` rides in metadata, which the SQL merges into the retired row.
 *
 * No validation of its own: the id is validated by objectiveRatify as
 * `supersedes_not_uuid`, and the operator gate is asserted there too — so a
 * closed gate still answers first. One door means one error vocabulary.
 */
export async function objectiveRetire(
  input: ObjectiveRetireInput,
  deps: ObjectiveDeps = {}
): Promise<{ id: string }> {
  const reason =
    typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : null;

  const result = await objectiveRatify(
    {
      project: input.project,
      ratified_by: input.ratified_by,
      content: null,
      supersedes: input.id,
      metadata: reason ? { retire_reason: reason } : {},
    },
    deps
  );
  return { id: result.id };
}

// ── render ──────────────────────────────────────────────────────────────────

/**
 * The human/agent-readable pinned block.
 *
 * TermDeck owns the canonical render for its own injection surfaces
 * (renderTier0Block in packages/server/src/tier0.js, parity-fenced against its
 * bundled hook copy). This one exists for the MCP tool's text response, and it
 * deliberately does NOT try to be byte-identical to that one — two renderers
 * pinned to each other across repos with no shared test would be a parity fence
 * nobody can run. What IS contractual is the data, and that comes from the same
 * RPC on both sides.
 */
export function formatObjectives(rows: Objective[], project?: string): string {
  if (!rows.length) {
    return project
      ? `No tier-0 objectives ratified for ${project}.`
      : 'No tier-0 objectives.';
  }
  const head = `## Objectives (tier 0)${project ? ` — ${project}` : ''}`;
  const body = rows.map((r, i) => `${i + 1}. ${r.content}`).join('\n');
  const provenance = `\n_${rows.length} active; last ratified ${
    rows
      .map((r) => r.ratified_at)
      .sort()
      .slice(-1)[0] ?? 'unknown'
  } by ${rows[rows.length - 1]?.ratified_by ?? 'unknown'}._`;
  return `${head}\n${body}\n${provenance}`;
}
