-- migrations/024_email_assistant_recall.sql
-- Read-only, secret-gated recall path for the NICPC Claude Email Assistant
-- (a Google Apps Script Gmail add-on running in Google's cloud, using the
-- project ANON key). It must NEVER touch the write side, so this exposes ONLY
-- hybrid recall, gated by a shared secret kept out-of-band in private.ea_config.
-- Follows the standing RLS hygiene: SECURITY DEFINER + fixed search_path +
-- REVOKE EXECUTE FROM PUBLIC + scoped GRANT (anon, the email assistant's key).

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.ea_config (
  k text primary key,
  v text not null
);
-- private schema is not exposed via PostgREST and has no anon/authenticated
-- grants, so the secret is unreadable except by the SECURITY DEFINER function
-- below (owned by the migration role). RLS on as belt-and-suspenders.
alter table private.ea_config enable row level security;

create or replace function public.email_assistant_recall (
  p_query_text       text,
  p_query_embedding  vector(1536),
  p_match_count      int  default 6,
  p_secret           text default ''
)
returns table (content text, project text, source_type text, score float)
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
set statement_timeout = '15000'
as $$
declare
  v_expected text;
begin
  -- secret gate: the value lives in private.ea_config, which anon cannot read;
  -- this definer function (owned by the migration role) can.
  select v into v_expected
    from private.ea_config
   where k = 'recall_secret'
   limit 1;

  if v_expected is null or p_secret is null or p_secret <> v_expected then
    raise exception 'email_assistant_recall: unauthorized';
  end if;

  -- read-only PURE HNSW vector search (fast, index-served). NOTE: do NOT use
  -- memory_hybrid_search here — it recomputes to_tsvector over the whole corpus
  -- at query time and times out (57014) under the anon role's short statement limit.
  return query
    select m.content,
           m.project,
           m.source_type,
           (1 - (m.embedding <=> p_query_embedding))::float as score
      from public.memory_items m
     where m.is_active = true
       and m.archived = false
       and m.superseded_by is null
       and m.embedding is not null
     order by m.embedding <=> p_query_embedding
     limit least(greatest(coalesce(p_match_count, 6), 1), 12);
end;
$$;

revoke execute on function public.email_assistant_recall(text, vector, int, text) from public;
grant  execute on function public.email_assistant_recall(text, vector, int, text) to anon;

-- The shared secret is set OUT OF BAND (never committed). At deploy:
--   insert into private.ea_config(k, v) values ('recall_secret', '<random-hex>')
--     on conflict (k) do update set v = excluded.v;
-- and the SAME value goes in the Apps Script Script Property MNESTRA_RECALL_SECRET.
