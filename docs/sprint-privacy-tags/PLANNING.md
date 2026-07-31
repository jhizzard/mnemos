# Mnestra `privacy_tags` PR (Deck B) · 3+1+1

**One-liner:** implement Brad's non-breaking Mnestra schema change — a `privacy_tags text[]`
column on `memory_items` + an `include_privacy[]` recall filter — so tagged-sensitive items
are excluded from recall by default and surfaced only on explicit opt-in. Unblocks Brad's
**pka** (Personal Knowledge Archive) project, which mirrors his ~20-year corpus into
`memory_items` with `project='archive'`.

**Repo:** **engram** (`/Users/joshuaizzard/Documents/Graciella/engram`) — TypeScript, `main`
branch, build = `tsc`, tests = `npm test` (`tsc -p tsconfig.tests.json && node --test`). There
is **no project CLAUDE.md** here; this PLANNING.md is your project context. **All Deck B work
is in this repo** — do not touch the termdeck repo (that's Deck A's concurrent CLI-migration deck).

**Source of truth:** Brad Heath's 2026-05-18 proposal (Gmail thread, subject *"[mnestra schema
PR proposal] privacy_tags column + include_privacy[] recall filter"*). His ready-to-commit
`023_privacy_tags_column.sql` + `PR-DESCRIPTION.md` are attachments on that thread. The spec
below is the authoritative distillation; if Josh forwards the attachments, reconcile against them.

---

## What it adds (Brad's spec, verbatim intent)

- `public.memory_items.privacy_tags text[]` column, **default `ARRAY[]::text[]`** — open-ended
  category tags for sensitive content.
- A **GIN index** on `privacy_tags` (free insurance for a future server-side filter).
- New optional `include_privacy?: string[]` parameter on `RecallInput` + the `memory_recall`
  MCP tool. **Default behavior: EXCLUDE rows that carry any privacy tag.** An explicit
  `include_privacy: ['<tag>', ...]` opt-in surfaces rows tagged with those values.
- Filter implemented at the **`src/recall.ts` layer, NOT inside `memory_hybrid_search`** — to
  keep the canonical **8-input-arg RPC signature stable** (Brad's cited lesson: Sprint 54→56,
  signature drift across packages is expensive). Mirror the existing `source_agent` JS-layer
  filter (recall.ts ~lines 141–180) — same pattern, different column.

**Fully non-breaking:** existing callers that pass no `include_privacy` see *one* behavior
change by design — rows that have privacy tags stop appearing in default recalls. Rows with
the default empty array are unaffected (empty `≠` tagged).

## Orchestrator decision on Brad's open question #1 (the load-bearing one)

> *"Do you want migration 023 to also extend `memory_hybrid_search`'s RETURNS TABLE with
> privacy_tags? I recommended yes."*

**Decided: YES.** The recall-layer JS filter needs `privacy_tags` present on each returned row;
extending RETURNS TABLE (an output-column add, non-breaking) avoids a follow-up N+1 SELECT in
recall.ts. This makes migration 023 a `CREATE OR REPLACE FUNCTION` of `memory_hybrid_search` —
see T1's brief for the **RLS-hygiene gate** that imposes. (Brad's other open questions live in
his `PR-DESCRIPTION.md`; T3 surfaces them with proposed answers for Josh's final review.)

## Non-conflict with `src/privacy.ts` (document in the migration header)

`src/privacy.ts::stripPrivate` strips `<private>…</private>` text blocks at **write time**.
This PR adds whole-item categorical tags filtered at **query time**. **Orthogonal** — both can
be active on the same row with no interaction. Do not conflate them.

---

## Lane map + file ownership (no two lanes touch the same file)

| Lane | Owns (edit only these) | Mission |
|---|---|---|
| **T1** (Claude) | `migrations/023_privacy_tags_column.sql` (NEW) | Column + GIN index + `memory_hybrid_search` RETURNS-TABLE extension + header + verification/reversal blocks |
| **T2** (Claude) | `src/recall.ts` · the `memory_recall` tool registration in `src/mcp-server/*` | `include_privacy[]` filter (mirror source_agent pattern) + `RecallInput` field + MCP tool inputSchema field |
| **T3** (Claude) | `tests/*` (NEW test file) · `docs/sprint-privacy-tags/PR-DESCRIPTION.md` (NEW) | 1–2 tests + draft CHANGELOG entry + author the PR writeup reconciling Brad's spec + open questions |
| **T4** (Codex) | nothing — auditor | Adversarial reproduction; RLS-hygiene gate is the prime target |

**T1↔T2 contract:** after T1, every row from `memory_hybrid_search` carries
`privacy_tags text[]`. T2 codes its filter as `(row.privacy_tags ?? [])` and can start against
this contract before T1 lands. **CHANGELOG.md is orchestrator-owned at close** — T3 *drafts* the
entry inside `PR-DESCRIPTION.md`; nobody edits `CHANGELOG.md` directly.

## Boot sequence (each lane ran this from inject)

1. `cd /Users/joshuaizzard/Documents/Graciella/engram`
2. `memory_recall(query="Mnestra privacy_tags recall filter source_agent JS-layer Brad pka")`
   *(Codex T4: memory_recall not wired in your runtime — skip, read docs directly.)*
3. `memory_recall(query="Supabase RLS SECURITY DEFINER REVOKE EXECUTE search_path memory_hybrid_search")`
4. Read `~/.claude/CLAUDE.md`, then this `PLANNING.md`
5. Read `STATUS.md`
6. Read your `T<n>-*.md` brief

## Lane discipline (MANDATORY — identical shape, all lanes)

- **Post shape:** `### [T<n>] <VERB> 2026-MM-DD HH:MM ET — <gist>` (`### ` prefix required).
  - T1/T2/T3 VERB ∈ `FINDING` / `FIX-PROPOSED` / `FIX-LANDED` / `DONE`
  - T4 VERB ∈ `AUDIT-CONCERN` / `AUDIT-RED` / `CHECKPOINT` / `FINAL-VERDICT`
- **T4 CHECKPOINT** at every phase boundary + every ≤15 min (phase, verified w/ file:line,
  pending, last FIX-LANDED). STATUS.md is your only memory across a compaction.
- Idle-poll tolerant regex `^(### )?\[T<n>\] DONE\b`.
- **No package-version bump, no CHANGELOG.md edit, no commit, no push.** Deliverable is the PR
  artifacts (files); the orchestrator runs close-out and Josh decides email-spec vs real GitHub PR.
