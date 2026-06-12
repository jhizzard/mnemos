-- 025_source_agent_web_surfaces.sql
-- Sprint 74 T1 (Mnestra Provenance + DB Integrity) — add the four
-- web-surface values to the source_agent taxonomy:
--
--   claude-web | chatgpt-web | grok-web | gemini-web
--
-- Atomic partner of TermDeck Sprint 73 T1, which flips the web-chat-grok
-- panel's capture provenance to source_agent='grok-web'. Only grok-web has
-- a live producer today; the other three are forward declarations for the
-- queued memory-inbox sprint (web chats writing proposals via the bridge).
-- All four land in one migration so the enum + recall-filter + hooks
-- surface churns exactly once (ORCH scope-expansion 2026-06-11, binding).
--
-- What this migration does NOT do, deliberately:
--
--   * No CHECK constraint / domain / enum type. memory_items.source_agent
--     has been plain nullable text since migration 015 and stays that way.
--     The taxonomy is enforced read-side (the MCP memory_recall zod enum,
--     derived from SOURCE_AGENTS in src/types.ts) so that fail-soft
--     writers can NEVER lose a capture to a 23514 check_violation when
--     code ships ahead of schema — the exact silent-capture-loss trap the
--     Sprint 62 backfill (migration 022) existed to clean up after.
--     Web-surface rows written before this migration applies are therefore
--     already intact; this file's job is documentation-of-record plus an
--     apply-time receipt.
--
--   * No backfill. There is nothing to backfill: no producer emitted
--     web-surface values before Sprint 73/74.
--
-- Numbering note: slot 024 was taken concurrently by
-- 024_email_assistant_recall.sql (the email-assistant read-only recall
-- path, a separate initiative staged the same day). This migration is
-- independent of it and of every migration after 022.
--
-- Supabase RLS hygiene gates (global CLAUDE.md): no functions created or
-- replaced, no policies touched, no grants changed, RLS state untouched —
-- gates 1-5 are N/A by construction. The only schema object modified is a
-- column COMMENT; the DO block below is read-only.
--
-- Idempotent: COMMENT ON is naturally last-write-wins; the verification
-- block only SELECTs. Re-applying is a no-op.

comment on column public.memory_items.source_agent is
  'Agent that produced this memory. CLI/orchestrator values (Sprint 50, migration 015): claude|codex|gemini|grok|orchestrator. Web-surface values (Sprint 74, migration 025): claude-web|chatgpt-web|grok-web|gemini-web — distinct trust domains from their CLI counterparts; an exact-match recall filter for grok never returns grok-web rows. grok-web is the first live producer (TermDeck web-chat-grok panel, Sprint 73); claude-web/chatgpt-web/gemini-web are forward declarations for the memory-inbox sprint. NULL = historical or unknown provenance. Populated at write time by per-agent SessionEnd writers (Sprint 50 onward) and by the webhook remember path (Sprint 74 onward — earlier webhook writes silently dropped the field). Pre-Sprint-50 NULL rows backfilled by migration 015 (session_summary -> claude) and migration 022 (decision/bug_fix/architecture/preference/code_context -> claude; fact w/ source_session_id -> claude; document_chunk -> orchestrator). Residual NULL = bare-call fact rows without session or path attribution; intentionally preserved per migration 015''s provenance bright line — reach those via memory_recall include_null_source=true. No CHECK constraint by design: enforcement is read-side (MCP zod enum derived from SOURCE_AGENTS in src/types.ts) so fail-soft writers never lose capture to taxonomy skew.';

-- Apply-time receipt: current source_agent distribution plus a count of
-- web-surface rows. On first apply the web count should be 0 unless a
-- Sprint 73 hooks build already wrote grok-web rows — both are fine (the
-- column never rejected them; this migration is not a gate for writes).
do $$
declare
  v_distribution text;
  v_web_count    bigint;
begin
  select string_agg(format('%s=%s', coalesce(source_agent, 'NULL'), cnt), '  ' order by cnt desc)
    into v_distribution
    from (
      select source_agent, count(*) as cnt
        from public.memory_items
       group by source_agent
    ) t;

  raise notice '[025] source_agent distribution at apply: %',
    coalesce(v_distribution, '(no rows)');

  select count(*) into v_web_count
    from public.memory_items
   where source_agent in ('claude-web', 'chatgpt-web', 'grok-web', 'gemini-web');

  raise notice '[025] web-surface rows present: % (0 expected on first apply; >0 means a Sprint-73 hooks build wrote first — harmless by design)',
    v_web_count;
end$$;
