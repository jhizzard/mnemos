# Deck B · T4 — Codex adversarial auditor (engram)

**Lane:** T4 (Codex) · You author **no production code**. Out-of-distribution auditor, no shared
context with the Claude lanes. **Reproduce independently; default to FAIL.** A "done + verified"
post is a claim until you confirm it against actual behavior.

## Boot (your runtime has no memory_recall — read directly)

1. `cd /Users/joshuaizzard/Documents/Graciella/engram`
2. Read `~/.claude/CLAUDE.md`, then `docs/sprint-privacy-tags/PLANNING.md` and `STATUS.md`
3. Read this brief. Audit each FIX-LANDED as it lands (before DONE).

## Audit focus (highest-leverage first)

**A1 — RLS-hygiene gate on the function replace (PRIME TARGET).** T1 does a `CREATE OR REPLACE`
of the `SECURITY DEFINER` function `memory_hybrid_search`. Independently verify against the
*actual* migration text:
1. `REVOKE EXECUTE ON FUNCTION public.memory_hybrid_search(<exact 8-arg sig>) FROM PUBLIC;` is
   present **after** the replace — a replace silently re-opens PUBLIC EXECUTE otherwise (privilege
   escalation on a definer function).
2. `SET search_path = public, pg_catalog` (or 019's exact value) is on the function — a missing
   search_path on a SECURITY DEFINER fn is the `0011` shadow-attack vector.
3. The `GRANT EXECUTE … TO <roles>` from 019 is re-issued.
4. The function **input** signature is unchanged (still 8 args) — only the **output** RETURNS
   TABLE gained `privacy_tags`. Confirm no existing returned column was dropped or reordered
   (recall.ts maps results — a reorder is a silent data-corruption bug).
   Confirm T1 based the body on the genuinely-current definition (whichever migration last
   replaced it), not a stale copy that drops later fixes.

**A2 — Filter semantics.** Reproduce T2's filter logic:
- Omitted/empty `include_privacy` → tagged rows are **excluded**, untagged pass. Confirm this is
  truly zero-overhead when omitted (no array scan on the hot path).
- `include_privacy: ['x']` → untagged rows AND rows sharing tag `x` pass; rows tagged only `y` do
  not. Confirm the documented any-overlap-vs-all-of choice matches the tests and the PR doc.
- `(row.privacy_tags ?? [])` degrades safely when the column is absent/null (pre-migration rows).

**A3 — Non-breaking claim.** Confirm existing callers (no `include_privacy`, untagged corpus) get
identical results to pre-PR — the GIN index + column default `array[]::text[]` mean every existing
row is "untagged", so default recalls over untagged data must be unchanged.

**A4 — Tests + build.** `npm run build` (tsc) and `npm test` are green; the tests actually
exercise the exclude-by-default and opt-in paths (not vacuous).

## Discipline

- Post `### [T4-CODEX] <VERB> 2026-MM-DD HH:MM ET — <gist>` (AUDIT-CONCERN / AUDIT-RED /
  CHECKPOINT / FINAL-VERDICT).
- **CHECKPOINT** every phase boundary + every ≤15 min (phase, verified w/ file:line, pending, last
  FIX-LANDED). STATUS.md is your only memory across a compaction.
- `FINAL-VERDICT GREEN` only when A1–A4 hold with file:line evidence; else `RED` with the exact
  failing claim. The RLS gate (A1) is a hard block — RED if any of its four points fails.
