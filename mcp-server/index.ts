#!/usr/bin/env node

/**
 * Mnestra CLI entry point
 *
 * Default (no args): starts the stdio MCP server with six tools:
 *   memory_remember, memory_recall, memory_search, memory_forget,
 *   memory_status, memory_summarize_session.
 *
 * `mnestra serve`: starts the HTTP webhook server (src/webhook-server.ts)
 * instead of the MCP stdio server. The two are additive — existing MCP
 * clients are unaffected.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  memoryRemember,
  memoryRecall,
  memoryRecallGraph,
  memorySearch,
  memoryForget,
  memoryStatus,
  formatStatus,
  memorySummarizeSession,
  memoryIndex,
  memoryTimeline,
  memoryGet,
  memoryLink,
  memoryUnlink,
  memoryRelated,
} from '../src/index.js';
import { startWebhookServer } from '../src/webhook-server.js';
import { exportMemories, importMemories } from '../src/export-import.js';
import { runDoctor, formatDoctor } from '../src/doctor.js';
import { createSupabaseDoctorDataSource } from '../src/doctor-data-source.js';
import { getSupabase } from '../src/db.js';

const subcommand = process.argv[2];

function parseFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === prefix) return args[i + 1];
    if (a.startsWith(`${prefix}=`)) return a.slice(prefix.length + 1);
  }
  return undefined;
}

/**
 * Fallback for both `mnestra serve` and the default MCP stdio launch:
 * if SUPABASE_URL isn't in the environment (or it's a literal `${VAR}`
 * placeholder that the MCP client failed to expand), try loading
 * `~/.termdeck/secrets.env` (dotenv-style key=value lines).
 *
 * A non-empty value that *looks like* an unexpanded shell placeholder
 * (starts with `${` and ends with `}`) is treated as if the variable were
 * unset — Claude Code does not perform shell expansion on MCP env values
 * and writing those placeholders into ~/.claude.json (as the stack
 * installer ≤ 0.4.11 did) caused mnestra to receive the literal string
 * `${SUPABASE_URL}` and reject it as an invalid Supabase URL.
 *
 * Existing concrete env vars are not overridden. Silent no-op if the file
 * is absent.
 */
function isUnexpandedPlaceholder(v: string | undefined): boolean {
  return typeof v === 'string' && v.startsWith('${') && v.endsWith('}');
}

function loadTermdeckSecretsFallback(): void {
  if (process.env.SUPABASE_URL && !isUnexpandedPlaceholder(process.env.SUPABASE_URL)) {
    return;
  }
  const secretsPath = join(homedir(), '.termdeck', 'secrets.env');
  if (!existsSync(secretsPath)) return;
  try {
    const lines = readFileSync(secretsPath, 'utf8').split('\n');
    let loaded = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!match) continue;
      const key = match[1]!;
      const existing = process.env[key];
      if (existing && !isUnexpandedPlaceholder(existing)) continue;
      process.env[key] = match[2]!.replace(/^["']|["']$/g, '');
      loaded++;
    }
    if (loaded > 0) {
      console.error(`[mnestra] Loaded ${loaded} secrets from ~/.termdeck/secrets.env`);
    }
  } catch (err) {
    console.error(
      `[mnestra] Failed to read ~/.termdeck/secrets.env: ${(err as Error).message}`
    );
  }
}

const HELP_TEXT = `mnestra — persistent developer memory (MCP + HTTP)

Usage:
  mnestra                    Start the stdio MCP server (default; backwards compatible)
  mnestra serve              Start the HTTP webhook server on $MNESTRA_WEBHOOK_PORT (default 37778)
  mnestra doctor             Health-probe the install (cron all-zeros, latency, schema drift, MCP path parity)
                              Exit 0 = all green, 1 = at least one red, 2 = at least one yellow.
                              --json                emit structured DoctorReport instead of text
  mnestra export [opts]      Stream memory rows as JSONL to stdout
                              --project <name>   only this project
                              --since <ISO-8601> only rows updated on/after timestamp
  mnestra import             Read JSONL from stdin; skip existing IDs, embed missing
  mnestra --help             Show this message
  mnestra --version          Print package version

Environment:
  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   required for all operations
  OPENAI_API_KEY                             required for embeddings (remember/recall/index/search)
  MNESTRA_WEBHOOK_PORT                        HTTP port for \`mnestra serve\` (default 37778)

Docs: https://github.com/jhizzard/mnestra
`;

if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
  process.stdout.write(HELP_TEXT);
  process.exit(0);
} else if (subcommand === '--version' || subcommand === '-v') {
  // Read version lazily so the CLI doesn't crash if package.json is missing in dev.
  try {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    process.stdout.write(`${pkg.version}\n`);
  } catch {
    process.stdout.write('unknown\n');
  }
  process.exit(0);
} else if (subcommand === 'serve') {
  loadTermdeckSecretsFallback();
  startWebhookServer();
} else if (subcommand === 'doctor') {
  loadTermdeckSecretsFallback();
  const supabase = getSupabase();
  const data = createSupabaseDoctorDataSource(supabase);
  const report = await runDoctor({ data });
  // Sprint 53 T3: --json emits the structured report (Brad-equivalent
  // diagnosis without a psql round-trip). Default text path unchanged.
  const wantsJson = process.argv.slice(3).some((a) => a === '--json');
  if (wantsJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatDoctor(report) + '\n');
  }
  process.exit(report.exitCode);
} else if (subcommand === 'export') {
  loadTermdeckSecretsFallback();
  const rest = process.argv.slice(3);
  const project = parseFlag(rest, 'project');
  const since = parseFlag(rest, 'since');
  const report = await exportMemories({ project, since, out: process.stdout });
  process.stderr.write(`[mnestra-export] wrote ${report.rows} rows\n`);
} else if (subcommand === 'import') {
  loadTermdeckSecretsFallback();
  const report = await importMemories({ in: process.stdin });
  process.stderr.write(
    `[mnestra-import] processed=${report.processed} inserted=${report.inserted} skipped=${report.skipped} errors=${report.errors}\n`
  );
} else {
  // Default path: stdio MCP server. Must load the secrets fallback too —
  // the MCP client (Claude Code) launches mnestra without a shell, so
  // ~/.zshrc-style exports don't reach the process. Without this, an
  // empty or `${VAR}`-placeholder SUPABASE_URL in the MCP env block
  // bypasses ~/.termdeck/secrets.env and Supabase rejects the URL.
  loadTermdeckSecretsFallback();
  await startMcpStdio();
}

async function startMcpStdio(): Promise<void> {

const server = new McpServer({
  name: 'mnestra',
  version: '0.2.1',
});

// ── memory_remember ──────────────────────────────────────────────────────

server.registerTool(
  'memory_remember',
  {
    title: 'Remember',
    description:
      'Store a fact, decision, or preference in long-term memory. Use this when you learn something important about the user, project, or codebase that should persist across sessions.',
    inputSchema: {
      text: z.string().describe('The fact or information to remember'),
      project: z.string().default('global').describe('Project name (e.g., "my-app")'),
      category: z
        .enum([
          'technical',
          'business',
          'workflow',
          'debugging',
          'architecture',
          'convention',
          'relationship',
        ])
        .optional()
        .describe('Category of this memory'),
      source_type: z
        .enum(['fact', 'decision', 'preference', 'bug_fix', 'architecture', 'code_context'])
        .default('fact')
        .describe('Type of memory'),
    },
  },
  async ({ text, project, category, source_type }) => {
    try {
      const result = await memoryRemember({
        content: text,
        project: project || 'global',
        source_type: source_type || 'fact',
        category: category ?? null,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Memory ${result}: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`,
          },
        ],
      };
    } catch (err) {
      console.error('[mnestra-mcp] memory_remember failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_recall ────────────────────────────────────────────────────────

server.registerTool(
  'memory_recall',
  {
    title: 'Recall',
    description:
      'Smart retrieval of relevant memories. Returns concise, deduplicated results within a token budget. Prioritizes decisions and bug fixes over raw document chunks. Always returns at least min_results hits when available. Omit project to search across ALL projects. Optionally filter by source_agents to recall only rows produced by specific LLMs (claude/codex/gemini/grok/orchestrator); set include_null_source=true to also include historical rows whose authoring agent is unknown. Optionally pass include_privacy=[\'finance\',...] to surface memories tagged with sensitive privacy categories; by default, any row with non-empty privacy_tags is excluded (F3 context-filter design from external Brad project pkachu).',
    inputSchema: {
      query: z.string().describe('What to search for in memory'),
      project: z
        .string()
        .optional()
        .describe('Filter by project (omit for cross-project search)'),
      token_budget: z
        .number()
        .default(2000)
        .describe('Max tokens to return (default 2000, ~8000 chars).'),
      min_results: z
        .number()
        .default(5)
        .describe(
          'Minimum number of hits to return if that many exist, regardless of score threshold.'
        ),
      source_agents: z
        .array(z.enum(['claude', 'codex', 'gemini', 'grok', 'orchestrator']))
        .optional()
        .describe(
          'Filter to memories produced by specific source agents. Omit (or empty array) for all agents. NULL-source-agent rows (historical, pre-Sprint-50, plus the residual slice migration 022 deliberately left NULL) are excluded by default when this filter is set; pass include_null_source=true to include them.'
        ),
      include_null_source: z
        .boolean()
        .optional()
        .describe(
          'When true, NULL-source-agent rows pass the source_agents filter alongside agent-matched rows. Default false preserves the Sprint 50 silent-drop semantics. No effect when source_agents is omitted.'
        ),
      include_privacy: z
        .array(z.string())
        .optional()
        .describe(
          'Filter results by privacy_tags. Omit (or pass empty array) for default behavior — items with any privacy_tags are EXCLUDED. When set to a non-empty array, items whose privacy_tags overlap the requested set are INCLUDED (and items with no tags remain included as before). Recognized values: finance, health, legal, family, work-confidential (open-ended). Added migration 023 — F3 context-filter, not firewall.'
        ),
    },
  },
  async ({ query, project, token_budget, min_results, source_agents, include_null_source, include_privacy }) => {
    try {
      const out = await memoryRecall({
        query,
        project: project ?? null,
        token_budget: token_budget || 2000,
        min_results: min_results || 5,
        source_agents: source_agents ?? null,
        include_null_source: include_null_source === true,
        include_privacy: include_privacy ?? [],
      });
      return { content: [{ type: 'text' as const, text: out.text }] };
    } catch (err) {
      console.error('[mnestra-mcp] memory_recall failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_recall_graph ──────────────────────────────────────────────────

server.registerTool(
  'memory_recall_graph',
  {
    title: 'Recall (graph-aware)',
    description:
      'Graph-aware retrieval. Runs vector recall, then expands the top-K results through memory_relationships to depth N, and re-ranks the union by vector_score × edge_weight × recency_score. Returns memories with `depth` (0=vector hit, 1+=graph neighbor) and `final_score`. Use when you want context-by-association in addition to context-by-similarity.',
    inputSchema: {
      query: z.string().describe('What to search for in memory'),
      project: z
        .string()
        .optional()
        .describe('Filter by project (omit for cross-project search)'),
      depth: z
        .number()
        .int()
        .min(1)
        .max(5)
        .default(2)
        .describe('Graph expansion depth (default 2, max 5)'),
      k: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('Top-K seeds for vector recall before graph expansion (default 10)'),
    },
  },
  async ({ query, project, depth, k }) => {
    try {
      const out = await memoryRecallGraph({
        query,
        project: project ?? null,
        depth: depth || 2,
        k: k || 10,
      });
      return { content: [{ type: 'text' as const, text: out.text }] };
    } catch (err) {
      console.error('[mnestra-mcp] memory_recall_graph failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_search ────────────────────────────────────────────────────────

server.registerTool(
  'memory_search',
  {
    title: 'Search Memories',
    description:
      'Low-level hybrid search with filters. Returns raw JSON with scores. Use for detailed exploration or admin tooling.',
    inputSchema: {
      query: z.string().describe('Search query'),
      project: z.string().optional().describe('Filter by project'),
      source_type: z
        .enum(['fact', 'decision', 'preference', 'bug_fix', 'architecture', 'code_context'])
        .optional()
        .describe('Filter by source type'),
      limit: z.number().default(20).describe('Max results'),
    },
  },
  async ({ query, project, source_type, limit }) => {
    try {
      const hits = await memorySearch({
        query,
        project: project ?? null,
        source_type: source_type ?? null,
        limit: limit || 20,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(hits, null, 2) }],
      };
    } catch (err) {
      console.error('[mnestra-mcp] memory_search failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_forget ────────────────────────────────────────────────────────

server.registerTool(
  'memory_forget',
  {
    title: 'Forget',
    description: 'Soft-delete a memory by UUID. The row is archived but preserved.',
    inputSchema: {
      memoryId: z.string().uuid().describe('UUID of the memory to forget'),
    },
  },
  async ({ memoryId }) => {
    try {
      const result = await memoryForget(memoryId);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }] };
      }
      return { content: [{ type: 'text' as const, text: `Memory ${memoryId} archived.` }] };
    } catch (err) {
      console.error('[mnestra-mcp] memory_forget failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_status ────────────────────────────────────────────────────────

server.registerTool(
  'memory_status',
  {
    title: 'Memory Status',
    description:
      'System stats: total active memories, sessions, breakdown by project / source_type / category.',
    inputSchema: {},
  },
  async () => {
    try {
      const report = await memoryStatus();
      return { content: [{ type: 'text' as const, text: formatStatus(report) }] };
    } catch (err) {
      console.error('[mnestra-mcp] memory_status failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_summarize_session ─────────────────────────────────────────────

server.registerTool(
  'memory_summarize_session',
  {
    title: 'Summarize Session',
    description:
      'Extract discrete facts from text (a session transcript, document, or any text) and store them as memories. Uses Claude Haiku.',
    inputSchema: {
      text: z.string().describe('The text to extract facts from'),
      project: z.string().default('global').describe('Project name'),
    },
  },
  async ({ text, project }) => {
    try {
      const result = await memorySummarizeSession(text, project || 'global');
      if (result.total === 0) {
        return { content: [{ type: 'text' as const, text: 'No facts extracted from the text.' }] };
      }
      const summary = result.facts
        .map((f, i) => `${i + 1}. [${f.category ?? 'uncategorized'}/${f.importance}] ${f.content}`)
        .join('\n');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Extracted ${result.total} facts: ${result.inserted} stored, ${result.updated} updated, ${result.skipped} skipped.\n\n${summary}`,
          },
        ],
      };
    } catch (err) {
      console.error('[mnestra-mcp] memory_summarize_session failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_index ─────────────────────────────────────────────────────────

server.registerTool(
  'memory_index',
  {
    title: 'Memory Index',
    description:
      'Three-layer search — step 1. Returns a compact index of matching memories (≤120-char snippet, source_type, project, created_at). Use this first; drill into IDs with memory_get, or surround with memory_timeline. Much cheaper in tokens than memory_recall.',
    inputSchema: {
      query: z.string().describe('Search query'),
      project: z.string().optional().describe('Filter by project'),
      source_type: z
        .enum(['fact', 'decision', 'preference', 'bug_fix', 'architecture', 'code_context'])
        .optional()
        .describe('Filter by source type'),
      limit: z.number().default(20).describe('Max results'),
    },
  },
  async ({ query, project, source_type, limit }) => {
    try {
      const hits = await memoryIndex({
        query,
        project: project ?? null,
        source_type: source_type ?? null,
        limit: limit || 20,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(hits, null, 2) }] };
    } catch (err) {
      console.error('[mnestra-mcp] memory_index failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_timeline ──────────────────────────────────────────────────────

server.registerTool(
  'memory_timeline',
  {
    title: 'Memory Timeline',
    description:
      'Three-layer search — step 2. Returns memories from the same project chronologically surrounding either a query hit or a specific observation ID. Compact shape matches memory_index. Use after memory_index when you want temporal context.',
    inputSchema: {
      query: z.string().optional().describe('Query to locate the anchor memory (optional)'),
      around_id: z
        .string()
        .uuid()
        .optional()
        .describe('Anchor by an explicit memory UUID (optional)'),
      window: z
        .enum(['1h', '24h', '7d'])
        .default('24h')
        .describe('Time window around the anchor'),
    },
  },
  async ({ query, around_id, window }) => {
    try {
      const hits = await memoryTimeline({
        query,
        around_id,
        window: window || '24h',
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(hits, null, 2) }] };
    } catch (err) {
      console.error('[mnestra-mcp] memory_timeline failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_get ───────────────────────────────────────────────────────────

server.registerTool(
  'memory_get',
  {
    title: 'Memory Get (batch)',
    description:
      'Three-layer search — step 3. Batch-fetch full memory rows by UUID. Pass the IDs returned by memory_index or memory_timeline. Batch-only (up to 100 IDs) to discourage N+1 calls.',
    inputSchema: {
      ids: z
        .array(z.string().uuid())
        .min(1)
        .max(100)
        .describe('Array of memory UUIDs to fetch (1–100)'),
    },
  },
  async ({ ids }) => {
    try {
      const rows = await memoryGet({ ids });
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
    } catch (err) {
      console.error('[mnestra-mcp] memory_get failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_link ──────────────────────────────────────────────────────────

const RELATIONSHIP_KIND_ENUM = z.enum([
  'supersedes',
  'relates_to',
  'contradicts',
  'elaborates',
  'caused_by',
  'blocks',
  'inspired_by',
  'cross_project_link',
]);

server.registerTool(
  'memory_link',
  {
    title: 'Link Memories',
    description:
      'Connect two memories with a typed relationship. Idempotent on (source_id, target_id, kind) — re-linking the same pair updates the weight rather than inserting a duplicate. Edges are bidirectional for traversal.',
    inputSchema: {
      source_id: z.string().uuid().describe('UUID of the source memory'),
      target_id: z.string().uuid().describe('UUID of the target memory'),
      kind: RELATIONSHIP_KIND_ENUM.describe(
        'Edge type: supersedes, relates_to, contradicts, elaborates, caused_by, blocks, inspired_by, cross_project_link'
      ),
      weight: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Edge confidence in [0,1] (optional)'),
    },
  },
  async ({ source_id, target_id, kind, weight }) => {
    try {
      const result = await memoryLink({
        source_id,
        target_id,
        kind,
        weight: weight ?? null,
      });
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }] };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Edge ${result.action}: ${source_id} —[${kind}]→ ${target_id} (id: ${result.id})`,
          },
        ],
      };
    } catch (err) {
      console.error('[mnestra-mcp] memory_link failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_unlink ────────────────────────────────────────────────────────

server.registerTool(
  'memory_unlink',
  {
    title: 'Unlink Memories',
    description:
      'Remove a relationship between two memories. If `kind` is omitted, removes ALL kinds between the pair. Hard delete (no soft-delete archive — relationships are cheap to re-infer).',
    inputSchema: {
      source_id: z.string().uuid().describe('UUID of the source memory'),
      target_id: z.string().uuid().describe('UUID of the target memory'),
      kind: RELATIONSHIP_KIND_ENUM.optional().describe(
        'Edge kind to remove. Omit to remove all kinds between the pair.'
      ),
    },
  },
  async ({ source_id, target_id, kind }) => {
    try {
      const result = await memoryUnlink({ source_id, target_id, kind });
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }] };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Removed ${result.removed} edge(s) between ${source_id} and ${target_id}${kind ? ` (kind=${kind})` : ''}.`,
          },
        ],
      };
    } catch (err) {
      console.error('[mnestra-mcp] memory_unlink failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── memory_related ───────────────────────────────────────────────────────

server.registerTool(
  'memory_related',
  {
    title: 'Related Memories (graph traversal)',
    description:
      'Return the N-hop neighborhood of a memory by walking memory_relationships. Optional `kind` filter restricts to paths whose every edge has that type. Hydrated with content/source_type/project for each reachable memory. Cycle-safe.',
    inputSchema: {
      id: z.string().uuid().describe('UUID of the seed memory'),
      depth: z
        .number()
        .int()
        .min(1)
        .max(5)
        .default(2)
        .describe('Max hops to traverse (1–5, default 2)'),
      kind: RELATIONSHIP_KIND_ENUM.optional().describe(
        'Filter to paths whose every edge has this kind (omit for all kinds)'
      ),
    },
  },
  async ({ id, depth, kind }) => {
    try {
      const rows = await memoryRelated({
        id,
        depth: depth || 2,
        kind: kind ?? null,
      });
      if (rows.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No related memories found.' }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
    } catch (err) {
      console.error('[mnestra-mcp] memory_related failed:', err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
      };
    }
  }
);

// ── Start Server ─────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mnestra-mcp] mnestra MCP server listening on stdio');
}
