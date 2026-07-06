## [0.9.0] - 2026-07-05

### Added — recall→reinjection provenance + recall-usage boost (Sprint 81 T1)
- **Migration `031_recall_provenance.sql`**: extends Sprint-78's `memory_recall_log` (does NOT fork it) with nullable `source_type` (per returned memory), `token_budget` (per recall call), and `recall_group_id` (one UUID per recall — groups a recall's K hit-rows into a single "reinjection event") + a `recall_group_id` index. `log_recall_hits(jsonb)` recordset/INSERT extended to carry the three fields (batched denorm `recall_count`/`last_recalled_at` bump preserved verbatim); OID-form five-gate receipt.
- **G2 trusted-producer provenance**: `recall_log.ts` resolves `source_session_id`/`source_agent` from explicit caller context (webhook wins) else from `process.env.MNESTRA_SESSION_ID`/`MNESTRA_SOURCE_AGENT` (set by TermDeck at panel spawn), applied at the single `logRecallHits()` choke point so ALL five recall surfaces (recall/search/index/timeline/graph) inherit it. This is what makes "which panel pulled which memory" non-NULL and unspoofable on the primary MCP-stdio path.
- **Migration `032_recall_boost.sql`**: `memory_items.recall_boost numeric NOT NULL DEFAULT 1.0` + `set_recall_boost(jsonb)` service-role RPC (batched, clamp `[1.0, 2.0]`, doctrine-clean) + a bounded multiplicative factor in `memory_hybrid_search` that is a **strict no-op at 1.0** (ranking unchanged for every row until Rumen's reinforce loop populates the column; pruning moratorium honored).

### Changed
- **Migration `030_precompact_rolling.sql`** (the Sprint-80-deferred coupled unit): keep-NEWEST-per-session reversible collapse of active `pre_compact_snapshot` dups + `ingest_capture`'s pre_compact branch redefined **arbiter-free** (`pg_advisory_xact_lock` + select-active→update-in-place-else-insert, NO `ON CONFLICT` on the still-deferred index) so the bundled pre-compact hook can adopt `ingest_capture` without a 42P10; content_hash branch byte-identical to 028. The precompact rolling-unique index stays commented — ORCH creates it LAST, after the live hook is refreshed to `ingest_capture`.
- **Receipt-idiom OID sweep**: the three text-signature `has_function_privilege(role, '<sig>', …)` receipt blocks in `026`/`027`/`028` rewritten to the portable OID form (029's pattern; dodges the Supabase named-args `invalid type name` trap on fresh-install/CI replay). Receipt-only — zero DDL/backfill change.

### Fixed
- Stale `tests/migration-028-hygiene.test.ts` assertion (required the deferred precompact index inside 028) now expects it DEFERRED to 030 — the sole pre-Sprint-81 engram test red.

### Notes
- Sprint 81 T1, FINAL-VERDICT green on code/tests (T7 Codex auditor); live-landedness applied by ORCH at close-out. `npm test` **292/292**, `tsc` clean, gitleaks 0. Migrations 030/031/032 apply after 023–029; the 026/027/028 receipt edits matter only on fresh-install/CI replay (idempotent to re-apply). Companions: `@jhizzard/rumen@0.8.0` + `@jhizzard/termdeck@1.14.0` + `@jhizzard/termdeck-stack@1.12.0`.

## [0.8.1] - 2026-07-05

### Fixed (post-0.8.0 hotfix — 028/029 broke fresh installs + CI)
- **Migration 028 aborted on every fresh install / CI replay** with `[028] RLS REGRESSION`. Its receipt hard-asserted RLS enabled on `memory_items`/`memory_relationships`, but RLS on those tables was enabled **out-of-band** on the daily-driver and is **never enabled by the migration chain** — so a fresh DB has it OFF and 028 aborted. 028 now **enables RLS idempotently** on both tables (new §6b) before the check — fixing the abort AND closing a real hole (fresh Mnestra installs shipped with RLS OFF on the memory tables; `service_role` bypasses RLS, anon/authenticated are now correctly denied). Also **defers the `pre_compact_snapshot` rolling-unique index to Sprint 80** (migration 030): it must ship with the pre-compact hook's `ingest_capture` adoption — creating it earlier breaks the append-per-compaction hook's next insert and can't apply on a store with accumulated snapshots.
- **Migration 029 receipt failed on Supabase's Postgres.** The five-gate receipt built a signature via `pg_get_function_identity_arguments` (which returns arg **names** on some Postgres builds) and passed it to `has_function_privilege`'s text form → `invalid type name "query_text text"`. Now uses the function **OID**. The doctrine ×1.5 type-weight + 365-day decay boost is unchanged.
- No functional change to 028's columns/RPC/constraints or 029's ranking; both verified re-applying idempotently to the live store and via a psql-path client.

## [0.8.0] - 2026-07-05

### Added
- **Capture gates + reinforcement-as-signal** (Sprint 79 T1). Migration `028_capture_gates.sql`: `reinforcement_count`/`sprint_ref`/`rule_ref` on `memory_items` (all `ADD COLUMN IF NOT EXISTS`; the generated `content_hash` column is added replay-safe so a clean `001→028` chain no longer fails), partial-unique-active index on `content_hash`, a reversible dup-collapse backfill (keep-oldest, sum `reinforcement_count`, supersede — never DELETE), and an `ingest_capture(jsonb)` RPC (both ON CONFLICT paths, five-gate). Dedup rewrite in `remember.ts`: the 0.88–0.95 band now **merges, not clobbers** — increments `reinforcement_count`, shallow-merges metadata, appends `metadata.reinforcements[]` (cap 10), keep-canonical unless `refresh:true`, cross-project second pass for kitchen rows, rejected-restatement hash+length audit. MCP `memory_remember` inputSchema + webhook parity expanded with `metadata`/`source_agent`/`sprint_ref`/`rule_ref`/`supersedes`/`force`; `rule_ref` auto-creates an `amends_rule` link edge. New `src/granularity.ts` regex classifier + `recall.ts` TYPE_RANK downweight for `granularity='recipe'`. `mnestra_capture_health` view (`security_invoker=true`, explicit revoke/grant hygiene).
- Migration `029_doctrine_recall_boost.sql`: `memory_hybrid_search` gains a `doctrine` ×1.5 type-weight + a 365-day decay tier (byte-identical signature/returns to migration 023; only the two `doctrine` arms added; overload-drop guard + search_path + grants retained).
- `relationship_type` CHECK + `RELATIONSHIP_TYPES` + MCP enum extended with `elevated_to` (doctrine flow-back edges) and `amends_rule` (028 is the single writer of that constraint).

### Notes
- Sprint 79 T1, FINAL-VERDICT GREEN on code/tests (Codex auditor); live-landedness pending ORCH migration apply. `npm test` **257/257**, `tsc` clean, gitleaks 0. Migrations 028/029 **NOT yet applied to any prod DB** — operator step (hard-failing five-gate receipts verify at apply time). Companions: `@jhizzard/rumen@0.7.0` (doctrine-scan) + `@jhizzard/termdeck@1.13.0` (materialize/ratify).

## [0.7.0] - 2026-06-13

### Added
- **Recall-hit telemetry** (migration `027_recall_telemetry.sql`) — `memory_recall_log` table + `log_recall_hits(jsonb)` / `mark_recall_feedback(jsonb,text)` / `purge_recall_log(int)` RPCs (all five-gate: RLS enabled, no PUBLIC, REVOKE-then-GRANT service_role, pinned `search_path`, hard-failing apply receipt) + denormalized `recall_count` / `last_recalled_at` on `memory_items` (statement-level bumps, no hot-row storms) + 90-day pg_cron purge. **Fire-and-forget** (never awaited — recall latency unchanged) write points in `recall.ts` (returned-set only, not over-fetched candidates), `search.ts`, `layered.ts`, `recall_graph.ts`, and webhook surface tagging; `memory_get` marks `cited=true`; new `op:'feedback'` webhook op. `query_preview` is gitleaks-shape redacted (incl. `Bearer <token>`). This is the substrate that makes "which stored memory is never recalled" computable (Sprint 78 T3).

### Security / Changed
- **Webhook hardening (item zero):** shared-secret gate (read from `~/.termdeck/secrets.env`; `x-mnestra-secret` or `Authorization: Bearer`; constant-time compare; **fail-CLOSED** when the secret is absent) enforced before every op except `/healthz`; default bind **127.0.0.1** (`MNESTRA_WEBHOOK_HOST` override, with an `''`→loopback guard). Previously the `:37778` webhook was unauthenticated and bound all interfaces — a remote memory-poisoning endpoint on a second machine.
- **Telemetry test-isolation:** `MNESTRA_DISABLE_RECALL_LOG=1` (set by the test script) prevents the fire-and-forget recall-log writes from reaching a live DB in a credentialed shell — without it, `npm test` would poison `memory_recall_log` the instant migration 027 is applied.

### Notes
- Sprint 78 T3, FINAL-VERDICT GREEN (Codex auditor) after an adversarial self-review hardening pass. `npm test` **219/219, 0 fail**; `tsc` exit 0; gitleaks 0; migration 027 five-gate receipt execution-verified by rollback-apply. Companions: `@jhizzard/termdeck@1.11.0` + `@jhizzard/termdeck-stack@1.9.0` (doctrine registry + advisor MVP). **Migration 027 NOT yet applied to any prod DB** — operator step (the hard-failing receipt verifies all five gates at apply time).

## [0.6.0] - 2026-06-12

### Added
- Migration `026_memory_inbox.sql` — quarantined web-chat proposal table + SECURITY DEFINER `memory_propose` RPC. All five RLS hygiene gates with a hard-failing apply-time receipt; status/consistency CHECKs; FK to memory_items; partial pending index. Pending rows are unreachable from every recall surface (16 TS surfaces + 8 SQL functions inventoried; falsified end-to-end with sentinel rows — zero leakage).
- Webhook `propose` op + types threading source_agent (web-surface values only).

### Notes
- Sprint 76, FINAL-VERDICT GREEN (Grok auditor). Suite 167/167. Migration 026 is apply-ready but NOT applied to any production DB at release — application + propose activation are operator decisions. Companion: @jhizzard/termdeck@1.10.0 (bridge memory_propose tool, dark-gated), @jhizzard/rumen (promotion pass).

## [0.5.0] - 2026-06-11

### Added
- Four web-surface `source_agents` values — `claude-web`, `chatgpt-web`, `grok-web`, `gemini-web` — across the full enforcement inventory (TS type + const, MCP Zod enum, recall filter, fixtures); migration `025_source_agent_web_surfaces.sql` (comment + verify; deliberately no CHECK constraint — column stays advisory text per the established taxonomy pattern). Only `grok-web` has a live producer today; the other three are forward declarations for the web-chat memory-inbox work.
- Webhook write path now accepts and threads `source_agent` (`RememberInput` → dispatch → insert) — hook-written rows no longer land NULL.
- `src/db-endpoint.ts` — DATABASE_URL endpoint classifier (direct IPv6-only `db.<ref>` vs IPv4 pooler shapes) + validate-and-warn at ingress + doctor probe 5; 29 URL-shape tests.
- `src/reembed-hook-rows.ts` — batched, idempotent, resumable re-embed backfill for 3-small-embedded hook rows (marker: `metadata.embedding_model`), with runbook under `docs/runbooks/`. Live dry-run counted 545 pending rows.

### Notes
- Sprint 74 verdict (Grok auditor, FINAL-VERDICT GREEN): no read-after-write staleness anywhere — all auto-capture writers are synchronous embed→insert→commit and the bridge read path is cache-free; the only systemic lag is Rumen's by-design 15-min insight cycle. Clears the field-deployment cutover gate.
- Run the re-embed backfill only AFTER the companion termdeck v1.9.0 hooks (session-end v5 / pre-compact v2, embed `text-embedding-3-large@1536`) are installed, or new mismatched rows keep arriving behind it.
- Suite 128/128 over the merged sprint tree.

# Changelog

All notable changes to Mnestra will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added — `privacy_tags` column + `include_privacy[]` recall filter (Brad's pka prerequisite)

External request (Brad Heath, 2026-05-18): a non-breaking Mnestra schema change for the pka
(Personal Knowledge Archive) project's F3 decision — exclude tagged-sensitive items from default
recall, surface them only on explicit opt-in.

- **Migration `023_privacy_tags_column.sql`** — adds `public.memory_items.privacy_tags text[] not
  null default array[]::text[]` (open-ended categorical tags for sensitive content) + a GIN index on
  the column. Re-creates `memory_hybrid_search` with `privacy_tags` appended to its RETURNS TABLE so
  the recall layer can filter without a follow-up SELECT. The 8-input-arg RPC signature is unchanged;
  the function is re-created via DROP+CREATE (Postgres forbids changing a return type via REPLACE),
  preserving `SECURITY INVOKER`, `set search_path = public, extensions, pg_catalog`, and the
  `REVOKE EXECUTE … FROM public, anon, authenticated` + targeted service-role `GRANT` hygiene from migration 019.
- **`include_privacy?: string[]` recall filter** (`src/recall.ts`, `RecallInput`, `RecallHit`,
  `memory_recall` MCP tool) — rows carrying any `privacy_tags` are excluded from recall by default;
  an explicit `include_privacy: ['<tag>', …]` opts matching rows back in (any-overlap). Untagged rows
  (the default empty array) are unaffected. Mirrors the Sprint 50 `source_agents` JS-layer filter,
  reading `privacy_tags` directly off each RPC row (no follow-up SELECT / N+1).

Non-breaking: every pre-existing row carries the empty-array default, so recall output is identical
immediately post-migration. The exclude-by-default behavior is prospective — it applies only once a
writer sets tags on a row.

### Planned
- Web viewer UI for browsing memories (port 37777), matching the shape `claude-mem` ships.
- Claude Code lifecycle-hooks capture path — auto-ingest tool usage without a client call.
- `mnestra doctor` subcommand — runs `select 1 from memory_items limit 0` (catches GRANT issues), an embedding ping, and an RPC probe; prints a green/red checklist. (Brad's third upstream suggestion 2026-04-28; deferred from 0.3.2.)
- Trust-weighted recall (Path B from `docs/MULTI-AGENT-MEMORY-ARCHITECTURE.md` § Deliverable 2): `trust` JSONB param on `memory_recall` mapping agent → weight so mixed-agent recalls rank Claude rows higher rather than excluding the others. Deferred — Path A (filter) shipped first; revisit after live use exposes whether weights would improve outcomes.

## [0.4.9] - 2026-05-08

> **Sprint 62 — Mnestra session-end coverage gap.** 3+1+1 with Codex auditor; ~80 min from inject (20:34 ET) to FINAL-VERDICT GREEN (21:54 ET). T4-CODEX caught and routed 9 audit concerns (8 resolved in flight; 1 RED block on T1 cleared in re-audit). This release **bundles the 0.4.8 ws-polyfill that was queued earlier the same day** with the Sprint 62 work; single ship for Brad's Node 20 P1 + the migration + recall additions. Version 0.4.8 was staged but never published — rolled into 0.4.9 to keep the publish wave to a single bump. **Pre-publish fold-in 2026-05-11:** EADDRINUSE singleton-collision catch in `webhook-server` (Brad's 2026-05-11 r730 report — 42,426 crashes over 5d 7h from a single uncaught listen failure).

### Fixed — Webhook server EADDRINUSE catch — no more 5/min crash storm on double-spawn

External operator report (Brad Heath, R730 / Nacho Money LLC, 2026-05-11): `mnestra serve` had no `'error'` handler attached to its HTTP `Server` instance before `server.listen()`. When a fresh `mnestra serve` was spawned while a prior singleton already held port 37778, the synchronous EADDRINUSE error went uncaught, the `Server` instance emitted `'error'` with no listener, and node aborted with the full stack trace. On Brad's box a stale singleton (PID 1420909, bound since 2026-05-05 18:45 UTC) had survived across days while every fresh Claude-MCP autostart crashed on bind — **42,426 crashes over 5 days, log inflated to 21 MB / 509,114 lines (~83% pure stack trace)**.

Fix (`src/webhook-server.ts:308`): attach `server.on('error', …)` BEFORE `server.listen()`. On `EADDRINUSE` emit a single friendly stderr line (`[mnestra-webhook] port ${port} already bound — another \`mnestra serve\` is running. Exiting 0.`) and `process.exit(0)` so MCP-startup logs aren't full of red. Other error codes re-throw to preserve the prior fail-loud semantics for unexpected failure modes.

This is the minimum patch. Brad's full ask list (pre-listen singleton probe / pidfile, log rotation, attach-to-existing on autostart) is queued for the next Mnestra release alongside TermDeck Sprint 63 = Wave 2.

### Fixed — Node <22 WebSocket polyfill — `RealtimeClient` constructor failure on Node 18/20 LTS

External operator report (Brad Heath, Nacho Money LLC, 2026-05-08): every `memory_*` MCP call on Node 20 LTS fails at `RealtimeClient` constructor time with the verbatim error:

> `Error: Node.js 20 detected without native WebSocket support.`
>
> Suggested solution: For Node.js < 22, install `ws` package and provide it via the transport option:
> ```ts
> import ws from "ws";
> new RealtimeClient(url, { transport: ws });
> ```

Root cause: `@supabase/realtime-js` (transitive dependency of `@supabase/supabase-js`) requires a global `WebSocket` constructor. Node ≥22 ships native `WebSocket`; Node 18/20 LTS do not. Mnestra's Supabase client factory (`src/db.ts`) didn't supply a transport, so the constructor threw before any network I/O. The data layer (REST, webhooks, pgvector store) was unaffected — only the Realtime/MCP surface was dead. Brad worked around it for two days by reading the on-disk memory substrate directly and queueing writes to `MNESTRA_PENDING_NOTE.md` files.

Fix (`src/db.ts`): detect Node version at runtime via `globalThis.WebSocket` presence. On Node ≥22 leave `realtime` unconfigured (native path). On Node <22 lazy-load `ws` via `createRequire(import.meta.url)` and pass it through `realtime.transport`. If `ws` is missing on Node <22, log a single warning pointing to `npm install -g ws` and continue (Realtime still dead, but the rest of the client works — better than the prior hard-throw).

`ws` is declared as `optionalDependency`, not `dependency`: Node ≥22 operators don't pay the install cost, and `npm install --no-optional` flows still succeed on Node <22 (with the documented warning). `@types/ws` lands in `devDependencies` for the build.

### Added — Migration `021_project_tag_canonicalize_claimguard.sql` — finishes Sprint 21 T2 rename

Sprint 62 T2. Same project tagged three ways across history split filtered recall: `claimguard` 32 rows + `gorgias` 541 rows + `gorgias-ticket-monitor` 245 rows = 818 total, but `memory_recall(project="claimguard")` reached only the 32 newest. Sprint 21 T2's planned rename was scoped-out and never landed; migration `012_project_tag_re_taxonomy.sql:19-25` documented the deferral.

Migration `021_project_tag_canonicalize_claimguard.sql` does a single-statement project-column UPDATE wrapped in BEGIN/COMMIT with BEFORE/AFTER audit DO blocks and a post-update conservation check that `RAISE EXCEPTION`s if any legacy tag survives. Idempotent: re-apply affects 0 rows.

Verified live against the reference Mnestra project: post-apply `[{"project":"claimguard","n":818}]` (legacy tags zero); conservation exact (32+541+245=818); `memory_recall(project="claimguard")` returns the full historical corpus across the eras (Master Execution Plan 2026-03-12, ownership lock 2026-04-23, HBC-CRC architectural North Star 2026-04-26, Diagnostic Adversarial Orchestrator Suite 2026-05-07).

T4-CODEX live-rollback audit AUDIT-OK at 20:40 ET; integrated AUDIT-OK at 20:57 ET after T2 unblocked the loader-precedence regression. The previously-deferred ClaimGuard project-tag invariant test (`tests/project-tag-invariant.test.js`) is un-deferred and now passes.

### Added — Migration `022_source_agent_backfill.sql` — predicate-based historical `source_agent` backfill

Sprint 62 T3. Sprint 50 introduced `source_agent`. `memory_recall(source_agents=...)` silently excludes NULL-source rows per its own docstring contract. Empirical survey via T3 sampling: **6,381 of 6,483 rows (~98% of corpus)** had NULL source_agent; filtered recall was blind to the entire pre-Sprint-50 history — far above the SOURCE-BRIEF's "3,000+" estimate.

Three predicate-based backfills using row-shape attribution (T3's 20:48 finding showed marker-based predicates would have falsely tagged Claude rows describing other agents):

- **A** — NULL + decision/bug_fix/architecture/preference/code_context (560 rows) → `'claude'`. Architectural lock: pre-Sprint-50 only Claude shipped a `memory_remember` client; Codex/Gemini/Grok wiring landed Sprint 51+.
- **B** — NULL + fact + `source_session_id IS NOT NULL` (4,587 rows) → `'claude'`. Schema fingerprint: source_session_id is the Claude SessionEnd hook's UUID — identical shape to existing claude/session_summary tagged rows.
- **D** — NULL + document_chunk (951 rows) → `'orchestrator'`. Structural fingerprint: 951/951 rows carry `source_file_path` + `chunkIndex`/`heading` metadata — unmistakable rag-system batch-chunker output.

**Predicate C deliberately NOT applied** per T4-CODEX's 20:43 provenance-preservation concern: 283 rows of fact-without-session-without-path. No architectural/schema lock that PREVENTS non-Claude origin (manual psql, non-MCP REST, early rag-extractor variant). Migration `015_source_agent.sql:24-30`'s "no clean single-agent attribution" bright line preserved.

Post-apply (BEGIN/ROLLBACK live verification): residual NULL = 283 / 6,483 = **4.36%** — under the < 5% acceptance target.

### Added — `include_null_source` flag in `memory_recall`

Sprint 62 T3 optional surface, T4-recommended. New `include_null_source: boolean` field on `RecallInput`, default `false` (preserves Sprint 50 silent-drop semantics). When `true`, NULL-source rows are returned even when `source_agents=[...]` is supplied — opens a path to recover the deliberately-preserved 283 fact rows from migration 022 Predicate C.

Implementation: `src/types.ts:114-126` adds the field; `src/recall.ts:111` parses it; `:166-172` updates the filter branch (`if (!agent) return includeNullSource;`). MCP wrapper `mcp-server/index.ts:280-285` adds the zod schema entry; `:292-298` forwards through to `memoryRecall`. Three new tests at `tests/recall-source-agent.test.ts:225-280` exercise true / explicit-false / no-filter cases.

### Verification

- `npm test`: **70/70 pass** (was 67/67 baseline; +3 new include_null_source tests). Build green.
- Live DB after 021 apply: `claimguard=818` rows, legacy tags zero, conservation exact.
- 022 verified via BEGIN/ROLLBACK only (T3's discipline). Will apply on first `termdeck init --mnestra` post-publish via the Sprint 61 migration tracker; or operator can apply directly via `psql -f migrations/022_source_agent_backfill.sql`.

### Upgrade path

- `npm install -g @jhizzard/mnestra@latest`
- On Node 20 LTS: confirm `ws` was picked up by the optionalDeps install (`npm ls -g ws`); if missing, `npm install -g ws` explicitly.
- On Node ≥22 LTS: nothing extra; native `WebSocket` is used.
- For 022: new TermDeck installs running `termdeck init --mnestra` after `@jhizzard/termdeck@1.1.1` ships will auto-apply 022 via the migration tracker. Existing installs can apply manually: `psql "$SUPABASE_DB_URL" -f migrations/022_source_agent_backfill.sql`. Idempotent.

### What's NOT changed

- Existing `memory_recall` default semantics — `include_null_source` defaults to `false`.
- Predicate C residual (283 rows) — provenance uncertainty intentionally preserved per migration 015's bright line.
- service_role keeps full EXECUTE on every Mnestra function.
- Existing 0.4.6/0.4.7 RPC behavior unchanged.
- The `optionalDependencies` declaration is purely additive — operators who don't need `ws` (Node ≥22) see no behavior change.

## [0.4.6] - 2026-05-06

### Fixed — `019_security_hardening.sql` revised: search_path now includes `extensions`; idempotent across schema generations

**Two corrections to the migration that shipped in 0.4.4 / 0.4.5.** Both surfaced by a single afternoon's field reports — a regression on the reference Mnestra project (semantic recall broken) and a divergence on three external operator installs (migration aborted mid-run on older schema generation). Re-run `019_security_hardening.sql` on existing installs to pick up the fixes; safe to re-run, it's now fully idempotent.

#### A. `search_path` now includes `extensions` (fixes broken vector ops)

The 0.4.4/0.4.5 version set `search_path = public, pg_catalog` on the six `memory_*` RPCs. Supabase ≥ 2024 installs pgvector in the `extensions` schema, so the `<=>` cosine-distance operator became unreachable from those RPCs after the alter — semantic recall fails with `operator does not exist: extensions.vector <=> extensions.vector`. Confirmed live against the reference Mnestra project on 2026-05-06; an external Mnestra-consuming app (a WhatsApp-based dispatch tool for a music festival) reported the regression within hours of 0.4.5 shipping.

Fix: `set search_path = public, extensions, pg_catalog` on every `memory_*` and `mnestra_doctor_*` function. The doctor functions don't use vector ops, but the inclusion is harmless and keeps every Mnestra function uniform. Re-running 019 on a 0.4.4/0.4.5 install applies the corrected search_path; no need to drop and recreate functions.

#### B. Schema-generation-aware (fixes mid-migration aborts on older installs)

External operator report (2026-05-06): three Supabase projects on the older "memory_items-only" generation of Mnestra (only `memory_items` / `memory_relationships` / `memory_sessions` + the six `memory_*` RPCs) hit "relation does not exist" / "function does not exist" mid-migration when 0.4.4's 019 attempted to `drop policy` on `mnestra_commands` etc. and `revoke execute` on `mnestra_doctor_*`. Those tables and functions only exist on the layered-memory schema generation (`mnestra_session_memory` / `mnestra_developer_memory` / `mnestra_project_memory` / `mnestra_commands` plus the doctor probes from migration 016).

Fix: every section of 019 now guards on object existence (`to_regclass`, `pg_proc` iteration). The function hardening section uses a signature-agnostic `do` block that iterates `pg_proc` and applies `revoke execute` + `alter function … set search_path` to whatever Mnestra functions actually exist on this install. The migration now runs cleanly on:

- **layered-memory generation** (e.g. Josh's reference project): full fix applied
- **memory_items-only generation** (e.g. the three external operator projects): only the function hardening applied; mnestra_*-targeting statements skipped silently
- **mixed generation**: each statement applies to whatever exists

External operator's interim signature-agnostic `do` block was the model for the new section 2/3; thanks to them for catching the divergence and shipping a working subset on their installs.

#### Upgrade path

- `npm install -g @jhizzard/mnestra@latest` (gets 0.4.6 + the corrected migration file).
- Re-run the migration: `psql "$SUPABASE_DB_URL" -f $(npm root -g)/@jhizzard/mnestra/migrations/019_security_hardening.sql` or paste into Supabase Studio. Idempotent.
- 0.4.4 deprecation pointer (set 2026-05-06) now points to 0.4.6 instead of 0.4.5; 0.4.5's deprecation pointer (newly added) also redirects to 0.4.6.

#### What's NOT changed

- The four hole classes 019 closes are unchanged in scope.
- service_role keeps full EXECUTE on every Mnestra function (the revoke only targets public, anon, authenticated).
- No schema migration; only function metadata + RLS policy + view definition changes.
- Verified post-apply on the reference Mnestra project: zero rows from the security diagnostic, `select count(*) from memory_hybrid_search('smoke', array_fill(0::real, ARRAY[1536])::vector, 1)` returns 1 row with no operator-resolution error.

## [0.4.5] - 2026-05-06

### Changed — internal documentation hygiene

- Scrubbed internal project references from CHANGELOG entries and migration comments to standardize on neutral framing in shipped artifacts. No functional changes from 0.4.4 — the security hardening migration (`019_security_hardening.sql`) and all behavior ship unchanged.

## [0.4.4] - 2026-05-06

### Security — migration `019_security_hardening.sql` — Supabase RLS + privilege hygiene

External Supabase advisor sweep by Brad Heath (Nacho Money LLC) on 2026-05-06 surfaced four hole classes that shipped silently in every Mnestra-bearing project from 0.4.3 and earlier. None had been observed exploited; the architecture-as-documented (service-role-only writes via the MCP server) was unaffected. The holes opened on any project where the anon key leaked separately. This release closes them at the schema level so anon-key escape no longer maps to memory-corpus exploitation.

- **NEW migration `019_security_hardening.sql`**:
  1. Drops the four `Allow insert for all` PUBLIC INSERT RLS policies on `mnestra_commands`, `mnestra_developer_memory`, `mnestra_project_memory`, `mnestra_session_memory`. These were created by Supabase Studio's default-policy template at table-creation time and were inherited per-project (not in source migrations). With `WITH CHECK (true)` to PUBLIC, anyone holding the project's anon key could write directly to the memory tables — corpus poisoning and session-id squatting. Service-role writes are unaffected (RLS bypass).
  2. Revokes EXECUTE from `public`, `anon`, `authenticated` on every Mnestra function (5 `mnestra_doctor_*` SECURITY DEFINER probes + 6 `memory_*` RPCs). Postgres defaults function EXECUTE to PUBLIC; the explicit `grant ... to service_role` in earlier migrations is additive, not exclusive. `mnestra_doctor_vault_secret_exists` was the highest-priority fix — anon-callable secret-existence enumeration via the function-owner's privileges.
  3. Pins `search_path = public, pg_catalog` on all 11 functions. Closes Supabase lint 0011 (`function_search_path_mutable`); mitigates SECURITY DEFINER shadow-attack vectors.
  4. Recreates `mnestra_recent_activity` view without `SECURITY DEFINER` and revokes anon/authenticated SELECT (Supabase lint 0010). The view UNIONs all three memory layers and was exposing a 100-row anon-readable window into the entire corpus — direct exfiltration path for any anon-key holder. service_role keeps SELECT.

- **Backward-compatibility:** zero behavior change for any Mnestra installation that follows the documented architecture (service-role writes via MCP server). If a custom installation built around anon-direct writes exists, the migration breaks it — and that's correct. The migration is idempotent (`drop policy if exists`, `revoke ... ` is no-op if already revoked, `alter function ... set search_path` is no-op if already set, `drop view if exists` + recreate is fine).
- **Conditional guards:** the two `pg_cron`-conditional doctor probes (`mnestra_doctor_cron_runs`, `mnestra_doctor_cron_job_exists`) are wrapped in `do $$ ... $$` blocks with `pg_proc` existence checks, mirroring migration 016's conditional creation pattern.
- **Verified on the reference Mnestra project 2026-05-06:** post-apply diagnostic returns zero rows for all four hole classes; service-role smoke test (`select count(*) from memory_status_aggregation()`) returns 1 row as expected.

### Notes — operator action required

- **Existing installations must apply 019.** `npm install @jhizzard/mnestra@0.4.4` ships the new migration file, but applying it is the operator's responsibility (Mnestra historically applies migrations via direct `psql` or via the `@jhizzard/termdeck-stack` audit-upgrade probe, not via Supabase CLI migrations). Two paths:
  - **Via stack-installer**: re-run `termdeck init --mnestra` (or whatever the current upgrade command is); audit-upgrade probes 019 and applies on Y-confirm.
  - **Manually**: `psql "$SUPABASE_DB_URL" -f migrations/019_security_hardening.sql`, or paste the migration body into Supabase Studio's SQL editor. Use the `BEGIN ... ROLLBACK` shape to dry-run first.
- **Post-apply verification** is included as a comment block at the bottom of the migration file. Run it in Studio after applying — should return zero rows.
- **The standing rule lives in the global Claude Code instructions** (`~/.claude/CLAUDE.md` § *MANDATORY: Supabase RLS + privilege hygiene*) — same four gates apply to every Supabase-touching project, every release.

## [0.4.2] - 2026-05-04

### Added — Sprint 51.6 T3 (TermDeck): migration 017 — `memory_sessions` schema reconciliation for the bundled session-end hook

- **NEW migration `017_memory_sessions_session_metadata.sql`** reconciles canonical engram `memory_sessions` (mig 001) with the rag-system writer's richer column set so TermDeck's bundled hook (`@jhizzard/termdeck-stack@0.6.2`) can write a uniform shape on both fresh-canonical installs and the reference Mnestra project (which had been receiving rows from a now-overwritten personal hook). Adds nullable columns: `session_id text`, `summary_embedding vector(1536)`, `started_at`, `ended_at`, `duration_minutes`, `messages_count`, `facts_extracted`, `files_changed jsonb default '[]'`, `topics jsonb default '[]'`, `transcript_path text`. Idempotent (`ADD COLUMN IF NOT EXISTS`). Unique constraint on `session_id` is wrapped in a `do`-block scoped by `conrelid = 'public.memory_sessions'::regclass` (catches the case where the reference project already has the constraint from the rag-system bootstrap). HNSW index on `summary_embedding` + ended-at index for recency queries. Verified to apply cleanly on the reference project in a `BEGIN ... ROLLBACK` transaction probe.

### Notes

- **Cross-repo coordination.** Sprint 51.6 ships this alongside `@jhizzard/termdeck@1.0.2` (audit-upgrade extended to 10 probes including memory_sessions.session_id) and `@jhizzard/termdeck-stack@0.6.2` (bundled hook now writes both `memory_items` AND `memory_sessions` per the rich shape that mig 017 enables). Migration 017 must apply BEFORE the bundled hook starts inserting `memory_sessions` rows on the new schema — orchestrator handles the apply-then-publish ordering at sprint close.
- **Why this migration exists** (architectural context). Sprint 50's bundled session-end hook only writes `memory_items`. Joshua's daily-driver Mnestra had been receiving `memory_sessions` rows from his personal `~/Documents/Graciella/rag-system/src/scripts/process-session.ts` writer until 2026-05-02 13:24 ET when a `termdeck init` overwrote `~/.claude/hooks/memory-session-end.js` with the bundled hook. Since then, `memory_sessions` stopped accumulating. T2 + T1 of Sprint 51.6 reclassified the bug as **Class M — architectural omission, not execution failure**. Mig 017 is the schema half of the fix; the bundled hook in `@jhizzard/termdeck-stack@0.6.2` is the code half. Together they restore parity with Joshua's pre-swap experience AND give every fresh canonical install the rich shape from day one.

## [0.4.0] - 2026-05-02

### Added — Sprint 50 T2 (TermDeck): `source_agent` provenance column + recall filter

- **NEW migration `015_source_agent.sql`** adds `memory_items.source_agent text` (nullable, with a partial index `idx_memory_items_source_agent ON memory_items (source_agent) WHERE source_agent IS NOT NULL`), a column comment that lists the canonical 5-agent set (`claude|codex|gemini|grok|orchestrator|NULL`), and a backwards-compatible backfill — every historical `source_type='session_summary'` row is set to `source_agent='claude'` since only Claude Code shipped a SessionEnd hook before Sprint 50 T1's per-adapter trigger landed. Idempotent (re-running the migration is a no-op). Other historical rows stay NULL — they came from a mix of MCP tools and the rag-system extractor with no clean single-agent attribution.
- **`memoryRecall()` accepts `source_agents?: string[]`** — filter the result set to memories produced by specific source agents. Empty array == omitted (defensive against MCP clients that pass `[]` as a default). When the filter is set, rows with NULL `source_agent` are excluded — historical rows are reachable only from unfiltered recalls. Implementation post-filters via a follow-up `select id, source_agent` batch lookup against `memory_items` rather than rewriting the hot `memory_hybrid_search` RPC; zero overhead when the filter is omitted (the common case), one extra round-trip when it's set. Migration 015 keeps the search RPC's signature stable so `memory_hybrid_search_explain` and admin tooling continue to work without a coordinated DDL change.
- **`memory_recall` MCP tool input schema** gains the `source_agents: z.array(z.enum(['claude','codex','gemini','grok','orchestrator'])).optional()` field — agents using mixed 4+1 sprints can pass `source_agents=['claude']` for trust-grade recall (per Joshua's "trust Claude most" preference documented in `docs/MULTI-AGENT-MEMORY-ARCHITECTURE.md` § Deliverable 2 Path A).
- **NEW dependency injection on `memoryRecall`** — second arg `RecallDeps = { client?, generateEmbedding? }` lets tests bypass the live OpenAI + Supabase calls. Mirrors the existing `memoryStatus(client?)` pattern. No behavior change when omitted.
- **NEW `tests/recall-source-agent.test.ts`** (~7 tests) — pins the post-filter contract: omitted/empty filter is a no-op (one RPC, zero batch lookups); single-agent filter (`['claude']`) returns only matching rows; multi-agent filter returns the union; unknown-agent filter returns zero hits; NULL-source-agent rows are excluded when any filter is set; empty RPC result short-circuits.
- **`SourceAgent` type + `SOURCE_AGENTS` runtime array** exported from `src/types.ts` so adapters in the bundled hook (and downstream consumers) can mirror the canonical set without drift.

### Notes

- **Cross-repo coordination.** Sprint 50 ships this alongside `@jhizzard/termdeck-stack@0.6.0` (which bundles the updated `assets/hooks/memory-session-end.js` with the `source_agent` payload field) and TermDeck server `onPanelClose` (Sprint 50 T1 lane). Migration 015 must apply BEFORE either side starts inserting with the new column — orchestrator handles the apply-then-publish ordering at sprint close. Defensive: PostgREST silently drops unknown columns from inserts, so old hook versions won't crash if they POST without `source_agent` post-migration.
- **Why post-filter, not RPC modification.** Adding a `filter_source_agents text[]` param to `memory_hybrid_search` would require DROP+CREATE FUNCTION (default-parameter additions still change PostgreSQL signatures), which would either break the dependent `memory_hybrid_search_explain` static signature or force a coordinated multi-function migration. The post-filter path is one extra round-trip when the filter is set, zero overhead otherwise — measured cost dominated by latency to Supabase, not row count. Path B's trust-weighted ranking (in Unreleased) requires the SQL modification; if that ships, the post-filter goes away.
- **Validation.** Mnestra full test suite green (existing 42 + 7 new = 49 expected). TypeScript clean. Migration 015 is idempotent and verified against the design doc backfill rule (12 historical session_summary rows expected to land in `source_agent='claude'` post-apply).

## [0.3.4] - 2026-05-02

### Fixed — MCP stdio bypassed `~/.termdeck/secrets.env` fallback (Joshua's 2026-05-02 regression)

- **`loadTermdeckSecretsFallback()` was only invoked for the `serve` subcommand** (`mcp-server/index.ts:124`); the default MCP stdio path (the one Claude Code launches via `claude mcp add mnestra ...`) skipped it entirely. Combined with the parallel `@jhizzard/termdeck-stack@≤0.4.11` bug that wrote literal `${SUPABASE_URL}` / `${SUPABASE_SERVICE_ROLE_KEY}` strings into the MCP env block (Claude Code does not shell-expand MCP env), every `memory_recall` / `memory_remember` / `memory_status` call surfaced as `Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL.` even though `~/.termdeck/secrets.env` was correctly populated. Three-layer fix: (1) `loadTermdeckSecretsFallback()` now runs for the default MCP stdio launch and the `export` / `import` subcommands too; (2) NEW helper `isUnexpandedPlaceholder(v)` treats values shaped like `${VAR}` as if the env var were unset, so the fallback overrides them from `secrets.env` instead of bailing out on a non-empty-but-invalid string; (3) the existing concrete-value protection still wins (legitimate runtime env vars are never overridden). Stack-installer companion fix in `@jhizzard/termdeck-stack@0.4.12` rewrites the env writer to read concrete values from `secrets.env` and to repair already-broken `${...}` entries on next stack run.

### Notes

- Verified by running `mnestra` with `SUPABASE_URL='${SUPABASE_URL}'` literal env: the secrets fallback fires (`[mnestra] Loaded N secrets from ~/.termdeck/secrets.env`) and `memory_status` returns the live aggregation (6237 memories at the time of fix). Mnestra full test suite **42/42 green**, no test changes needed (the bug was in entry-point branch routing, which has no direct unit coverage; integration verified manually).
- Defense-in-depth lesson: a fix should both prevent the upstream cause AND survive the upstream cause regressing. Even after `termdeck-stack@0.4.12` ships, an old `~/.claude.json` written by `≤0.4.11` keeps working without manual repair because mnestra now ignores `${...}` placeholders.

## [0.3.3] - 2026-04-29

### Fixed — Sprint 42 T3: package.json `main` and `types` fields

- **`package.json "main": "./dist/index.js"` and `"types": "./dist/index.d.ts"` were broken since v0.2.0** — the actual compiled outputs land at `dist/src/index.js` and `dist/src/index.d.ts` because `tsconfig.json` `"rootDir": "."` plus `"include": ["src/**/*.ts", "mcp-server/**/*.ts"]` preserves the source-tree layout under `dist/`. Consumers haven't hit the bug because npm `bin` (`./dist/mcp-server/index.js`) resolves correctly and the package is consumed via the `mnestra` CLI, not `require('@jhizzard/mnestra')`. Cosmetic-but-correctness fix; pinned by NEW `tests/main-field.test.ts` (3 tests) which asserts `main`, `types`, and `bin.mnestra` all resolve to existing files via `fs.existsSync`.

### Notes

- Bundled as part of the TermDeck Sprint 42 close-out. T3's lane diagnosed both the `main` field gap here and a parallel migration-003 templating gap on the TermDeck side; both ship in the same release wave (`termdeck@0.11.0` / `termdeck-stack@0.4.6` / `mnestra@0.3.3` / `rumen@0.4.4`).
- **Validation.** Mnestra full test suite **42/42 green** (was 39 pre-Sprint-42, +3 from `main-field.test.ts`). `node -e "require('./package.json'); console.log(require.resolve('./dist/src/index.js'))"` resolves cleanly.

## [0.3.2] - 2026-04-28

### Fixed — operator install incident: silent permission-denied failures (root-caused 2026-04-28)

- **NEW migration `014_explicit_grants.sql`** ships explicit `GRANT` statements that prior migrations relied on Supabase's auto-grant default to provide. Schema-wide on `service_role` (Mnestra's only direct connection role) for tables, plus `service_role / authenticated / anon` for functions, plus `alter default privileges` so any future tables/RPCs we add inherit the same grants automatically. Idempotent — no-op on greenfield projects where the auto-grant default already fired.
- **`src/remember.ts` no longer silently swallows insert/update errors.** Lines 75-82 (update path) and 96-98 (insert path) previously logged to stderr and returned `'skipped'` to the MCP caller — which reads as "deduped" — masking real failures (e.g. missing GRANTs) as expected behavior. Now throws the actual error message; the MCP server, webhook server, and `summarize.ts` all already wrap `memoryRemember` in try/catch and surface `err.message` to the user. `RememberResult` type unchanged.

### Notes

- **Root cause attribution.** An external operator surfaced the bug 2026-04-28 against their Mnestra-dedicated Supabase project. Symptom: `memory_remember` returned `Memory skipped: "..."`, `memory_status` showed 0 memories, `memory_recall` returned `Search error: permission denied for table memory_items`. They proved the Postgres `service_role` had no SELECT/INSERT/UPDATE on `memory_items` via direct curl with the literal JWT (HTTP 403, code 42501) — ruling out env propagation, RLS, and anon-key fallback. Applied the schema-wide fix as a one-shot migration; verified end-to-end (insert + status + recall) with the same env vars and MCP process — confirms fix is purely at the database GRANT level.
- **Why this only bit some installs.** Supabase auto-grants public-schema privileges to anon/authenticated/service_role only when (a) the creating role is `postgres` or another role in the auto-grant chain AND (b) the project's default privileges in schema public haven't been tightened. Projects where one of those preconditions failed silently lost the GRANTs; users got the misleading "Memory skipped" return with no diagnostic.
- **Validation.** TypeScript clean, full test suite 39/39 pass, including `dispatchOp wraps thrown errors as 500` which confirms the webhook layer correctly renders thrown errors as `{ ok: false, error: <message> }`.

## [0.3.1] - 2026-04-28

### Added — Sprint 41 mirror migrations (TermDeck Sprint 41 close-out)

- **NEW migration `012_project_tag_re_taxonomy.sql`** (397 LOC, byte-identical mirror of TermDeck's bundled copy). Re-tags historical chopin-nashville rows using the new project taxonomy. Eight buckets (broadest-first): termdeck, rumen, podium, chopin-in-bohemia, chopin-scheduler+Maestro alias, pvb, claimguard, dor. Idempotent on re-run. `[012-retaxonomy]` RAISE NOTICE prefix on all 11 probes. Live-applied at TermDeck Sprint 41 close: 957 → 896 chopin-nashville rows after the deterministic pass.
- **NEW migration `013_reclassify_uncertain.sql`** (39 LOC). Adds `reclassified_by text` + `reclassified_at timestamptz` columns to `memory_items` plus a partial index filtered to non-NULL rows (keeps the index small). Idempotent (`add column if not exists`). Used by TermDeck's `scripts/reclassify-chopin-nashville.js` to stamp LLM-classified rows for audit + idempotent re-runs. After TermDeck Sprint 41 T4's full reclassify pass landed (~$0.18 Anthropic spend, 896 rows classified across 45 batches with zero errors), the chopin-nashville count dropped 896 → 40.

### Notes

- These migrations ship in the TermDeck-bundled `mnestra-migrations/` directory at the same time. The TermDeck migration runner (bundled-FIRST per v0.6.8+) picks them up automatically on a fresh install. The Mnestra-repo copies are for direct-`psql` users who consume `@jhizzard/mnestra` standalone.
- No `dist/` changes — these are SQL-only additions. Mnestra package.json `files` array already includes `migrations/`.

## [0.3.0] - 2026-04-27

### Added — Knowledge graph MCP layer (TermDeck Sprint 38)

- **Three new MCP tools for graph operations.** `memory_link(source_id, target_id, kind, weight?)` connects two memories with a typed relationship (idempotent on the `(source_id, target_id, kind)` tuple via `ON CONFLICT DO UPDATE`); `memory_unlink(source_id, target_id, kind?)` removes one or all relationship types between two memories; `memory_related(id, depth=2, kind=*)` returns the N-hop neighborhood of a memory with optional kind filtering. Implementation in NEW `src/relationships.ts` (~225 LOC). Full input validation: UUID format on both endpoints, `kind` constrained to the 8-value enum, `weight ∈ [0, 1]`, `depth ∈ [1, 5]`, `source_id ≠ target_id`. Tool inserts stamp `inferred_by = 'mcp:memory_link'` so audit queries can split MCP-direct edges from cron-inferred and ingest-time edges. NEW `tests/relationships.test.ts` (~290 LOC, **14 tests**, all pass): input rejection paths, upsert payload + onConflict tuple, insert-vs-update detection heuristic, kind-filter scoping, depth boundary rejection, empty-neighborhood handling.
- **`memory_recall_graph` MCP tool — graph-aware recall.** Two-stage recall: vector seed via `match_memories` → graph expansion via `expand_memory_neighborhood` → re-rank by `vector_score × edge_weight × recency_score`. NEW `src/recall_graph.ts` (~125 LOC) wraps the Postgres RPC defined in migration 010; reuses the existing `generateEmbedding` + `formatEmbedding` + `getSupabase` helpers. Returns `{ hits: GraphRecallHit[], depth_distribution: Record<number, number>, text: string }` where `text` rendering uses a `(d{depth} {final_score})` prefix so callers can eyeball vector-vs-graph hits at a glance. Tool registers with zod input schema (`query`, `project?`, `depth ∈ [1, 5]` default 2, `k ∈ [1, 50]` default 10).
- **8-value `RelationshipType` union extended in `src/types.ts`.** Existing 5 values from migration 001 (`supersedes`, `relates_to`, `contradicts`, `elaborates`, `caused_by`) plus three new (`blocks`, `inspired_by`, `cross_project_link`). New runtime `RELATIONSHIP_TYPES` array exported for validation. Underscore convention preserved (existing 749 rag-system-classified edges in production already use it).
- **NEW migration `009_memory_relationship_metadata.sql`** (110 LOC, byte-identical mirror in TermDeck `packages/server/src/setup/mnestra-migrations/`). Adds three columns to `memory_relationships` (`weight float`, `inferred_at timestamptz`, `inferred_by text`); expands the relationship-type CHECK from 5 to 8 values via a `DO $$ pg_constraint walk $$` block (the original CHECK from migration 001 is anonymous, defined inline; a hardcoded `DROP CONSTRAINT IF EXISTS memory_relationships_relationship_type_check` would silently no-op against the live DB and leave both old and new CHECKs racing for the column); adds the new CHECK with an explicit name so future migrations can target it cleanly. Creates `expand_memory_neighborhood(start_id uuid, max_depth int default 2) RETURNS TABLE (memory_id uuid, depth int, path uuid[], edge_kinds text[])` — recursive CTE traversing edges bidirectionally (CASE-WHEN flips source/target during recursion so reachability is symmetric — graph-aware recall benefits from undirected expansion), cycle-safe via `NOT (next_id = ANY (path))`. Idempotent. Adds two partial indexes on `weight` and `inferred_at` for traversal hot paths.
- **NEW migration `010_memory_recall_graph.sql`** (147 LOC, byte-identical in both repos). Defines `memory_recall_graph(query_embedding vector(1536), project_filter text DEFAULT NULL, max_depth int DEFAULT 2, k int DEFAULT 10) RETURNS TABLE`. Two-stage CTE: `match_memories` for vector seeds → `expand_memory_neighborhood` for graph expansion → re-rank by `vector_score × edge_weight × recency_score` (30-day half-life via `exp(-age_seconds / (30 * 86400))`) → `LIMIT 50`. Path-edge weight uses `coalesce(r.weight, 0.5)` — the 749 pre-edge-inference-cron edges contribute neutrally until the cron's first pass populates real weights. `DISTINCT ON (memory_id) ... ORDER BY memory_id, final_score DESC, depth ASC` keeps the strongest path when a memory is reachable multiple ways. Path-edge lookup is undirected (CASE-WHEN matches A→B or B→A) — aligns with `expand_memory_neighborhood`'s bidirectional contract.

### Notes

- **Migration ordering at deploy:** apply 009 before 010 (010 depends on `expand_memory_neighborhood`). Both are idempotent on second run. The TermDeck migration runner globs alphabetically so fresh installs handle this automatically; live-DB application is single-shot via psql in the orchestrator close-out flow.
- **The 749 existing edges populated by `rag-system`'s MCP-side classifier** (`~/Documents/Graciella/rag-system/src/lib/relationships.ts`, called from `detectAndStoreRelationships()` after every `memory_remember`) are **preserved untouched** by migration 009. Every existing `relationship_type` value is in the new 8-value CHECK; rows have `weight = NULL / inferred_at = NULL / inferred_by = NULL`. The TermDeck Sprint 38 T2 cron's first pass backfills `weight` onto these via `ON CONFLICT DO UPDATE` when existing rows have `weight IS NULL`. The two classifiers (rag-system at ingest time, T2 cron periodic) coexist with distinct `inferred_by` namespaces and no role overlap.
- **Test status:** Mnestra full suite **39/39 pass** (was 25 pre-Sprint-38, +14 from `relationships.test.ts`). TypeScript clean.
- **Dependency on TermDeck v0.10.0:** the migration 003 pg_cron schedule and the `graph-inference` Edge Function ship in TermDeck (Rumen-side); a fresh Mnestra install without TermDeck stack-installer would have the SQL substrate (009 + 010) but not the inference pipeline. That's intentional — Mnestra is the storage + tools layer; the cron is product-specific to the TermDeck stack.

## [0.2.2] - 2026-04-26

### Fixed
- **`memory_items.source_session_id` missing from fresh installs.** The column existed in the original `rag-system` schema (TEXT) and is still present on stores upgraded from rag-system → Engram → Mnestra, but was dropped from the published Mnestra migration set during the rebrand. Rumen v0.4.x's Extract phase (`extract.ts:61`) groups memory_items by `source_session_id` to find eligible sessions for synthesis. On any fresh Mnestra install, every Rumen cron tick failed with `column m.source_session_id does not exist` (Postgres SQLSTATE 42703).
- New `migrations/007_add_source_session_id.sql` adds the column back as `TEXT`, idempotent (`ADD COLUMN IF NOT EXISTS`), with a partial index on `WHERE source_session_id IS NOT NULL`. NULL on every existing row is the correct default — old memories were never tagged with a session, and Rumen's `WHERE source_session_id IS NOT NULL` filter excludes them naturally.

### Notes
- Reported 2026-04-26 by a TermDeck tester (Brad) whose fresh `termdeck init --mnestra` on v0.6.3 left him with a Mnestra schema that worked for TermDeck/Flashback but couldn't host Rumen. v0.6.4 unblocked his Rumen install (access-token hint), v0.6.5 of TermDeck (which bundles the same migration) closes the contract break.
- Recovery for direct `@jhizzard/mnestra` users: `npm i -g @jhizzard/mnestra@latest`, then re-run your migration application step. The column lands idempotently. For TermDeck users, the recovery is `termdeck init --mnestra --yes` after upgrading to TermDeck v0.6.5+.

## [0.2.1] - 2026-04-19

### Added
- **`~/.termdeck/secrets.env` fallback for `mnestra serve`.** When `SUPABASE_URL` is not set in the environment, the `serve` subcommand now parses `~/.termdeck/secrets.env` (dotenv-style `KEY=value` lines, with `#` comments and optional surrounding quotes) and populates `process.env` for any keys that aren't already set. Existing env vars are never overridden; missing file is a silent no-op. Eliminates the #1 recurring startup friction: starting Mnestra without sourcing secrets first. Only the `serve` path is affected — the default stdio MCP server, `export`, `import`, `--help`, and `--version` are unchanged.

## [0.2.0] - 2026-04-13

### Added
- **`mnestra --help` / `--version` / `help` subcommand.** CLI now prints a human-readable usage block listing `serve`, `export`, `import`, and required environment variables, and reports the package version from `package.json`.
- **`memory_status_aggregation` SQL function** (`migrations/006_memory_status_rpc.sql`). Pushes the status histogram GROUP BY into Postgres so `memoryStatus()` no longer hits PostgREST's default 1000-row cap when streaming rows to the client. The JS side now calls the RPC first and falls back to the legacy client-side aggregation (with a one-time warning) when the migration hasn't been applied yet. Fixes the Sprint 1 observation where `by_project` summed to ~1000 despite `total_active` being 3,397.
- **Unit tests for `memoryStatus()`.** `tests/status.test.ts` drives `memoryStatus()` with an injected fake Supabase client and asserts (a) the RPC result is unpacked correctly, (b) bigints-as-strings from Postgres are normalized to numbers, and (c) the legacy fallback path still returns a correctly summed histogram. `memoryStatus()` grew an optional `client` parameter for test injection; default behavior unchanged.
- **HTTP webhook server** (`mnestra serve`). A tiny `node:http` surface on `MNESTRA_WEBHOOK_PORT` (default `37778`) exposing:
  - `POST /mnestra` with `{ op, ...args }` for `remember` / `recall` / `search` / `status` / `index` / `timeline` / `get`.
  - `GET /healthz` — liveness plus `{ version, store: { rows, last_write } }`.
  - `GET /observation/:id` — single memory by UUID, same row shape as `memory_get` (the citation endpoint).
  The MCP stdio server keeps working unchanged; the two are additive. Graceful shutdown on SIGTERM/SIGINT. Implemented in `src/webhook-server.ts` with a testable `dispatchOp()` that takes injectable deps.
- **Three-layer progressive-disclosure search**: `memory_index` / `memory_timeline` / `memory_get`. Exposed both as MCP tools and through the webhook server. `memory_index` returns a compact 80–120-token shape (`{id, snippet≤120, source_type, project, created_at}`); `memory_timeline` returns the same compact shape chronologically surrounding either a query hit or an explicit UUID with windows `1h`/`24h`/`7d`; `memory_get` batch-fetches full rows (1–100 UUIDs per call) and shares its row shape with `GET /observation/:id`. Implemented in `src/layered.ts`.
- **Privacy tags.** `memory_remember` now strips `<private>…</private>` blocks from content before embedding, dedup, and insert, replacing each block with `[redacted]`. Rows that had any redaction get `metadata.had_private_content = true`. Handles nested tags (collapse to one outer block), unclosed tags (preserved verbatim — fail-safe, never leak), case-insensitive tag matching, and attributes on the opening tag. The consolidation job re-applies the redactor defensively to every cluster member and to the canonical output so legacy rows are covered. Implemented in `src/privacy.ts`; documented in `docs/SOURCE-TYPES.md`.
- **`mnestra export` / `mnestra import` CLI.** Streaming JSONL dump and load with no in-memory accumulation.
  - `mnestra export --project <name> --since <iso>` paginates through `memory_items` 500 rows at a time and writes one JSON object per line to stdout, including the `embedding` column so re-imports don't need to re-embed.
  - `mnestra import < dump.jsonl` reads stdin line-by-line, skips existing IDs, computes missing embeddings, and inserts. Preserves `id`, `created_at`, `updated_at`, `is_active`, `archived`, `superseded_by` when present. Implemented in `src/export-import.ts`.
- **`match_count` cap on `memory_hybrid_search`.** Default cap 200, configurable via a PG setting: `SET mnestra.max_match_count = 500` (per-session) or `ALTER DATABASE … SET mnestra.max_match_count = 500` (persistent). The function was previously unbounded.
- **`memory_hybrid_search_explain`.** New SQL function returning `EXPLAIN (ANALYZE, BUFFERS)` output for the equivalent `memory_hybrid_search` call. Used by admin tooling (`mnestra diagnose`) to debug slow recall queries on large stores.
- **Unit test infrastructure.** New `tsconfig.tests.json` + `npm test` script (`tsc -p tsconfig.tests.json && node --test 'dist-tests/tests/**/*.test.js'`). 21 `node:test` cases across webhook dispatch, three-layer round-trip, privacy redaction edge cases, and error handling. No new runtime dependencies — `node:http`, `node:readline`, and `node:test` are built in.

### Changed
- **`POST /mnestra` with malformed JSON returns 400, not 500.** `readJsonBody` now throws a tagged `HttpError(400, 'invalid JSON body')` which the outer handler honours. New integration test boots the webhook server on port 0 and POSTs `"not json"` to assert the 400. Other thrown errors still default to 500.
- `memory_get` now SELECTs an explicit column list (no `embedding`) so its row shape exactly matches `GET /observation/:id`. Embeddings were never useful for citation callers and inflated responses by ~6 KB each.
- `README.md` tool reference table updated to list all nine MCP tools and the new HTTP surface.
- `migrations/003_mnestra_event_webhook.sql` stays as a placeholder — the webhook implementation lives in-process (`src/webhook-server.ts`), not in SQL. `migrations/004_mnestra_match_count_cap_and_explain.sql` is the new file.

## [0.1.0] - 2026-04-11

### Added
- Six MCP tools: `memory_remember`, `memory_recall`, `memory_search`, `memory_forget`, `memory_status`, `memory_summarize_session`
- `memory_items`, `memory_sessions`, `memory_relationships` schema with vector(1536) and HNSW indexing
- `memory_hybrid_search` SQL function with reciprocal rank fusion over full-text + semantic search
- `consolidateMemories` background job for clustering and merging near-duplicates via Claude Haiku
- Programmatic API at `@jhizzard/mnestra` for embedding Mnestra inside other Node tools
- Migrations split into three numbered files for clean upgrade history
- Full documentation: `README.md`, `docs/SCHEMA.md`, `docs/SOURCE-TYPES.md`, `docs/INTEGRATION.md`, `docs/RAG-FIXES-APPLIED.md`

### Fixed (the six RAG fixes from RAG-MEMORY-IMPROVEMENTS-AND-TERMDECK-STRATEGY.md)
- **Fix 1 — Tiered recency decay by source_type.** `memory_hybrid_search` now applies a `CASE source_type` decay, with one-year half-life for decisions / architecture / preferences, 90 days for facts, 30 days for bug fixes, 14 days for session summaries and document chunks. Implemented in `migrations/002_mnestra_search_function.sql`.
- **Fix 2 — Minimum result count in `memory_recall`.** `memoryRecall` always returns at least `min_results` (default 5) hits when that many exist, regardless of token budget or score threshold. Implemented in `src/recall.ts`.
- **Fix 3 — Source-type weighting inside the SQL function.** Decisions get a 1.5x multiplier, architecture 1.4x, bug fixes 1.3x, preferences 1.2x, document chunks 0.6x. Applied before `LIMIT` so important memories survive truncation. Implemented in `migrations/002_mnestra_search_function.sql`.
- **Fix 4 — Memory consolidation background job + looser dedup threshold.** New `consolidateMemories` function clusters memories at >0.85 similarity and merges them via Haiku. Dedup threshold in `memoryRemember` lowered from 0.92 to 0.88. Implemented in `src/consolidate.ts` and `src/remember.ts`.
- **Fix 5 — Project affinity scoring.** Exact project match multiplies score by 1.5x, the special `global` project by 1.0x, and unrelated projects by 0.7x. Implemented in `migrations/002_mnestra_search_function.sql`.
- **Fix 6 — Real-time event ingestion path documented.** `migrations/003_mnestra_event_webhook.sql` is a placeholder marker; the live ingestion endpoint will live in the MCP server process. Documented in `docs/RAG-FIXES-APPLIED.md`.

[Unreleased]: https://github.com/jhizzard/mnestra/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jhizzard/mnestra/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jhizzard/mnestra/releases/tag/v0.1.0
