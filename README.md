# Mnestra

**The LLM is stateless. Mnestra isn't.**

Mnestra is a persistent developer-memory MCP server. It gives Claude Code, Cursor, Windsurf, Cline, Continue, and any other Model Context Protocol client a long-term memory backed by Postgres + pgvector (Supabase by default). Nine MCP tools — `memory_remember`, `memory_recall`, `memory_search`, `memory_forget`, `memory_status`, `memory_summarize_session`, plus the three-layer progressive-disclosure set `memory_index` / `memory_timeline` / `memory_get` — let your assistant store decisions, recall them across sessions, and surface the right context when you start a new conversation. An optional HTTP webhook server (`mnestra serve`) exposes the same operations to non-MCP clients.

---

## Why Mnestra exists

Every new chat with an LLM starts from zero. You explain the project, the conventions, the bug you fixed last Tuesday, the reason you picked Postgres over DynamoDB — and tomorrow you do it all again. Codebases have CLAUDE.md / AGENTS.md / cursor rules, but those are static. They don't grow as you work.

Mnestra is the writable side of that. As your assistant works it stores discrete facts, decisions, and bug fixes into a vector database with embeddings and metadata. On the next session it can recall the relevant slice — scoped to the project you're in, ranked by importance and recency, deduplicated, and trimmed to a token budget.

It is deliberately small. Six MCP tools, one schema, one SQL function. No agent framework, no orchestration layer, no proprietary cloud. If you can run Postgres with pgvector, you can run Mnestra.

---

## Install

```bash
npm install -g @jhizzard/mnestra
```

Or pin it as a project dev dependency:

```bash
npm install --save-dev @jhizzard/mnestra
```

You will also need:

- A Postgres database with the `vector` and `pg_trgm` extensions (Supabase ships with both)
- An `OPENAI_API_KEY` for embedding generation (`text-embedding-3-large`, 1536 dimensions)
- An `ANTHROPIC_API_KEY` if you want `memory_summarize_session` and the consolidation job (uses Haiku)

### Apply the migrations

The `migrations/` directory contains six SQL files. Apply them in order against your database:

> **Which connection string goes in `DATABASE_URL`? — IPv4-only hosts, read this first.**
> In the Supabase dashboard open **Connect** (the green button) → **Transaction pooler** → toggle ON **"Use IPv4 connection (Shared Pooler)"**, then copy the URL:
>
> `postgres://postgres.<project-ref>:<password>@aws-<n>-<region>.pooler.supabase.com:6543/postgres`
>
> With the toggle OFF (the default) the modal shows the Dedicated Pooler, and the "Direct connection" tab shows `db.<project-ref>.supabase.co` — **both hostnames resolve to IPv6 only** (AAAA record, no A record). On a machine without IPv6 — many CI runners, VPSes, and datacenter hosts — `psql` and `pg`-based clients don't fail fast; they hang until a connect/pool timeout. The Shared Pooler URL works from both IPv4-only and IPv6 hosts. Note its username is `postgres.<project-ref>`, not plain `postgres` — a plain `postgres` username on the pooler host fails with `Tenant or user not found`.
>
> `mnestra doctor` checks the shape of any `DATABASE_URL` it can see and flags an IPv6-only endpoint before it bites.

```bash
psql "$DATABASE_URL" -f node_modules/@jhizzard/mnestra/migrations/001_mnestra_tables.sql
psql "$DATABASE_URL" -f node_modules/@jhizzard/mnestra/migrations/002_mnestra_search_function.sql
psql "$DATABASE_URL" -f node_modules/@jhizzard/mnestra/migrations/003_mnestra_event_webhook.sql
psql "$DATABASE_URL" -f node_modules/@jhizzard/mnestra/migrations/004_mnestra_match_count_cap_and_explain.sql
psql "$DATABASE_URL" -f node_modules/@jhizzard/mnestra/migrations/005_v0_1_to_v0_2_upgrade.sql
psql "$DATABASE_URL" -f node_modules/@jhizzard/mnestra/migrations/006_memory_status_rpc.sql
```

If you're using Supabase, paste each file into the SQL editor and run them in order.

---

## MCP setup

All of the configurations below assume the `mnestra` binary is on your `PATH` (because you ran `npm install -g`). If you'd rather run it from a checkout, replace `"command": "mnestra"` with `"command": "node"` and add `"args": ["/absolute/path/to/dist/mcp-server/index.js"]`.

### Claude Code

Edit `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "mnestra": {
      "command": "mnestra",
      "env": {
        "SUPABASE_URL": "https://YOUR-PROJECT.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "YOUR-SERVICE-ROLE-KEY",
        "OPENAI_API_KEY": "sk-...",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Restart Claude Code. The six `memory_*` tools should appear in the MCP tools list.

### Cursor

Edit `~/.cursor/mcp.json` (Cursor uses the same MCP config shape):

```json
{
  "mcpServers": {
    "mnestra": {
      "command": "mnestra",
      "env": {
        "SUPABASE_URL": "https://YOUR-PROJECT.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "YOUR-SERVICE-ROLE-KEY",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "mnestra": {
      "command": "mnestra",
      "env": {
        "SUPABASE_URL": "https://YOUR-PROJECT.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "YOUR-SERVICE-ROLE-KEY",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

### Generic stdio MCP (Cline, Continue, anything else)

Mnestra speaks the standard stdio MCP transport. Any client that lets you point at a binary will work:

```json
{
  "command": "mnestra",
  "args": [],
  "env": {
    "SUPABASE_URL": "https://YOUR-PROJECT.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "YOUR-SERVICE-ROLE-KEY",
    "OPENAI_API_KEY": "sk-..."
  }
}
```

---

## Tool reference

| Tool | Purpose |
|---|---|
| `memory_remember` | Store a fact, decision, or preference. Embeds, dedups (cosine > 0.88 → update in place, > 0.95 → skip), inserts. |
| `memory_recall` | Smart retrieval. Hybrid search (full-text + semantic + recency + project affinity), dedup, smart re-rank, token-budget trim. Always returns at least `min_results` if available. |
| `memory_search` | Low-level filtered search. Returns raw scored hits. Use this for admin tooling or debugging recall. |
| `memory_forget` | Soft-delete a memory by UUID. The row is archived, not destroyed. |
| `memory_status` | Stats: total active memories, sessions processed, breakdown by project / source_type / category. |
| `memory_summarize_session` | Pass in a session transcript or document; Mnestra extracts discrete facts via Haiku and stores each as a memory. |
| `memory_index` | Three-layer search step 1. Compact `{id, snippet≤120, source_type, project, created_at}` hits (~80–120 tokens each). Drill into IDs with `memory_get`, or surround with `memory_timeline`. |
| `memory_timeline` | Three-layer search step 2. Memories from the same project chronologically surrounding either a query hit or a specific observation ID. Windows: `1h` / `24h` / `7d`. |
| `memory_get` | Three-layer search step 3. Batch-fetch full rows by UUID (1–100 IDs). Batch-only to discourage N+1 calls. |

### Three-layer progressive disclosure

The `memory_index` → `memory_timeline` → `memory_get` trio is designed for token-efficient retrieval. Start with `memory_index` to get a cheap overview, use `memory_timeline` when you need temporal context around a hit, and only call `memory_get` once you know which full rows you actually want. This matches the `search` / `timeline` / `get_observations` shape from `claude-mem`.

### HTTP webhook server (non-MCP clients)

Run `mnestra serve` to start a tiny HTTP surface on `MNESTRA_WEBHOOK_PORT` (default `37778`). It exposes the same operations as the MCP tools over JSON:

- `POST /mnestra` with body `{ "op": "remember" | "recall" | "search" | "status" | "index" | "timeline" | "get", ...args }`.
- `GET  /healthz` — returns `{ ok, version, store: { rows, last_write } }`.
- `GET  /observation/:id` — single memory by UUID (the citation endpoint). Same shape as a `memory_get` row.

The MCP stdio server is unaffected — `mnestra` with no subcommand still starts it.

### CLI subcommands

| Command | What it does |
|---|---|
| `mnestra` | Start the stdio MCP server (default — backwards compatible). |
| `mnestra serve` | Start the HTTP webhook server on `$MNESTRA_WEBHOOK_PORT` (default 37778). |
| `mnestra export --project <name> --since <iso>` | Stream every matching memory as JSONL on stdout. Paginated, never loads the full store into memory. Include embeddings so re-imports don't re-embed. |
| `mnestra import` | Read JSONL from stdin. Skips rows whose `id` already exists, embeds rows that are missing an `embedding`, preserves `id`/`created_at`/`updated_at`/`is_active`/`archived`/`superseded_by` when present. |

Export/import is the migration path out of (or into) Mnestra:

```bash
mnestra export --project termdeck > termdeck-backup.jsonl
mnestra import < termdeck-backup.jsonl
```

### Configuring `memory_hybrid_search`

Starting in 0.2.0, `memory_hybrid_search` caps `match_count` at 200 by default so a single call cannot pull tens of thousands of rows. Override per-database or per-session:

```sql
ALTER DATABASE your_db SET mnestra.max_match_count = 500;
SET mnestra.max_match_count = 500;
```

`memory_hybrid_search_explain(...)` is a sibling function that returns `EXPLAIN (ANALYZE, BUFFERS)` output for the equivalent call. Use it when diagnosing slow recall on very large stores.

---

## Source types

Every memory has a `source_type`. The six values you can pass to `memory_remember` are:

| Value | When to use it |
|---|---|
| `decision` | Architectural or strategic choices ("we picked Postgres because…"). Decays slowly (one-year half-life), highest weight in ranking. |
| `fact` | Project facts ("the API base URL is X"). 90-day half-life. |
| `preference` | User or team preferences ("the team prefers Tailwind over CSS modules"). One-year half-life. |
| `bug_fix` | A specific bug and its resolution. 30-day half-life — stale fixes age out. |
| `architecture` | System architecture notes. One-year half-life, second-highest weight. |
| `code_context` | Snippet-level context about a specific file or function. 14-day half-life. |

Internal source types like `session_summary` and `document_chunk` exist in the SQL ranking function but are not exposed via the MCP `memory_remember` tool — they're populated by `memory_summarize_session` and external ingestion pipelines.

See [`docs/SOURCE-TYPES.md`](docs/SOURCE-TYPES.md) for the full decay and weighting profile.

---

## Schema overview

Three tables and one search function:

- **`memory_items`** — the main store. `id`, `content`, `embedding vector(1536)`, `source_type`, `category`, `project`, `metadata jsonb`, `is_active`, `archived`, `superseded_by`, `created_at`, `updated_at`. Indexed with HNSW on the embedding column and a GIN trigram index on `content`.
- **`memory_sessions`** — optional session metadata for the `memory_summarize_session` workflow.
- **`memory_relationships`** — typed relationships between memories: `supersedes`, `relates_to`, `contradicts`, `elaborates`, `caused_by`.
- **`memory_hybrid_search()`** — RRF fusion of full-text + semantic search, with tiered recency decay, source_type weighting, and project affinity scoring all in one SQL function.

Full DDL is split across six migration files in [`migrations/`](migrations/) (tables, search function, event webhook, match-count cap + explain helper, v0.1→v0.2 upgrade, and the `memory_status` RPC). Schema documentation is at [`docs/SCHEMA.md`](docs/SCHEMA.md).

---

## Pairs with TermDeck

[TermDeck](https://github.com/jhizzard/termdeck) is a browser-based terminal multiplexer with rich metadata overlays and per-terminal AI agent detection. Wire Mnestra into TermDeck and every terminal session can write its events into shared memory; the "Ask about this terminal" input then becomes a recall query against the same store. See [`docs/INTEGRATION.md`](docs/INTEGRATION.md) for the integration recipe.

## Pairs with Rumen

[Rumen](https://github.com/jhizzard/rumen) is an async learning layer that runs on top of any pgvector memory store, including Mnestra. Rumen wakes on a schedule, reads recent session activity, cross-references it with everything you've ever stored, and writes the connections back as `rumen_insights` rows. Mnestra is the memory; Rumen is the part of the stomach that keeps chewing after you stop working.

---

## License

MIT. See [`LICENSE`](LICENSE).
