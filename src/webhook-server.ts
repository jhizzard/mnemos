/**
 * Mnestra — HTTP webhook server
 *
 * Exposes the same functions the MCP stdio server dispatches to, over a
 * tiny HTTP surface. TermDeck and other clients POST terminal events
 * here instead of spawning an MCP child process per ingest.
 *
 *   POST /mnestra           { op: 'remember'|'recall'|'search'|'status', ...args }
 *   GET  /healthz          liveness + store stats
 *   GET  /observation/:id  single memory by UUID (citation endpoint)
 *
 * Port: MNESTRA_WEBHOOK_PORT, default 37778.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { memoryRecall, type RecallOutput } from './recall.js';
import { memoryRemember } from './remember.js';
import { memorySearch } from './search.js';
import { memoryStatus } from './status.js';
import {
  memoryIndex,
  memoryTimeline,
  memoryGet,
  type IndexHit,
  type IndexInput,
  type TimelineInput,
  type TimelineWindow,
  type GetInput,
} from './layered.js';
import { getSupabase } from './db.js';
import type {
  MemoryItem,
  RecallHit,
  RecallInput,
  RememberInput,
  RememberResult,
  SearchInput,
  SourceType,
  StatusReport,
} from './types.js';

export const WEBHOOK_VERSION = '0.2.1';

export interface OpDeps {
  remember: (input: RememberInput) => Promise<RememberResult>;
  recall: (input: RecallInput) => Promise<RecallOutput>;
  search: (input: SearchInput) => Promise<RecallHit[]>;
  status: () => Promise<StatusReport>;
  index: (input: IndexInput) => Promise<IndexHit[]>;
  timeline: (input: TimelineInput) => Promise<IndexHit[]>;
  get: (input: GetInput) => Promise<MemoryItem[]>;
}

export const defaultDeps: OpDeps = {
  remember: memoryRemember,
  recall: memoryRecall,
  search: memorySearch,
  status: memoryStatus,
  index: memoryIndex,
  timeline: memoryTimeline,
  get: memoryGet,
};

export interface DispatchResult {
  status: number;
  body: unknown;
}

/**
 * Dispatch a `{ op, ...args }` payload to the matching Mnestra function.
 * Exported so tests can drive it with mocked deps.
 */
export async function dispatchOp(
  payload: unknown,
  deps: OpDeps = defaultDeps
): Promise<DispatchResult> {
  if (!payload || typeof payload !== 'object') {
    return { status: 400, body: { ok: false, error: 'body must be a JSON object' } };
  }
  const { op, ...args } = payload as { op?: string } & Record<string, unknown>;
  if (!op) {
    return { status: 400, body: { ok: false, error: 'missing "op" field' } };
  }

  try {
    switch (op) {
      case 'remember': {
        const content = (args.content ?? args.text) as string | undefined;
        if (!content) {
          return { status: 400, body: { ok: false, error: 'remember requires content' } };
        }
        const result = await deps.remember({
          content,
          project: args.project as string | undefined,
          source_type: args.source_type as RememberInput['source_type'],
          category: (args.category ?? null) as RememberInput['category'],
          metadata: args.metadata as Record<string, unknown> | undefined,
          // Sprint 74 T1: forward writer provenance. TermDeck's capture
          // paths have sent this field since Sprint 50 (server index.js
          // onPanelClose/periodic stamp `adapter.sourceAgent || name`);
          // until now the webhook silently dropped it and rows landed
          // with source_agent NULL. remember.ts normalizes the value.
          source_agent: args.source_agent as RememberInput['source_agent'],
        });
        return { status: 200, body: { ok: true, result } };
      }
      case 'recall': {
        const query = (args.question ?? args.query) as string | undefined;
        if (!query) {
          return { status: 400, body: { ok: false, error: 'recall requires question/query' } };
        }
        const out = await deps.recall({
          query,
          project: (args.project ?? null) as string | null,
          token_budget: args.token_budget as number | undefined,
          min_results: args.min_results as number | undefined,
        });
        return {
          status: 200,
          body: { ok: true, hits: out.hits, tokens_used: out.tokens_used, text: out.text },
        };
      }
      case 'search': {
        const query = args.query as string | undefined;
        if (!query) {
          return { status: 400, body: { ok: false, error: 'search requires query' } };
        }
        const hits = await deps.search({
          query,
          project: (args.project ?? null) as string | null,
          source_type: (args.source_type ?? null) as SearchInput['source_type'],
          limit: args.limit as number | undefined,
        });
        return { status: 200, body: { ok: true, hits } };
      }
      case 'status': {
        const report = await deps.status();
        return { status: 200, body: { ok: true, ...report } };
      }
      case 'index': {
        const query = args.query as string | undefined;
        if (!query) {
          return { status: 400, body: { ok: false, error: 'index requires query' } };
        }
        const hits = await deps.index({
          query,
          project: (args.project ?? null) as string | null,
          source_type: (args.source_type ?? null) as SourceType | null,
          limit: args.limit as number | undefined,
        });
        return { status: 200, body: { ok: true, hits } };
      }
      case 'timeline': {
        const window = (args.window ?? '24h') as TimelineWindow;
        const hits = await deps.timeline({
          query: args.query as string | undefined,
          around_id: args.around_id as string | undefined,
          window,
        });
        return { status: 200, body: { ok: true, hits } };
      }
      case 'get': {
        const ids = args.ids as string[] | undefined;
        if (!ids) {
          return { status: 400, body: { ok: false, error: 'get requires ids array' } };
        }
        const rows = await deps.get({ ids });
        return { status: 200, body: { ok: true, rows } };
      }
      default:
        return { status: 400, body: { ok: false, error: `unknown op: ${op}` } };
    }
  } catch (err) {
    return { status: 500, body: { ok: false, error: (err as Error).message } };
  }
}

/**
 * Tagged error for HTTP semantics — the outer request handler inspects
 * `httpStatus` to decide the response code. Malformed JSON is a client
 * error (400), not a server error (500).
 */
class HttpError extends Error {
  httpStatus: number;
  constructor(status: number, message: string) {
    super(message);
    this.httpStatus = status;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handleObservation(id: string): Promise<DispatchResult> {
  if (!UUID_RE.test(id)) {
    return { status: 400, body: { ok: false, error: 'invalid id' } };
  }
  // Return the same row shape as `memory_get` so the HTTP citation
  // endpoint and the MCP stdio tool are interchangeable. We intentionally
  // omit the `embedding` vector — it's useless for citations and inflates
  // the response by ~6 KB per row.
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('memory_items')
    .select(
      'id, content, source_type, category, project, metadata, is_active, archived, superseded_by, created_at, updated_at'
    )
    .eq('id', id)
    .eq('archived', false)
    .maybeSingle();
  if (error) return { status: 500, body: { ok: false, error: error.message } };
  if (!data) return { status: 404, body: { ok: false, error: 'not found' } };
  return { status: 200, body: data };
}

async function handleHealth(): Promise<DispatchResult> {
  try {
    const supabase = getSupabase();
    const { count } = await supabase
      .from('memory_items')
      .select('id', { count: 'exact', head: true })
      .eq('is_active', true)
      .eq('archived', false);
    const { data } = await supabase
      .from('memory_items')
      .select('updated_at')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastWrite = (data as { updated_at?: string } | null)?.updated_at ?? null;
    return {
      status: 200,
      body: {
        ok: true,
        version: WEBHOOK_VERSION,
        store: { rows: count ?? 0, last_write: lastWrite },
      },
    };
  } catch (err) {
    return {
      status: 200,
      body: {
        ok: true,
        version: WEBHOOK_VERSION,
        store: { rows: 0, last_write: null },
        warn: (err as Error).message,
      },
    };
  }
}

export interface WebhookServerOptions {
  port?: number;
  deps?: OpDeps;
}

export function startWebhookServer(opts: WebhookServerOptions = {}): Server {
  const port = opts.port ?? Number(process.env.MNESTRA_WEBHOOK_PORT ?? 37778);
  const deps = opts.deps ?? defaultDeps;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (req.method === 'POST' && url.pathname === '/mnestra') {
        const body = await readJsonBody(req);
        const result = await dispatchOp(body, deps);
        return sendJson(res, result.status, result.body);
      }

      if (req.method === 'GET' && url.pathname === '/healthz') {
        const result = await handleHealth();
        return sendJson(res, result.status, result.body);
      }

      if (req.method === 'GET' && url.pathname.startsWith('/observation/')) {
        const id = decodeURIComponent(url.pathname.slice('/observation/'.length));
        const result = await handleObservation(id);
        return sendJson(res, result.status, result.body);
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      const status =
        err instanceof HttpError ? err.httpStatus : (err as { httpStatus?: number }).httpStatus ?? 500;
      if (status >= 500) console.error('[mnestra-webhook] handler error:', err);
      if (!res.headersSent) {
        sendJson(res, status, { ok: false, error: (err as Error).message });
      }
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[mnestra-webhook] port ${port} already bound — another \`mnestra serve\` is running. Exiting 0.`
      );
      process.exit(0);
    }
    throw err;
  });

  server.listen(port, () => {
    console.error(`[mnestra-webhook] listening on :${port}`);
  });

  const shutdown = (signal: string) => {
    console.error(`[mnestra-webhook] ${signal} received, closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  return server;
}
