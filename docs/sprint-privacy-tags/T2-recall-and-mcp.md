# Deck B · T2 — recall.ts `include_privacy[]` filter + MCP tool field

**Lane:** T2 (Claude) · **You own:** `src/recall.ts` and the `memory_recall` tool registration
in `src/mcp-server/*`. Do not touch the migration (T1) or tests/docs (T3).

## Mission

Add the optional `include_privacy?: string[]` recall filter at the **recall.ts layer** (NOT in
the RPC) and expose it on the `memory_recall` MCP tool. Default behavior **excludes** any row
carrying a privacy tag; an explicit `include_privacy: ['<tag>',…]` surfaces rows tagged with
those values.

## The template already exists — mirror it

`src/recall.ts` already does exactly this shape for `source_agent` (~lines 141–180): it fetches
candidate rows from `memory_hybrid_search` and filters in JS, with **zero overhead when the
filter is omitted** (the common case). Copy that structure for `privacy_tags`. Study lines
~100–180 first (the Sprint 50 T2 `source_agents` contract + the `include_null_source` opt-in
pattern are your model).

## Contract from T1

After migration 023, every row from `memory_hybrid_search` carries `privacy_tags text[]`. Read
it as `(row.privacy_tags ?? [])` (defensive — old/unmigrated rows or a not-yet-applied migration
should degrade to empty, i.e. "untagged", never throw). You can build against this contract
before T1's migration is applied.

## Filter semantics (get these exactly right)

- `include_privacy` **omitted or empty array** → **exclude** every row whose `privacy_tags` is
  non-empty (i.e. only untagged rows pass). This is the non-breaking-but-behavior-changing
  default Brad specified.
- `include_privacy: ['secret','medical']` → a row passes if it is untagged **OR** shares at
  least one tag with the opt-in list. (Confirm "any-overlap" vs "all-of" against Brad's
  `PR-DESCRIPTION.md` if available; default to **any-overlap** and note the assumption in STATUS.)
- Apply this filter **after** the existing source_agent / null-source filters, consistently with
  the current pipeline order. Keep the no-op-when-omitted property (no array work when the param
  is absent).

## Type + MCP surface

- Add `include_privacy?: string[]` to the `RecallInput` interface in `src/recall.ts` (alongside
  `source_agents` / `include_null_source`).
- Add the field to the `memory_recall` tool **inputSchema** in `src/mcp-server/*` (grep for the
  tool registration / the existing `source_agents` property — add a sibling
  `include_privacy: { type: 'array', items: { type: 'string' }, description: '…default excludes
  privacy-tagged rows; pass tags to surface them.' }`). Keep it optional. Do **not** add it to
  the RPC argument list.

## Discipline

- Post `### [T2] <VERB> 2026-MM-DD HH:MM ET — <gist>`. `npm run build` must stay green (`tsc`);
  note any new type touchpoints.
- No version bump, no CHANGELOG.md edit, no commit. DONE = filter + type + MCP field land, build
  green, semantics match the spec, file:line cited.
