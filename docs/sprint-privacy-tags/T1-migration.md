# Deck B · T1 — Migration 023 (`privacy_tags` column + GIN + RETURNS TABLE extension)

**Lane:** T1 (Claude) · **You own:** `migrations/023_privacy_tags_column.sql` (NEW) only.

## Mission

Author migration 023 to Brad's spec. Three parts: the column, the GIN index, and the
`memory_hybrid_search` RETURNS-TABLE extension (orchestrator decided **yes** on that open Q).
Include a header, a verification block, and a reversal block (Brad's pattern).

## Part 1 — column + index (unambiguous; ship exactly this)

```sql
alter table public.memory_items
  add column if not exists privacy_tags text[] not null default array[]::text[];

create index if not exists memory_items_privacy_tags_gin
  on public.memory_items using gin (privacy_tags);
```

Header must document the **non-conflict with `src/privacy.ts`**: `stripPrivate` strips
`<private>…</private>` at write time; `privacy_tags` are whole-item categorical tags filtered
at query time — orthogonal, coexist on a row with no interaction.

## Part 2 — extend `memory_hybrid_search` RETURNS TABLE — THE CAREFUL PART

The recall-layer JS filter needs `privacy_tags` on each returned row, so add it as an **output
column** (do NOT add a 9th *input* arg — the canonical 8-arg signature stays stable).

**This is a `CREATE OR REPLACE FUNCTION` of a `SECURITY DEFINER` function. RLS-hygiene gate
(global CLAUDE.md § Supabase hygiene) is mandatory and the auditor's prime target:**

1. **Base your CREATE OR REPLACE on the CURRENT definition** — the latest is in
   `migrations/019_security_hardening.sql` (grep there for `memory_hybrid_search`). Copy its
   body verbatim; only **add `privacy_tags text[]` to the `RETURNS TABLE (...)` list and to the
   `SELECT` projection**. Do not drop or reorder existing returned columns (recall.ts maps them
   positionally/by-name — a reorder is a silent breakage).
2. **Preserve every hygiene line** that 019 set on the function:
   - `SET search_path = public, pg_catalog` (or whatever 019 uses — keep it).
   - `REVOKE EXECUTE ON FUNCTION public.memory_hybrid_search(<exact arg sig>) FROM PUBLIC;`
   - the existing `GRANT EXECUTE … TO <roles>` (service_role + whoever 019 granted). Re-issue
     them after the CREATE OR REPLACE — grants don't survive a replace automatically for new
     identity, and a missing REVOKE silently re-opens PUBLIC EXECUTE on a SECURITY DEFINER fn.
3. Keep `security definer` and `language` exactly as 019 has them.

If 019 is not the latest definer of the function, find whichever migration last `CREATE OR
REPLACE`d it (`grep -rl memory_hybrid_search migrations/`) and base on that. State which one
you based on in your FIX-LANDED post.

## Part 3 — verification + reversal blocks

- **Verification** (commented or guarded): assert the column exists with the right type/default,
  the GIN index exists, and `memory_hybrid_search` returns a `privacy_tags` column (e.g. a
  `\d memory_items` note + a one-row `select` proving the new output column).
- **Reversal** (commented): `drop index …; alter table … drop column privacy_tags;` and the note
  that reverting the function means re-applying the 019 definition.

## Discipline

- Post `### [T1] <VERB> 2026-MM-DD HH:MM ET — <gist>`. In FIX-LANDED, state which migration you
  based the function body on, and confirm REVOKE/GRANT/search_path are all present.
- No version bump, no CHANGELOG.md edit, no commit. DONE = file complete, hygiene gate satisfied.
