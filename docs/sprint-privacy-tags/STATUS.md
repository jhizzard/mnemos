# Mnestra `privacy_tags` PR (Deck B) — STATUS

3+1+1. Migration 023 + GIN · recall.ts `include_privacy[]` filter + MCP field · tests + PR doc · Codex auditor.

<!--
POST SHAPE (mandatory, every lane): ### [Tn] <VERB> 2026-MM-DD HH:MM ET — <gist>
  VERB ∈ FINDING / FIX-PROPOSED / FIX-LANDED / DONE                (T1/T2/T3)
  VERB ∈ AUDIT-CONCERN / AUDIT-RED / CHECKPOINT / FINAL-VERDICT     (T4-CODEX)
The "### " prefix is REQUIRED on every post. Idle-poll with the tolerant regex ^(### )?\[Tn\] DONE\b.
Example:  ### [T1] FIX-LANDED 2026-06-07 19:10 ET — 023 adds column+GIN; memory_hybrid_search RETURNS TABLE extended, REVOKE/GRANT/search_path preserved
-->

## Orchestrator log

- **2026-06-07 ~18:30 ET** — Deck B injected by fresh orchestrator session. Panel map (createdAt
  order, :3001): T1 `847c7d8b` · T2 `e7d63ea0` · T3 `a6c6b320` · T4-CODEX `1531c575`. Repo = engram,
  migration 023 confirmed free (last is 022). Open-Q #1 decided **YES** (extend
  `memory_hybrid_search` RETURNS TABLE). All work stays in the engram repo.

## T1 — Migration 023 (column + GIN + RETURNS TABLE extension)

### [T1] FINDING 2026-06-07 18:47 ET — three load-bearing facts before I author 023 (T4: A1 audit targets)

Read 002/004/005/014/019 to reconstruct the **current** state of `memory_hybrid_search`. Three
corrections to the brief's framing — all material to the hygiene gate:

1. **The function is `SECURITY INVOKER`, NOT `SECURITY DEFINER`.** 002 + 004 both declare it
   `language sql stable` with no `security definer`; 019 never added it (019 only `REVOKE`s +
   `ALTER … SET search_path` via a signature-agnostic DO-block — it does **not** redefine the body).
   The brief's "CREATE OR REPLACE of a SECURITY DEFINER function" is inaccurate. Per global rule
   *"security definer — only if truly needed; default to invoker"*, I am **preserving INVOKER**.
   Making a recall function DEFINER would be a privilege-escalation regression, not hygiene.

2. **Adding `privacy_tags` to RETURNS TABLE requires `DROP FUNCTION` + CREATE, not plain
   CREATE OR REPLACE.** Postgres forbids changing a function's return type (RETURNS TABLE cols =
   OUT params) via REPLACE → it errors `cannot change return type of existing function`. This is
   already documented in-tree: `src/recall.ts:141-143` says source_agent was kept OFF the RPC
   precisely because adding it "would require a DROP+CREATE on the hot RPC." Open-Q#1=YES means we
   now pay that cost deliberately for privacy_tags. I'll use the signature-agnostic drop-all-overloads
   DO-block (same pattern migration 002 uses) → exactly one 8-arg function after.

3. **Because it's DROP+CREATE, the hygiene re-issue is LOAD-BEARING, not cosmetic.** A freshly
   created function inherits EXECUTE for PUBLIC (Postgres default) **plus** anon/authenticated via
   migration 014's `alter default privileges … grant execute … to service_role, authenticated, anon`.
   So without an explicit `REVOKE EXECUTE … FROM public, anon, authenticated` after the CREATE, 023
   would silently re-open hole class #2 that 019 closed. Same for `SET search_path` — DROP+CREATE
   starts `proconfig` empty, so the body MUST carry `set search_path = public, extensions, pg_catalog`
   (extensions required — pgvector `<=>` lives there; the 0.4.4→0.4.6 regression that motivated 019's revision).

**Base for the CREATE:** migration **004** (last full-body redefinition — has the match_count cap)
for the SQL body; **019** for the hygiene attributes (search_path + revoke/grant). privacy_tags
appended **last** in both RETURNS TABLE and the final SELECT (recall.ts maps by-name via PostgREST
JSON, so existing cols are position-independent; appending-last is safe for any positional reader
too). My `not null default array[]::text[]` column means the RPC always returns an array — T2's
`(row.privacy_tags ?? [])` never actually hits the null branch. Authoring now.

### [T1] FIX-LANDED 2026-06-07 18:54 ET — 023 written: column+GIN + memory_hybrid_search RETURNS TABLE extended; REVOKE/GRANT/search_path all present; SECURITY INVOKER preserved

`migrations/023_privacy_tags_column.sql` complete. **T4 A1 audit artifact:**

- **Part 1 — column + index.** `privacy_tags text[] not null default array[]::text[]` (`add column if not
  exists`) + `memory_items_privacy_tags_gin` GIN index (`create index if not exists`). `comment on
  column` documents the src/privacy.ts non-conflict (write-time content strip vs query-time categorical tag).
- **Part 2 — function.** Drop-all-overloads DO-block (signature-agnostic, identical to migration **002**'s
  preamble) → `create or replace function public.memory_hybrid_search`. **Body based on migration 004**
  (last full-body redef; carries match_count cap). `diff` of the `with candidates … limit …` block vs 004
  shows **only 4 added lines** (`m./c./f./s.privacy_tags`) — scoring logic byte-identical, zero behavior drift.
  - **Input signature UNCHANGED** — canonical 8 args (text, vector(1536), int, float, float, int, text, text).
  - **`privacy_tags text[]` appended LAST** in RETURNS TABLE (9th output col) and final SELECT — no existing
    col moved (safe for recall.ts by-name PostgREST mapping AND any positional reader).
- **Hygiene gate — ALL PRESENT (confirmed):**
  - `set search_path = public, extensions, pg_catalog` (function attribute; `extensions` for pgvector `<=>`).
  - `revoke execute on function … from public, anon, authenticated` — **load-bearing**: DROP+CREATE makes a
    new fn that would otherwise inherit EXECUTE from PG default + mig 014's `alter default privileges`.
  - `grant execute on function … to service_role`. Both via a `pg_get_function_identity_arguments`-derived
    DO-block (the 019 idiom) so the `vector` type resolves whether pgvector lives in `extensions` or `public`.
  - `language sql stable` + **SECURITY INVOKER preserved** (no `security definer` in DDL — verified the only
    4 "definer" hits are comment lines 54/56/57/59; making a recall fn DEFINER would be an escalation regression).
- **Part 3 — verification + reversal** blocks (both commented): column type/default, GIN presence, new output
  col smoke-select, `has_function_privilege` for public/anon/authenticated=f & service_role=t, `proconfig`
  assertion; reversal notes the fn revert is one-way (re-apply 004 body + 019 hygiene).
- **Validation:** structural greps pass ($$ balanced=6, 8 in-args, 9 out-cols, revoke/grant/search_path=1/1/1,
  security definer DDL=0); CI `sql-syntax` job (pgvector:pg16 + pre-created roles, applies `migrations/*.sql`
  in order) is the authoritative apply gate at orchestrator commit. Did NOT touch the live DB (file-only lane).
- **T1↔T2 contract honored:** every `memory_hybrid_search` row now carries `privacy_tags text[]`; NOT NULL
  default means it's always a real array, so T2's `(row.privacy_tags ?? [])` is belt-and-suspenders only.

### [T1] DONE 2026-06-07 18:54 ET — migration 023 complete, hygiene gate satisfied; file-only, no version bump / no CHANGELOG / no commit (orchestrator owns close)

## T2 — recall.ts include_privacy filter + MCP tool field

### [T2] FINDING 2026-06-07 18:48 ET — lane mapped; MCP server is `mcp-server/index.ts` (Zod), not `src/mcp-server/*`
- **File-location correction:** the `memory_recall` tool registration lives at repo-root `mcp-server/index.ts:251-305`, NOT `src/mcp-server/*` (the brief's path). It uses the high-level Zod-shape `registerTool` API (SDK converts to JSON Schema on the wire), so I mirror the Zod idiom `z.array(z.string()).optional()` the existing `source_agents` field uses — equivalent to the raw `{type:'array',items:{type:'string'}}` the brief sketched.
- **@T3 — alignment CONFIRMED on all three contract points:** (1) `privacy_tags` ride on the RPC row, read via `(row.privacy_tags ?? [])`, **zero** `from('memory_items')` batch lookups; (2) default-DENY runs unconditionally (even when `include_privacy` omitted), untagged rows always pass; (3) opt-in = **any-overlap** + `include_privacy: []` treated as omitted (mirrors source_agents defensive parse). Your fake client putting `privacy_tags` ON the rpc result is exactly right.
- **Surface:** `RecallInput.include_privacy?: string[]` + `RecallHit.privacy_tags?: string[] | null` (new type touchpoint — RPC genuinely returns the column post-023, so it's a real field add not a cast) in `src/types.ts`; filter in `src/recall.ts` after the source_agent block; Zod field + handler thread-through in `mcp-server/index.ts`.
- **Build/test safety pre-checked:** `tests/recall-source-agent.test.ts` fixtures carry no `privacy_tags` → degrade to untagged → all 11 tests stay green; filter adds zero Supabase calls so `agentSelectCalls` probes unaffected.
- Landing now; FIX-LANDED imminent (T3 is compile-blocked on my `RecallInput` field).

### [T2] FIX-LANDED 2026-06-07 18:50 ET — include_privacy filter + types + MCP field; build green, 70/70 tests pass
**@T3 you are UNBLOCKED** — `RecallInput.include_privacy?: string[]` is in `src/types.ts`; full runtime filter is live. Four edits across three files (RPC arg list untouched — no 9th arg):

1. **`src/types.ts:125-135`** — `RecallInput.include_privacy?: string[]` (matches brief's exact signature; `?`-optional, not nullable — recall.ts parse handles undefined). **`src/types.ts:147-153`** — `RecallHit.privacy_tags?: string[] | null` (real field add: post-023 the RPC genuinely returns this column; `| null` is defensive even though T1's `NOT NULL DEFAULT ARRAY[]::text[]` means the live RPC never sends null — the `?? []` covers the *field-absent* pre-migration case, i.e. recall hitting a DB where 023 isn't applied yet).
2. **`src/recall.ts:113-121`** — parse `includePrivacy` (empty-array-==-omitted, mirrors source_agents at :107-110).
3. **`src/recall.ts:188-206`** — the filter, placed AFTER the source_agent block, BEFORE dedup→rank:
   ```ts
   rows = rows.filter((r) => {
     const tags = r.privacy_tags ?? [];
     if (tags.length === 0) return true;        // untagged: always visible
     if (!includePrivacy) return false;         // default: hide tagged rows
     return tags.some((t) => includePrivacy.includes(t)); // any-overlap opt-in
   });
   ```
   Followed by the standard `if (rows.length === 0) return …` short-circuit (so a query whose only matches are all privacy-tagged + no opt-in correctly yields "No relevant memories found" — the privacy guarantee).
4. **`mcp-server/index.ts:279-290`** — Zod `include_privacy: z.array(z.string()).optional()` sibling to `source_agents`; **:256** tool description amended; **:293-311** handler destructure + thread-through (`include_privacy,` shorthand).

**Verification (my own, this lane):** `npm run build` (tsc) exit 0; `npm test` = **70/70 pass, 0 fail** — the 11 `recall-source-agent` tests stay green (fixtures lack `privacy_tags` → degrade to untagged → all pass; filter fires **zero** `from('memory_items')` calls so the `agentSelectCalls` probes are untouched). Semantics verified against spec: omitted/`[]`→untagged-only; explicit→untagged OR any-overlap; no-op (length-check only) when omitted; applied after source/null filters.

**@T4** — audit targets for A2 (filter semantics): the any-overlap `.some()` at recall.ts:202, the unconditional default-exclude at :201, and the no-9th-RPC-arg invariant (RPC call at recall.ts:120-129 is byte-unchanged). Holding **DONE** briefly for T3 runtime-green + any T4 AUDIT-CONCERN, though my own DONE criteria (filter+type+MCP land, build green, semantics match, file:line cited) are already met.

### [T2] DONE 2026-06-07 18:53 ET — lane closed; T4-audited green + T3 tests pass 75/75
Cleared to close — both independent cross-checks landed:
- **T4-CODEX 18:52 ET Phase 2** verified A2+A3 against my FIX-LANDED (parse at recall.ts:117-120, `(r.privacy_tags ?? [])` + default-exclude + any-overlap at :198-203, no 9th RPC arg — 8 args at :129-138, type/MCP surface at types.ts:127-136/148-155 + mcp-server:285-310). No AUDIT-CONCERN / AUDIT-RED on my lane.
- **T3's `tests/recall-privacy-tags.test.ts`** runs against my filter; T4's `npm test` = **75/75 pass** (my 70 + T3's 5 privacy tests). Runtime-green confirmed by an out-of-lane party, not just self-report.

**Lane deliverable complete:** `include_privacy?: string[]` filter (recall.ts) + `RecallInput`/`RecallHit` types + `memory_recall` MCP field, all green. RPC 8-arg signature untouched.

**One deliberate-design fact for @T3's PR-DESCRIPTION + orchestrator close-out** (full surface audit of the 2nd `memoryRecall` consumer): `src/webhook-server.ts:102-117` (HTTP `recall` op) intentionally does **not** thread `include_privacy` — exact parity with `source_agents`/`include_null_source`, which it also omits (advanced filters are MCP-only; the webhook is a reduced TermDeck-ingest surface). **The privacy guarantee still holds there**: default-exclude lives at the recall.ts layer, so webhook/Flashback recalls auto-hide tagged rows — correct-by-spec and desirable for an unattended proactive-recall path. Only the manual opt-in is MCP-only. PR-DESCRIPTION should state "include_privacy is exposed on the MCP `memory_recall` tool; the HTTP webhook inherits default-exclude but not the opt-in, matching existing filter conventions."

## T3 — tests + PR-DESCRIPTION (CHANGELOG draft)

### [T3] FINDING 2026-06-07 18:46 ET — contract read + test plan anchored
Harness: mirror `tests/recall-source-agent.test.ts` — fake Supabase client + injected
`RecallDeps` ({client, generateEmbedding}), DB-free + deterministic. Three contract points my
tests pin (T2 please confirm alignment; T4 these are the audit targets):
1. **privacy_tags ride on the RPC row, NOT a follow-up batch query.** Open-Q#1=YES means
   migration 023 extends `memory_hybrid_search` RETURNS TABLE, so the filter reads
   `(row.privacy_tags ?? [])` directly. My fake client returns privacy_tags ON the rpc result and
   asserts the privacy path fires **zero** `.from('memory_items')` batch lookups (the N+1 that
   Open-Q#1=YES exists to avoid). This is the key divergence from the source_agent filter.
2. **Default is unconditional default-DENY on any tagged row** — the filter runs even when
   `include_privacy` is omitted (unlike source_agents, which only filters when set). Untagged rows
   (empty array) always pass.
3. **Opt-in = ANY-OVERLAP** (row surfaces iff any of its tags ∈ include_privacy) + untagged rows
   always pass. `include_privacy: []` treated as omitted (mirror source_agents defensive). Any-overlap
   vs all-of is one of Brad's open Qs → PR-DESCRIPTION proposes any-overlap (conservative) for confirm.

NOTE: my test's only **compile** dep is T2 adding `include_privacy?: string[]` to `RecallInput`
(src/types.ts); runtime-green needs T2's recall.ts filter. Authoring now against the contract;
will run full `npm test` + post DONE once T2 posts FIX-LANDED.

### [T3] DONE 2026-06-07 18:55 ET — tests 5/5 + full suite 75/75 (own run); PR-DESCRIPTION complete
**Both deliverables landed, both verified firsthand (not just self-report):**

1. **`tests/recall-privacy-tags.test.ts`** (NEW, 5 deterministic DB-free tests, injected `RecallDeps`):
   - `default (no include_privacy) excludes every tagged row, keeps untagged` — + asserts **0** `.from()` batch lookups (pins Open-Q#1=YES / N+1-avoided).
   - `include_privacy:['secret']` surfaces secret + untagged, drops medical-only.
   - `include_privacy:['medical']` proves **ANY-OVERLAP** (the `['secret','medical']` row surfaces under either tag → distinguishes any-overlap from all-of/fully-covered).
   - `include_privacy:[]` ≡ omitted (defensive, mirrors source_agents:[]).
   - untagged-only corpus invariant (non-breaking guarantee, both with + without opt-in).
   - **My own run:** `npm --prefix … test` → **75/75 pass, 0 fail** (T2's 70 + my 5); all 5 privacy tests confirmed by name. Matches T4-CODEX's independent 18:52 run.

2. **`docs/sprint-privacy-tags/PR-DESCRIPTION.md`** (NEW) — summary, 4-surface change table, filter mechanics (incl. the source_agent-vs-privacy divergence), **non-breaking analysis** (prospective-only behavior change; 8-INPUT-arg signature preserved, only output RETURNS TABLE extended), **CHANGELOG draft** (`### Added`, suggested MINOR→0.5.0; orchestrator applies — I did NOT touch CHANGELOG.md), Brad's **4 open questions** w/ conservative confirm-with-Brad answers, verification, RLS-hygiene gate.

**Reconciliation done:** pulled Brad's 2026-05-18 thread (Gmail `19e54d447be998a3`). Email body confirms the spec; the four open Qs live in his attached `PR-DESCRIPTION.md` which is **not fetchable in-panel** (no Gmail attachment-download tool) → #1 DECIDED YES (orch), #2 any-overlap, #3 stay open-ended + doc-only starter vocab, #4 write-path = follow-up. All flagged confirm-with-Brad.

**Folded in cross-lane facts:** T1's INVOKER-not-DEFINER + DROP+CREATE corrections → *§ Deltas from Brad's original proposal*; T2's webhook-parity note (`include_privacy` is MCP-only; webhook inherits layer-level default-exclude but not the opt-in) → *§ Surface scope*.

No version bump · no `CHANGELOG.md` edit · no commit (orchestrator close-out). Lane T3 closed.

## T4 — Codex auditor

_(awaiting first post)_

### [T4-CODEX] CHECKPOINT 2026-06-07 18:43 ET — Phase 0 boot; no FIX-LANDED yet

- Verified: boot docs read (`~/.claude/CLAUDE.md`, `PLANNING.md`, `STATUS.md`, `T4-codex-auditor.md`); `git status --short` shows only `docs/sprint-privacy-tags/` untracked, so no T1/T2/T3 code or test files are landed yet.
- Pending: A1 migration audit, A2 filter semantics, A3 non-breaking behavior, A4 build/test.
- Last FIX-LANDED: none.

### [T4-CODEX] CHECKPOINT 2026-06-07 18:49 ET — Phase 1 pre-FIX baseline + WIP watch

- Verified: T1/T2/T3 have posted FINDING only; no `FIX-LANDED` yet. Worktree now has T2 WIP in `src/recall.ts`, `src/types.ts`, and `mcp-server/index.ts`.
- Baseline A1 evidence: latest full `memory_hybrid_search` body is migration 004 (`migrations/004_mnestra_match_count_cap_and_explain.sql:21`); migration 019 does not redefine it, but revokes EXECUTE and sets `search_path = public, extensions, pg_catalog` signature-agnostically (`migrations/019_security_hardening.sql:122-123`). Migration 014 default privileges mean a DROP+CREATE can re-grant anon/authenticated unless 023 explicitly revokes (`migrations/014_explicit_grants.sql:36-46`).
- WIP A2 evidence: current T2 WIP reads `row.privacy_tags ?? []`, hides tagged rows by default, and uses any-overlap opt-in at `src/recall.ts:198-202`; this is not a verdict until T2 posts `FIX-LANDED`.
- Pending: A1 migration file, T2 `FIX-LANDED`, T3 tests/PR doc, build/test.
- Last FIX-LANDED: none.

### [T4-CODEX] CHECKPOINT 2026-06-07 18:52 ET — Phase 2 T2 FIX-LANDED audited

- Verified A2/A3 against T2 `FIX-LANDED`: `src/recall.ts:117-120` parses `include_privacy` as opt-in only; `src/recall.ts:198-203` reads `(r.privacy_tags ?? [])`, keeps untagged rows, excludes tagged rows by default, and admits tagged rows by any-overlap only. No 9th RPC arg was added; `memory_hybrid_search` call remains the 8 existing args at `src/recall.ts:129-138`.
- Verified MCP/type surface: `RecallInput.include_privacy?: string[]` at `src/types.ts:127-136`; `RecallHit.privacy_tags?: string[] | null` at `src/types.ts:148-155`; `mcp-server/index.ts:285-310` exposes and threads `include_privacy`.
- Verified tests exercise the contract: `tests/recall-privacy-tags.test.ts:134-149` default excludes tagged rows with zero `.from()` calls, `:152-189` covers opt-in + any-overlap, `:192-205` covers empty array, and `:208-234` covers untagged corpus invariance.
- Verification commands: `npm run build` exit 0; `npm test` first hit sandbox EPERM writing `dist-tests`, then rerun with elevated filesystem permission and passed 75/75.
- Pending: A1 migration audit, T3 PR-DESCRIPTION, final full build/test after all FIX-LANDED.
- Last FIX-LANDED: T2 2026-06-07 18:50 ET.

### [T4-CODEX] CHECKPOINT 2026-06-07 18:56 ET — Phase 3 T1 FIX-LANDED A1 audited

- Verified A1 function-shape gate: `migrations/023_privacy_tags_column.sql:126-148` recreates `public.memory_hybrid_search` with the canonical 8 input args and `privacy_tags text[]` appended as the 9th output column, after the existing `created_at`. Parser check returned `{args:8, outs:9, lastOut:"privacy_tags text[]"}`.
- Verified current-body basis: migration 023 carries the migration 004 search body and threads only `privacy_tags` through the CTEs/final select (`migrations/023_privacy_tags_column.sql:150-255`), preserving existing output order (`id, content, source_type, category, project, metadata, score, created_at`) and appending `s.privacy_tags` last at `:249`.
- Verified hygiene after DROP+CREATE: `set search_path = public, extensions, pg_catalog` is in the function DDL at `migrations/023_privacy_tags_column.sql:148`; post-create DO-block revokes EXECUTE from `public, anon, authenticated` and grants `service_role` at `:262-278`.
- Verified premise correction: baseline migrations 002/004 define this as `language sql stable` without `security definer`, and 019 only revokes/sets search_path. 023 preserves SECURITY INVOKER; no `security definer` DDL is present. This is GREEN because adding DEFINER would be a privilege escalation from the actual baseline.
- Verified schema add: column default/non-null at `migrations/023_privacy_tags_column.sql:83-84`; GIN index at `:92-93`; verification/reversal comments at `:280-323`.
- Pending: T3 `FIX-LANDED`/DONE and final full build/test after all lanes close.
- Last FIX-LANDED: T1 2026-06-07 18:54 ET.

## FINAL-VERDICT

_(T4-CODEX, at close.)_

### [T4-CODEX] FINAL-VERDICT 2026-06-07 18:58 ET — GREEN; A1-A4 pass

- A1 GREEN: `migrations/023_privacy_tags_column.sql` adds the column/index and recreates `memory_hybrid_search` with the 8 input args unchanged and `privacy_tags text[]` appended last to RETURNS TABLE. Existing output columns remain in order. The actual baseline is SECURITY INVOKER, not DEFINER; preserving invoker is correct. Hygiene is present: `set search_path = public, extensions, pg_catalog`, `REVOKE EXECUTE ... FROM public, anon, authenticated`, and `GRANT EXECUTE ... TO service_role`.
- A2 GREEN: T2's filter default-excludes tagged rows, passes untagged rows, uses `(row.privacy_tags ?? [])`, and implements any-overlap opt-in without adding RPC args or batch lookups.
- A3 GREEN: untagged corpora remain invariant; tests cover default, opt-in, empty-array, and untagged-only behavior.
- A4 GREEN: final `npm run build` exit 0; final `npm test` exit 0 with 75/75 passing. `npm test` required elevated filesystem permission in this sandbox to write `dist-tests`; no test failures were observed.
- Remaining note for orchestrator: migration 023 was statically audited, not applied to a live/scratch DB by T4. The migration's own verification block should be run during the release/apply gate.
