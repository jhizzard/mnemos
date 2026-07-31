/**
 * Mnestra — recall → memory_cite → REAL positive label (Sprint 83 T2)
 *
 * THIS IS THE SPRINT'S ACCEPTANCE BAR, and it is deliberately not a unit test.
 * The unit tests in cite.test.ts prove memoryCite calls the right RPC with the
 * right narrowing against a fake. That is not the claim that matters. The
 * claim that matters is that a label produced this way is VISIBLE TO THE
 * THING THAT CONSUMES LABELS — `scripts/calibration/fit-platt.ts` — because
 * the entire reason this lane exists is that 39k telemetry rows carry 0
 * positives and the fit correctly refuses to run.
 *
 * So the assertion at the end is not "cited = true". It is: re-run
 * fit-platt's OWN label query, verbatim, and watch `positives` go from 0 to 1.
 *
 * Two tripwires that would let this test pass while positives stayed 0
 * (T1 SCHEMA-READY-2 §2 flagged both, and they are exactly the
 * verifier-theater shape — a green check that verified nothing):
 *   - `EXCLUDED_SURFACES = ['graph']` (fit-platt.ts:54) — a citation on a
 *     graph-surface row is dropped from the fit entirely.
 *   - `score < 0.4` and `score is not null` (fit-platt.ts:46, :212) — a row
 *     with a NULL or smoke-valued score is excluded.
 * The seeded row therefore uses surface='recall' and a realistic RRF score.
 * A NEGATIVE CONTROL below seeds the excluded shapes too and proves they do
 * NOT become positives — otherwise this test could not tell a working label
 * channel from a filter that silently swallowed everything.
 *
 * SKIPPED unless MNESTRA_TEST_DATABASE_URL points at a throwaway database with
 * migrations 001→034 applied. It never touches the daily-driver store: it
 * writes fixtures and deletes them, which is only safe on a scratch database.
 *
 *   docker run -d --name t2-s83-pgvector -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=mnestra_test -p 55435:5432 pgvector/pgvector:pg16
 *   # provision anon/authenticated/service_role + vault.secrets, apply 001→034
 *   MNESTRA_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55435/mnestra_test \
 *     npm test
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import pg from 'pg';

import { memoryCite } from '../src/cite.js';

const DSN = process.env.MNESTRA_TEST_DATABASE_URL ?? '';

/** fit-platt.ts:46 / :54 — replicated, not re-derived, so drift is visible. */
const SMOKE_SCORE_FLOOR = 0.4;
const EXCLUDED_SURFACES = ['graph'];

/**
 * Minimal Supabase-client shim over `pg`.
 *
 * The point is that the REAL `memoryCite` runs against the REAL SQL function.
 * Mocking either end would leave the interesting failure — a signature
 * mismatch between the TS caller and the shipped RPC — undetectable, which is
 * precisely the break this test is here to catch.
 */
function pgAsSupabase(pool: pg.Pool): any {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      try {
        const keys = Object.keys(args);
        const params = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
        const { rows } = await pool.query(
          `select public.${name}(${params}) as result`,
          keys.map((k) => args[k])
        );
        return { data: rows[0]?.result ?? null, error: null };
      } catch (err) {
        return { data: null, error: { message: (err as Error).message } };
      }
    },
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: async (col: string, val: unknown) => {
          try {
            const { rows } = await pool.query(
              `select ${cols} from public.${table} where ${col} = $1`,
              [val]
            );
            return { data: rows, error: null };
          } catch (err) {
            return { data: null, error: { message: (err as Error).message } };
          }
        },
      }),
    }),
  };
}

/** fit-platt's label census, verbatim in predicate. */
async function fitPlattCensus(pool: pg.Pool, groupId: string) {
  const { rows } = await pool.query(
    `select count(*)::int                       as usable,
            count(*) filter (where l.cited)::int as positives
       from public.memory_recall_log l
       left join public.memory_items m on m.id = l.memory_id
      where l.score is not null
        and l.score < $1
        and not (l.surface = any($2::text[]))
        and l.recall_group_id = $3`,
    [SMOKE_SCORE_FLOOR, EXCLUDED_SURFACES, groupId]
  );
  return rows[0] as { usable: number; positives: number };
}

test(
  'ACCEPTANCE: an ordinary recall → memory_cite round-trip produces a positive label fit-platt can see',
  { skip: DSN ? false : 'set MNESTRA_TEST_DATABASE_URL to a scratch DB with 001→034 applied' },
  async (t) => {
    const pool = new pg.Pool({ connectionString: DSN });
    const groupId = randomUUID();
    const memIds = [randomUUID(), randomUUID(), randomUUID()];

    t.after(async () => {
      await pool.query('delete from public.memory_recall_log where recall_group_id = $1', [groupId]);
      await pool.query('delete from public.memory_items where id = any($1::uuid[])', [memIds]);
      await pool.end();
    });

    // ── seed three memories and the log rows one recall would have written.
    for (const [i, id] of memIds.entries()) {
      await pool.query(
        `insert into public.memory_items (id, content, source_type, project)
         values ($1, $2, 'bug_fix', 'termdeck-s83-t2-fixture')`,
        [id, `fixture memory ${i + 1} for the Sprint 83 T2 citation round-trip`]
      );
      await pool.query(
        `insert into public.memory_recall_log
           (memory_id, query_hash, query_preview, score, rank, surface,
            source_type, token_budget, recall_group_id)
         values ($1, 'fixture-hash', 'fixture recall', $2, $3, 'recall',
                 'bug_fix', 2000, $4)`,
        // A realistic RRF score: comfortably under SMOKE_SCORE_FLOOR and
        // non-null, so the row is inside fit-platt's usable window.
        [id, 0.0216 - i * 0.001, i + 1, groupId]
      );
    }

    const before = await fitPlattCensus(pool, groupId);
    assert.equal(before.usable, 3, 'all three seeded rows must be inside fit-platt window');
    assert.equal(before.positives, 0, 'baseline: the label channel starts empty');

    // ── the round-trip: cite rank 2 only, the way an agent that used exactly
    //    one of three recalled memories would.
    const result = await memoryCite(
      { recall_group_id: groupId, ranks: [2], source_agent: 'claude' },
      { client: pgAsSupabase(pool) }
    );

    assert.equal(result.ok, true, `memory_cite failed: ${result.error}`);
    assert.equal(result.cited, 1);

    const after = await fitPlattCensus(pool, groupId);
    assert.equal(after.positives, 1, 'fit-platt must now see exactly one REAL positive');
    assert.equal(after.usable, 3, 'the other two stay usable as negatives');

    // The positive landed on the memory the agent actually named, not on
    // "whichever row was most recent" — the bug that made mark_recall_feedback
    // unsuitable once several panels recall concurrently.
    const { rows: cited } = await pool.query(
      'select memory_id, rank from public.memory_recall_log where recall_group_id = $1 and cited order by rank',
      [groupId]
    );
    assert.equal(cited.length, 1);
    assert.equal(cited[0].rank, 2);
    assert.equal(cited[0].memory_id, memIds[1]);

    // SR-5: the complement is now an OBSERVED negative (seen, not used), not
    // merely an unobserved one — every row of the group is stamped.
    const { rows: resolved } = await pool.query(
      'select count(*)::int as n from public.memory_recall_log where recall_group_id = $1 and group_resolved_at is not null',
      [groupId]
    );
    assert.equal(resolved[0].n, 3, 'group_resolved_at stamps the whole group, not just the cited row');

    // `dismissed` must stay untouched — observed-negative and explicit
    // rejection are separate signals and conflating them would corrupt one to
    // create the other.
    const { rows: dismissed } = await pool.query(
      'select count(*)::int as n from public.memory_recall_log where recall_group_id = $1 and dismissed',
      [groupId]
    );
    assert.equal(dismissed[0].n, 0);

    // ── idempotency: a repeat call returns the same post-condition count
    //    rather than 0, which is what makes a retry safe for the caller.
    const repeat = await memoryCite(
      { recall_group_id: groupId, ranks: [2] },
      { client: pgAsSupabase(pool) }
    );
    assert.equal(repeat.ok, true);
    assert.equal(repeat.cited, 1, 'idempotent in return value, not just in state');
    const afterRepeat = await fitPlattCensus(pool, groupId);
    assert.equal(afterRepeat.positives, 1, 'no double-counting');
  }
);

test(
  'NEGATIVE CONTROL: citations on fit-platt-excluded rows do NOT become positives',
  { skip: DSN ? false : 'set MNESTRA_TEST_DATABASE_URL to a scratch DB with 001→034 applied' },
  async (t) => {
    // Without this, the acceptance test above could not distinguish a working
    // label channel from one where the fit's filters silently swallow every
    // label — the failure T1 warned about, and the reason a seeded fixture
    // must be checked against the CONSUMER's predicate rather than the
    // producer's return value.
    const pool = new pg.Pool({ connectionString: DSN });
    const groupId = randomUUID();
    const memIds = [randomUUID(), randomUUID()];

    t.after(async () => {
      await pool.query('delete from public.memory_recall_log where recall_group_id = $1', [groupId]);
      await pool.query('delete from public.memory_items where id = any($1::uuid[])', [memIds]);
      await pool.end();
    });

    // Distinct content per row: memory_items carries a unique index on
    // content_hash for active rows, so two identically-worded fixtures
    // collide. Cheap to hit, and it would look like a test-harness flake
    // rather than the constraint doing its job.
    await pool.query(
      `insert into public.memory_items (id, content, source_type, project)
       values ($1, 'excluded-shape fixture A (graph surface)', 'bug_fix', 'termdeck-s83-t2-fixture'),
              ($2, 'excluded-shape fixture B (null score)',   'bug_fix', 'termdeck-s83-t2-fixture')`,
      [memIds[0], memIds[1]]
    );
    // rank 1: the graph surface (EXCLUDED_SURFACES). rank 2: a NULL score.
    await pool.query(
      `insert into public.memory_recall_log
         (memory_id, query_hash, score, rank, surface, recall_group_id)
       values ($1, 'fixture-hash', 0.0216, 1, 'graph', $3),
              ($2, 'fixture-hash', null,   2, 'recall', $3)`,
      [memIds[0], memIds[1], groupId]
    );

    const result = await memoryCite(
      { recall_group_id: groupId, ranks: [1, 2] },
      { client: pgAsSupabase(pool) }
    );
    assert.equal(result.ok, true);
    assert.equal(result.cited, 2, 'the RPC cites them — it does not apply fit-platt filters');

    // …but the fit never sees them. This is the gap a fixture built on the
    // wrong surface would hide.
    const census = await fitPlattCensus(pool, groupId);
    assert.equal(census.usable, 0, 'both rows sit outside fit-platt window');
    assert.equal(census.positives, 0, 'so neither can contribute a positive');
  }
);
