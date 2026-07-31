# Deck B · T3 — tests + PR-DESCRIPTION (CHANGELOG draft)

**Lane:** T3 (Claude) · **You own:** a new test file under `tests/` and a new
`docs/sprint-privacy-tags/PR-DESCRIPTION.md`. Do not touch the migration (T1) or recall/MCP
source (T2). **Do not edit `CHANGELOG.md`** — draft its entry inside PR-DESCRIPTION; the
orchestrator applies it at close.

## Mission A — tests (1–2, per Brad's spec)

Engram tests run via `npm test` (`tsc -p tsconfig.tests.json && node --test
'dist-tests/tests/**/*.test.js'`). Match the existing test style (read a sibling `tests/*.test.ts`
for the harness shape, especially any that exercise `memoryRecall` with a mocked/faked
`RecallDeps` so you don't need a live DB).

Cover the `include_privacy` filter contract (this is the behavior most likely to regress):
1. **Default excludes tagged rows.** Given candidate rows where some have non-empty
   `privacy_tags`, `memoryRecall` with no `include_privacy` returns only the untagged ones.
2. **Opt-in surfaces matching tags.** With `include_privacy: ['secret']`, rows tagged `secret`
   (and untagged rows) are returned; rows tagged only `medical` are not.
3. (If cheap) **Omitted filter is a no-op / zero-overhead** and untagged-only corpora are
   unchanged from pre-PR behavior.

Keep tests deterministic and DB-free where the existing harness allows it.

## Mission B — PR-DESCRIPTION.md (Brad's email-with-spec pattern)

Author `docs/sprint-privacy-tags/PR-DESCRIPTION.md` as the reviewable PR writeup for Josh/Brad:
- **Summary** — what changed (migration 023, recall.ts filter, MCP field), why (Brad's pka
  project, F3 architecture decision), non-breaking framing.
- **Files changed** — the migration, `src/recall.ts`, the MCP tool registration, the test file.
- **CHANGELOG draft** — the exact `## [Unreleased]` bullet(s) you propose the orchestrator add
  to engram `CHANGELOG.md` (do not edit the file yourself).
- **Open questions** — Brad listed four; #1 (extend `memory_hybrid_search` RETURNS TABLE) is
  **decided YES** by the orchestrator. For the other three (in Brad's attached `PR-DESCRIPTION.md`,
  which we may not have in-panel): reconstruct the likely decisions a reviewer must make —
  e.g. **any-overlap vs all-of** match semantics for `include_privacy`; whether a **canonical
  starter tag vocabulary** should ship or stay open-ended; whether a **write-path helper** to set
  tags belongs in this PR or a follow-up — and propose a conservative non-breaking answer for each,
  flagged "confirm with Brad." If Josh forwards Brad's attachment, reconcile.
- **Verification** — how to prove it works (the migration verification block + the tests + a
  manual recall before/after).

## Discipline

- Post `### [T3] <VERB> 2026-MM-DD HH:MM ET — <gist>`.
- No version bump, no `CHANGELOG.md` edit, no commit. DONE = tests pass (`npm test` green) and
  PR-DESCRIPTION is complete, file:line/paths cited.
