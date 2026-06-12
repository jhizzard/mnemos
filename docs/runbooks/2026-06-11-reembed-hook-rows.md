# Runbook — re-embed hook-written rows with the recall-side model

**Script:** `dist/src/reembed-hook-rows.js` (source `src/reembed-hook-rows.ts`)
**Authored:** 2026-06-11 (Sprint 74 T3 scope-add)
**Risk class:** data-only UPDATE of `memory_items.embedding` + `metadata` on a
bounded, provenance-selected row set. No DDL, no content changes, no deletes.

## Purpose

The bundled session-end / pre-compact hooks embed their rows with
`text-embedding-3-small`; every recall query embeds with
`text-embedding-3-large` @ 1536 dims (`src/embeddings.ts`). The two models do
not share a vector space, so `session_summary` and `pre_compact_snapshot` rows
rank on the keyword (FTS) leg of `memory_hybrid_search` only — their semantic
similarity is noise. This backfill re-embeds exactly those rows with the SAME
`generateEmbedding` function the recall path uses, restoring the semantic leg.

Affected set at authoring time: **544 active rows** (411 `session_summary` +
133 `pre_compact_snapshot`), ~7.2% of the active store. Estimated embedding
spend: well under $1.

## Why selection-by-source_type is exact

Each affected `source_type` has exactly one writer ever:

- the bundled hooks are the sole emitters of both types (the MCP
  `memory_remember` enum excludes them; `summarize.ts` writes `fact`);
- the pre-Mnestra personal hook wrote `fact` rows **with 3-large** (verified
  in the predecessor repo), so historical fact rows are clean;
- every bundled-hook generation back through the oldest on-disk backup
  (2026-05-02) embeds 3-small, matching the earliest active
  `session_summary` row exactly.

No vector-derived discrimination exists (both models land 1536-dim unit-norm
vectors) and rows carry no model marker until this script stamps one.

## Safety properties

| Property | Mechanism |
|---|---|
| Dry-run by default | Without `--execute` the script is read-only: counts, sample ids, batch plan. |
| Idempotent / resumable | `metadata.embedding_model = 'text-embedding-3-large@1536'` is stamped in the SAME update as the new vector; selection excludes stamped rows. Abort anytime; re-run continues. |
| Recency unaffected | `content` and `created_at` are never touched (`memory_hybrid_search` decay reads `created_at`). `updated_at` is bumped (the row was modified). |
| Metadata preserved | Spread-merge over the SELECTed metadata — never a blind jsonb replace. |
| No hot-loop on failure | A batch where every embed fails aborts the run; failed rows stay unstamped and are retried next run. Exit code 1 signals skipped rows. |
| Recall-parity scope | Default selection mirrors the recall candidate filter (`is_active AND NOT archived`); archived rows are invisible to recall and skipped (`--include-archived` exists if ever needed). |

## Preconditions

1. Node ≥ 18.17, repo built: `npm run build` (script ships in `dist/` after tsc).
2. Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (always);
   `OPENAI_API_KEY` (only with `--execute`). Same trio `mnestra serve` uses.
3. **Sequencing with the hook-side fix:** the hooks keep writing 3-small rows
   until the bundled-hook model flip ships (tracked in the companion sprint's
   hook diff — flip `embedText` to `model:'text-embedding-3-large',
   dimensions:1536`; the `dimensions` param is load-bearing, 3-large is
   natively 3072-dim and would fail the `vector(1536)` insert without it).
   The marker makes this script safe to run before or after that flip, but
   the **authoritative final pass runs AFTER the flip lands** — earlier
   passes are optional warm-ups; re-runs are cheap no-ops on stamped rows.

## Procedure

```bash
cd ~/Documents/Graciella/engram
npm run build

# 1. Dry-run (read-only): confirm counts match expectations
node dist/src/reembed-hook-rows.js

# 2. First slice (optional belt-and-suspenders): cap at 25 rows, then spot-check
node dist/src/reembed-hook-rows.js --execute --max-rows 25

# 3. Full run
node dist/src/reembed-hook-rows.js --execute

# 4. Re-run until the hook flip has shipped, then one final pass
node dist/src/reembed-hook-rows.js --execute
```

Flags: `--batch-size N` (default 25), `--sleep-ms N` (default 500),
`--max-rows N`, `--project <slug>`, `--include-archived`.

## Verification (read-only SQL)

```sql
-- Remaining unstamped hook rows — expect 0 after the final pass
select source_type, count(*)
  from memory_items
 where source_type in ('session_summary','pre_compact_snapshot')
   and is_active and not archived
   and (metadata->>'embedding_model') is distinct from 'text-embedding-3-large@1536'
 group by 1;

-- Stamped rows — expect the affected-set count (544 at authoring time)
select count(*)
  from memory_items
 where metadata->>'embedding_model' = 'text-embedding-3-large@1536';
```

Functional spot-check: pick a recent checkpoint row, query `memory_recall`
with a PARAPHRASE of its content (no shared keywords) and confirm it now
surfaces; before the backfill it could rank arbitrarily.

## Rollback stance

There is nothing to roll back **to**: the prior vectors are the defect (wrong
model space), and they are overwritten in place. Risk is bounded because
`content`, `created_at`, provenance columns, and row identity are untouched —
the worst case of a bad run is "some rows re-embedded twice," which is
harmless. Abort anytime; the marker keeps completed work.
