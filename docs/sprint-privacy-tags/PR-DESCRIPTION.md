# PR: `privacy_tags` column + `include_privacy[]` recall filter

**Repo:** `jhizzard/mnestra` (engram) · **Branch base:** `main` · **Type:** non-breaking feature
**Origin:** Brad Heath's 2026-05-18 proposal (Gmail: *"[mnestra schema PR proposal] privacy_tags
column + include_privacy[] recall filter"*; `PR-DESCRIPTION.md` + `023_privacy_tags_column.sql`
attached). Unblocks Brad's **pka** (Personal Knowledge Archive) project — F3 kickoff decision —
which mirrors his ~20-year corpus into `public.memory_items` with `project='archive'`.

> This writeup was authored by Deck B (3+1+1) reconciling Brad's email spec against the **actual
> in-tree state** of `memory_hybrid_search`. Where the implementation diverges from Brad's original
> attachment, the deltas are called out in *§ Deltas from Brad's original proposal* — please review
> those first. Brad's four open questions (the detail lives in his attached `PR-DESCRIPTION.md`,
> not fetchable in-panel) are reconstructed in *§ Open questions* with conservative answers
> flagged **confirm-with-Brad**.

---

## Summary

Adds a `privacy_tags text[]` column to `memory_items` for open-ended categorical tagging of
sensitive content, and an optional `include_privacy?: string[]` recall parameter. **By default,
any row carrying one or more privacy tags is excluded from recall.** An explicit
`include_privacy: ['secret', …]` opt-in surfaces rows carrying any of the named tags (untagged
rows always pass).

Hosting the filter in Mnestra rather than pka's app layer means **every** consumer — pka, future
projects, MCP-via-other-tools — inherits the exclude-by-default behavior with no per-consumer
code. The column has to exist in `memory_items` either way (pka mirrors items there for unified
cross-corpus recall), so centralizing the filter is the lower-surface-area choice.

**Orthogonal to `src/privacy.ts`.** `stripPrivate()` strips `<private>…</private>` text blocks at
*write* time (`src/privacy.ts:35`). This PR adds whole-item categorical tags filtered at *query*
time. Both can be active on the same row with zero interaction — documented in the migration 023
header. Do not conflate them.

---

## What changed (four surfaces)

| Surface | File | Change |
|---|---|---|
| **Schema** | `migrations/023_privacy_tags_column.sql` (NEW) | `privacy_tags text[] not null default array[]::text[]` column on `memory_items` + GIN index; `memory_hybrid_search` re-created with `privacy_tags` appended to RETURNS TABLE (Open-Q#1 = YES). |
| **Recall layer** | `src/recall.ts` | `include_privacy[]` JS-layer filter — default-deny on tagged rows, any-overlap opt-in. Reads `(row.privacy_tags ?? [])` straight off each RPC row. |
| **Types** | `src/types.ts` | `RecallInput.include_privacy?: string[]` + `RecallHit.privacy_tags?: string[] \| null` (the RPC genuinely returns the column post-023). |
| **MCP tool** | `mcp-server/index.ts:251-305` | `include_privacy` Zod field on the `memory_recall` tool + handler thread-through. |
| **Tests** | `tests/recall-privacy-tags.test.ts` (NEW) | 5 deterministic, DB-free tests pinning the filter contract. |

### How the recall filter works (`src/recall.ts`)

Mirrors the Sprint 50 `source_agents` JS-layer pattern (`src/recall.ts:146-177`) — but with one
deliberate architectural divergence driven by **Open-Q#1 = YES**:

- `source_agents` is **not** returned by the RPC, so that filter does a follow-up
  `from('memory_items').select('id, source_agent').in('id', ids)` batch query.
- `privacy_tags` **is** returned by the RPC (migration 023 extends RETURNS TABLE), so the privacy
  filter reads it directly off each row — **no follow-up SELECT, no N+1.** That elimination is the
  entire point of answering Open-Q#1 *yes*.

Filter predicate (per row), given `includePrivacy` (`null` when omitted/empty):

```
const tags = row.privacy_tags ?? [];
if (tags.length === 0) return true;              // untagged: always pass
if (!includePrivacy)   return false;             // tagged + no opt-in: exclude (default-deny)
return tags.some(t => includePrivacy.includes(t)); // tagged + opt-in: ANY-OVERLAP
```

Two behaviors distinguish this from `source_agents` and are pinned by the tests:
1. **Default-deny runs unconditionally** — the filter executes even when `include_privacy` is
   omitted (`source_agents` only filters when set).
2. **`include_privacy: []` is treated as omitted** — defensive against MCP clients that pass an
   empty array as a default (mirrors the `source_agents` empty-array parse at `src/recall.ts:107-110`).

### Surface scope: MCP opt-in vs webhook default-exclude

`include_privacy` is exposed on the **MCP `memory_recall` tool**. The HTTP webhook recall path
(`src/webhook-server.ts` `recall` op) **inherits default-exclude but not the opt-in** — exact parity
with `source_agents`/`include_null_source`, which it also omits (advanced filters are MCP-only; the
webhook is the reduced TermDeck-ingest surface). This is correct-by-spec and *desirable*: because the
default-exclude lives at the `recall.ts` layer (not the MCP wrapper), unattended proactive-recall
paths (Flashback / TermDeck ingest) auto-hide tagged rows and have **no** way to accidentally opt
into them. Only the manual opt-in is MCP-only — the privacy guarantee itself is layer-wide.

---

## Non-breaking analysis (the precise claim)

**Non-breaking at migration time — behavior change is prospective and intended.**

- Every existing row gets `privacy_tags = array[]::text[]` (the column default). An empty array is
  *untagged*, so it always passes the filter → **recall output is byte-identical the instant the
  migration applies.** No existing caller sees any change.
- The exclude-by-default behavior only manifests once a writer *sets* a non-empty `privacy_tags` on
  a row. That is the feature, not a regression: the whole purpose is that newly-tagged sensitive
  items stop surfacing in default recalls.
- The **8-input-arg `memory_hybrid_search` signature is unchanged.** Open-Q#1 extends only the
  *output* RETURNS TABLE (an appended column). `recall.ts` reads RPC results by-name via PostgREST
  JSON, so appending a column is position-independent and breaks no caller. Brad's "keep the 8-arg
  RPC signature stable" (Sprint 54→56 lesson) is about *input* args and is fully honored.

---

## Deltas from Brad's original proposal

Two reconciliations a reviewer should note — both surfaced by Deck B against the live schema:

1. **`memory_hybrid_search` is `SECURITY INVOKER`, not `SECURITY DEFINER`.** Brad's framing
   implied a DEFINER function. In-tree, migrations 002 + 004 declare it `language sql stable` with
   no `security definer`, and 019 never added one. The re-created function **preserves INVOKER** —
   making a recall function DEFINER would be a privilege-escalation regression, not hygiene
   (global rule: *"security definer — only if truly needed; default to invoker"*).
2. **The RETURNS-TABLE extension forces `DROP FUNCTION` + `CREATE`, not `CREATE OR REPLACE`.**
   Postgres forbids changing a function's return type via REPLACE. Because it's a DROP+CREATE, the
   RLS hygiene re-issue is **load-bearing, not cosmetic** (see *§ Security / RLS hygiene*).

---

## CHANGELOG draft

> **Do not edit `CHANGELOG.md` from a lane** — orchestrator applies this at close. Suggested
> version: a non-breaking feature add → **MINOR bump (0.5.0)** from current 0.4.9. Place under a
> new `## [0.5.0]` (or `## [Unreleased]`) section:

```markdown
### Added — `privacy_tags` column + `include_privacy[]` recall filter (Brad's pka prerequisite)

External request (Brad Heath, Nacho Money LLC, 2026-05-18): a non-breaking Mnestra schema change to
support the pka (Personal Knowledge Archive) project's F3 decision — exclude tagged-sensitive items
from default recall, surface them only on explicit opt-in.

- **Migration `023_privacy_tags_column.sql`** — adds `public.memory_items.privacy_tags text[] not
  null default array[]::text[]` (open-ended categorical tags for sensitive content) + a GIN index
  on the column. Re-creates `memory_hybrid_search` with `privacy_tags` appended to its RETURNS
  TABLE so the recall layer can filter without a follow-up SELECT. The 8-input-arg RPC signature is
  unchanged; the function is re-created via DROP+CREATE (Postgres forbids changing a return type via
  REPLACE), preserving `SECURITY INVOKER`, `set search_path = public, extensions, pg_catalog`, and
  the `REVOKE EXECUTE … FROM public, anon, authenticated` + targeted service-role `GRANT` hygiene
  established in migration 019.
- **`include_privacy?: string[]` recall filter** (`src/recall.ts`, `RecallInput`, `RecallHit`,
  `memory_recall` MCP tool) — rows carrying any `privacy_tags` are excluded from recall by default;
  an explicit `include_privacy: ['<tag>', …]` opts matching rows back in (any-overlap). Untagged
  rows (the default empty array) are unaffected. Mirrors the Sprint 50 `source_agents` JS-layer
  filter, reading `privacy_tags` directly off each RPC row.

Non-breaking: every pre-existing row carries the empty-array default, so recall output is identical
immediately post-migration. The exclude-by-default behavior is prospective — it applies only once a
writer sets tags on a row.
```

---

## Open questions

**#1 — Extend `memory_hybrid_search`'s RETURNS TABLE with `privacy_tags`?** → **DECIDED: YES**
(orchestrator). A non-breaking output-column add that eliminates a per-recall follow-up SELECT in
`recall.ts`. Brad recommended yes; implemented in migration 023. *(This is Brad's "most useful one.")*

The remaining three are reconstructed (Brad's verbatim list is in his attached `PR-DESCRIPTION.md`,
not fetchable in-panel) with **conservative, non-breaking** proposed answers — **confirm-with-Brad**:

**#2 — `include_privacy` match semantics: any-overlap vs all-of?** → **Proposed: ANY-OVERLAP.**
A row surfaces iff at least one of its tags is in `include_privacy`. So a row tagged
`['secret','medical']` surfaces under `include_privacy: ['secret']`. Rationale: matches Brad's
own phrasing ("explicit opt-in surfaces them"); all-of (require every row tag to be opted in) would
make multi-tag rows progressively harder to surface and is the more surprising default. Pinned by
the `['medical']`-surfaces-`secret+medical` test. *(Cheap to revisit — it's one `.some()` vs a
superset check in `recall.ts`.)*

**#3 — Ship a canonical starter tag vocabulary, or stay fully open-ended?** → **Proposed: stay
open-ended at the schema level (no CHECK / enum / lookup table); ship a *documented, non-enforced*
starter vocabulary as guidance only.** Brad's email twice calls these "open-ended category tags," and
an unconstrained `text[]` is the non-breaking choice (a CHECK constraint would reject any future tag
pka invents). Recommend documenting a suggested starter set (e.g. `secret`, `medical`, `financial`,
`legal`, `personal`) in the migration header / docs so pka and future callers tag *consistently*,
without the schema enforcing it. *(Open-ended now; a constraint can be added later if drift becomes
a problem — the reverse is breaking.)*

**#4 — Write-path helper (how do rows get tagged): this PR or a follow-up?** → **Proposed:
FOLLOW-UP.** Keep this PR strictly read-path (column + recall filter). For now pka sets
`privacy_tags` directly on its mirror INSERT/UPDATE into `memory_items` (it already owns those
writes). A first-class write path — e.g. a `privacy_tags?: string[]` param on `memory_remember`, or
a dedicated tagging RPC — is a clean fast-follow once real tagging patterns are observed. Rationale:
smaller, more auditable PR; avoids guessing the write ergonomics before pka exercises them.

*(One non-question worth noting: the **GIN index** is intentional dead weight today — the filter is
JS-layer, so the index isn't consulted. Brad ships it as "free insurance" for a future server-side
`privacy_tags && include_privacy` predicate if recall volume ever makes JS filtering too costly.
Keeping it is correct and cheap.)*

---

## Verification

1. **Migration self-check** — `023_privacy_tags_column.sql` ships a verification block (column
   exists + `not null default`; GIN index present; `memory_hybrid_search` returns `privacy_tags`)
   and a reversal block. Apply against a scratch/branch DB and confirm the block passes; never apply
   straight to the reference daily-driver project without a branch.
2. **RLS hygiene re-check post-apply** — because 023 DROP+CREATEs the function, run the standing
   release checklist against it: no PUBLIC/anon/authenticated `EXECUTE` on `memory_hybrid_search`
   (only `service_role`); `proconfig` carries `search_path=public, extensions, pg_catalog`;
   function is `SECURITY INVOKER`. (T4-CODEX's prime audit target.)
3. **Tests** — `npm test` (runs `tsc -p tsconfig.tests.json && node --test`). New file
   `tests/recall-privacy-tags.test.ts` (5 cases): default excludes tagged rows; `['secret']`
   surfaces secret + untagged, hides medical-only; `['medical']` proves any-overlap (multi-tag row
   surfaces under either tag); `include_privacy: []` ≡ omitted; untagged-only corpus is invariant
   (incl. zero batch `.from()` lookups). All DB-free via injected `RecallDeps`. The existing
   `recall-source-agent.test.ts` (11 cases) must stay green — its fixtures carry no `privacy_tags`
   → degrade to untagged → unaffected.
4. **Manual before/after** — tag a throwaway row (`update memory_items set privacy_tags =
   array['secret'] where id = …`); confirm it vanishes from a default `memory_recall` and reappears
   under `include_privacy: ['secret']`; confirm an untagged row is unaffected in both.

---

## Files changed

- `migrations/023_privacy_tags_column.sql` *(NEW — T1)*
- `src/recall.ts`, `src/types.ts`, `mcp-server/index.ts` *(T2)*
- `tests/recall-privacy-tags.test.ts` *(NEW — T3)*
- `CHANGELOG.md` *(orchestrator, at close — draft above)*

## Security / RLS hygiene (release gate — T4-CODEX prime target)

Migration 023 re-creates `memory_hybrid_search` via DROP+CREATE. A freshly created function inherits
PUBLIC `EXECUTE` (Postgres default) **plus** anon/authenticated via migration 014's
`alter default privileges … grant execute … to service_role, authenticated, anon`. Without an
explicit `REVOKE EXECUTE … FROM public, anon, authenticated` after the CREATE, 023 would silently
re-open the privilege hole that migration 019 closed. Likewise DROP+CREATE starts `proconfig` empty,
so the body **must** re-declare `set search_path = public, extensions, pg_catalog` (extensions
required — pgvector's `<=>` lives there; this was the 0.4.4→0.4.6 regression that motivated 019's
revision). Both are present in 023; both are gated by T4-CODEX's independent re-check above.
