/**
 * Mnestra — HTTP webhook server
 *
 * Exposes the same functions the MCP stdio server dispatches to, over a
 * tiny HTTP surface. TermDeck and other clients POST terminal events
 * here instead of spawning an MCP child process per ingest.
 *
 *   POST /mnestra           { op: 'remember'|'recall'|'search'|'status'
 *                                 |'index'|'timeline'|'get'|'propose'
 *                                 |'session_record'|'feedback', ...args }
 *   GET  /healthz          liveness + store stats
 *   GET  /observation/:id  single memory by UUID (citation endpoint)
 *
 * Port: MNESTRA_WEBHOOK_PORT, default 37778.
 *
 * Sprint 76 T1 — the `propose` op is the web-surface quarantine channel
 * ("CLIs write canonical; web chats write proposals"): it inserts into
 * public.memory_inbox via the validating memory_propose RPC and NEVER
 * touches memory_items. It exists for the MCP bridge (Sprint 76 T2) only;
 * the stdio MCP server deliberately registers no memory_propose tool
 * (local MCP callers are CLI trust domain and use memory_remember).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

import { memoryRecall, type RecallOutput } from './recall.js';
import { recordRecallFeedback } from './recall_log.js';
import { memoryRemember } from './remember.js';
import { memoryPropose, isProposeRejected } from './propose.js';
import { memorySessionRecord, isSessionRecordRejected } from './session_record.js';
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
  ProposeInput,
  ProposeResult,
  SessionRecordInput,
  SessionRecordResult,
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
  /** Sprint 76 T1: quarantined web-proposal channel (memory_inbox only). */
  propose: (input: ProposeInput) => Promise<ProposeResult>;
  /**
   * Sprint 84 T2: end-of-conversation capture for web surfaces
   * (memory_sessions only — the Rumen tick's input queue, which no recall
   * path reads). Optional so pre-84 test deps objects still typecheck; the
   * handler 501s when it is absent rather than pretending to have written.
   */
  session_record?: (input: SessionRecordInput) => Promise<SessionRecordResult>;
  /**
   * Sprint 78 T3: recall-telemetry feedback receiver (fire-and-forget). The
   * `op:'feedback'` handler calls this; the default impl marks the memory's
   * most-recent recall-log row cited/dismissed. Void return — never awaited,
   * never affects the HTTP response latency. Optional so existing test deps
   * objects (which predate it) still typecheck; the handler invokes it as
   * `deps.feedback?.(…)`.
   */
  feedback?: (memoryId: string, event: 'cited' | 'dismissed') => void;
}

export const defaultDeps: OpDeps = {
  remember: memoryRemember,
  recall: memoryRecall,
  search: memorySearch,
  status: memoryStatus,
  index: memoryIndex,
  timeline: memoryTimeline,
  get: memoryGet,
  propose: memoryPropose,
  session_record: memorySessionRecord,
  feedback: (memoryId, event) => recordRecallFeedback(memoryId, event),
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
          // Sprint 79 T1 — same expansion as the MCP memory_remember tool,
          // for parity between the two write surfaces.
          sprint_ref: args.sprint_ref as RememberInput['sprint_ref'],
          rule_ref: args.rule_ref as RememberInput['rule_ref'],
          supersedes: args.supersedes as RememberInput['supersedes'],
          force: args.force as RememberInput['force'],
          refresh: args.refresh as RememberInput['refresh'],
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
          // Sprint 78 T3 — tag over-the-wire recall so the telemetry log
          // distinguishes webhook-sourced recall from MCP-stdio recall.
          log_surface: 'webhook',
          log_session_id: (args.source_session_id ?? null) as string | null,
          log_source_agent: (args.source_agent ?? null) as string | null,
        });
        return {
          status: 200,
          body: {
            ok: true,
            hits: out.hits,
            tokens_used: out.tokens_used,
            text: out.text,
            // Sprint 83 T2 — over-the-wire callers get the reinjection-event
            // id too, so a web-surface consumer can cite through
            // `op:'feedback'` (or the group-keyed citation op) rather than
            // being limited to the memory_get path.
            recall_group_id: out.recall_group_id,
          },
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
          // Sprint 78 T3 — tag over-the-wire search (see recall above).
          log_surface: 'webhook',
          log_session_id: (args.source_session_id ?? null) as string | null,
          log_source_agent: (args.source_agent ?? null) as string | null,
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
      case 'propose': {
        // Sprint 76 T1 — bridge-only quarantine channel. Strict field names
        // (no content/text aliasing like `remember`): the T2 bridge is the
        // sole caller and builds to this contract. Validation rejections
        // (TS mirror or the SQL RPC, both prefixed MEMORY_PROPOSE_REJECTED)
        // are client errors → 400 with the reason for the bridge to surface
        // to the connector; anything else stays a 500 via the outer catch.
        const sourceAgent = args.source_agent as string | undefined;
        if (!sourceAgent) {
          return { status: 400, body: { ok: false, error: 'propose requires source_agent' } };
        }
        const text = args.text as string | undefined;
        if (!text) {
          return { status: 400, body: { ok: false, error: 'propose requires text' } };
        }
        try {
          const result = await deps.propose({
            source_agent: sourceAgent,
            text,
            project_hint: (args.project_hint ?? null) as string | null,
            metadata: args.metadata as Record<string, unknown> | undefined,
          });
          return { status: 200, body: { ok: true, id: result.id, status: 'pending' } };
        } catch (err) {
          if (isProposeRejected(err)) {
            return { status: 400, body: { ok: false, error: (err as Error).message } };
          }
          throw err;
        }
      }
      case 'session_record': {
        // Sprint 84 T2 — bridge-only end-of-conversation capture for web
        // surfaces. Strict field names (no aliasing like `remember`): the
        // bridge is the sole caller and builds to this contract. Validation
        // rejections (TS mirror or the SQL RPC, both prefixed
        // MEMORY_SESSION_RECORD_REJECTED) are client errors → 400 with the
        // reason for the bridge to surface to the connector; anything else
        // stays a 500 via the outer catch.
        //
        // NOTE ON session_id: there is no `session_id` argument, by design.
        // The RPC mints it as web:<source_agent>:<conversation_key>, which is
        // what makes the upsert unable to reach a CLI/hook-written row. A
        // caller-supplied session_id would hand that guard away.
        if (typeof deps.session_record !== 'function') {
          // An older deps object (pre-84). Say so rather than 200-ing a write
          // that did not happen.
          return {
            status: 501,
            body: { ok: false, error: 'session_record op not available on this Mnestra build' },
          };
        }
        const sourceAgent = args.source_agent as string | undefined;
        if (!sourceAgent) {
          return { status: 400, body: { ok: false, error: 'session_record requires source_agent' } };
        }
        const conversationKey = args.conversation_key as string | undefined;
        if (!conversationKey) {
          return { status: 400, body: { ok: false, error: 'session_record requires conversation_key' } };
        }
        const summary = args.summary as string | undefined;
        if (!summary) {
          return { status: 400, body: { ok: false, error: 'session_record requires summary' } };
        }
        try {
          const result = await deps.session_record({
            source_agent: sourceAgent,
            conversation_key: conversationKey,
            summary,
            project: (args.project ?? null) as string | null,
            messages_count: (args.messages_count ?? null) as number | null,
            started_at: (args.started_at ?? null) as string | null,
            ended_at: (args.ended_at ?? null) as string | null,
            topics: args.topics as unknown[] | undefined,
            metadata: args.metadata as Record<string, unknown> | undefined,
          });
          return {
            status: 200,
            body: { ok: true, id: result.id, session_id: result.session_id },
          };
        } catch (err) {
          if (isSessionRecordRejected(err)) {
            return { status: 400, body: { ok: false, error: (err as Error).message } };
          }
          throw err;
        }
      }
      case 'feedback': {
        // Sprint 78 T3 — recall-telemetry feedback receiver (HANDOFF seam with
        // T2's flashback "clicked" route; T3 owns the server end-to-end per
        // PLANNING §8.3). Validate strictly, then fire the signal
        // fire-and-forget so the 200 is never gated on a DB round-trip.
        const memoryId = args.memory_id as string | undefined;
        const event = args.event as string | undefined;
        if (!memoryId || !UUID_RE.test(memoryId)) {
          return {
            status: 400,
            body: { ok: false, error: 'feedback requires a valid memory_id (uuid)' },
          };
        }
        if (event !== 'cited' && event !== 'dismissed') {
          return {
            status: 400,
            body: { ok: false, error: "feedback event must be 'cited' or 'dismissed'" },
          };
        }
        deps.feedback?.(memoryId, event);
        return { status: 200, body: { ok: true, recorded: event } };
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

async function handleObservation(
  id: string,
  client?: SupabaseClient
): Promise<DispatchResult> {
  if (!UUID_RE.test(id)) {
    return { status: 400, body: { ok: false, error: 'invalid id' } };
  }
  // Return the same row shape as `memory_get` so the HTTP citation
  // endpoint and the MCP stdio tool are interchangeable. We intentionally
  // omit the `embedding` vector — it's useless for citations and inflates
  // the response by ~6 KB per row.
  const supabase = client ?? getSupabase();
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

async function handleHealth(client?: SupabaseClient): Promise<DispatchResult> {
  try {
    const supabase = client ?? getSupabase();
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

// ── Shared-secret auth (Sprint 78 T3, ITEM ZERO) ───────────────────────────
//
// The webhook is the network ingress to the memory store. Before Sprint 78 it
// had NO auth and bound all interfaces — anything that could reach :37778 could
// poison the corpus (writes) or exfiltrate it (reads). The gate: a shared
// secret read once at boot from MNESTRA_WEBHOOK_SECRET (env, else
// ~/.termdeck/secrets.env), checked on every route except /healthz with a
// constant-time compare. Fail-CLOSED for the network (no secret configured ⇒
// every request 401), fail-SOFT for the process (log once, never crash).

const WEBHOOK_SECRET_ENV = 'MNESTRA_WEBHOOK_SECRET';

/**
 * Tiny KEY=VALUE reader for ~/.termdeck/secrets.env. No new dependency;
 * ignores blank lines + `#` comments; strips one layer of surrounding quotes.
 */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Resolve the configured secret: env first, then ~/.termdeck/secrets.env. */
function loadWebhookSecret(): string | null {
  const fromEnv = process.env[WEBHOOK_SECRET_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  try {
    const path = join(homedir(), '.termdeck', 'secrets.env');
    const parsed = parseEnvFile(readFileSync(path, 'utf8'));
    const v = parsed[WEBHOOK_SECRET_ENV];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  } catch {
    // fail-soft: file missing / unreadable → treated as "no secret configured"
    // (the caller then rejects every request — fail-closed for the network).
  }
  return null;
}

/** Extract the presented secret from the x-mnestra-secret or Bearer header. */
function presentedSecret(req: IncomingMessage): string | null {
  const direct = req.headers['x-mnestra-secret'];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * Constant-time secret comparison. timingSafeEqual demands equal-length
 * buffers, so compare fixed-length SHA-256 digests — neither the secret value
 * NOR its length leaks via an early-out.
 */
function secretsMatch(presented: string, configured: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(configured).digest();
  return timingSafeEqual(a, b);
}

/** Authorize a request against the configured secret. Fail-closed. */
function isAuthorized(req: IncomingMessage, configured: string | null): boolean {
  if (!configured) return false; // fail-closed: no secret set ⇒ reject all
  const presented = presentedSecret(req);
  if (presented === null) return false;
  return secretsMatch(presented, configured);
}

export interface WebhookServerOptions {
  port?: number;
  deps?: OpDeps;
  /**
   * Sprint 76 T1: override the Supabase client used by the two endpoints
   * that don't go through OpDeps (GET /observation/:id and GET /healthz),
   * so tests — the quarantine proof in particular — can drive them
   * hermetically. Default: getSupabase().
   */
  client?: SupabaseClient;
  /**
   * Sprint 78 T3: override the shared secret (tests). Default: env
   * MNESTRA_WEBHOOK_SECRET, else ~/.termdeck/secrets.env. When unset/empty the
   * server runs fail-closed — every request is rejected 401.
   */
  secret?: string;
  /**
   * Sprint 78 T3: override the bind host (tests / LAN). Default: env
   * MNESTRA_WEBHOOK_HOST / MNESTRA_WEBHOOK_BIND, else 127.0.0.1.
   */
  host?: string;
}

export function startWebhookServer(opts: WebhookServerOptions = {}): Server {
  const port = opts.port ?? Number(process.env.MNESTRA_WEBHOOK_PORT ?? 37778);
  const deps = opts.deps ?? defaultDeps;

  // Sprint 78 T3 — resolve the shared secret + bind host once at boot.
  const secret = opts.secret ?? loadWebhookSecret();
  if (!secret) {
    console.error(
      `[mnestra-webhook] ${WEBHOOK_SECRET_ENV} is not set (checked env + ~/.termdeck/secrets.env). ` +
        `Running fail-closed: every request returns 401 until the secret is configured.`
    );
  }
  // Default to loopback-only. The LAN override (MNESTRA_WEBHOOK_HOST /
  // MNESTRA_WEBHOOK_BIND, e.g. '0.0.0.0') is intentionally undocumented in user
  // docs — it's only for a deliberate second-machine deployment, where the
  // shared secret above is what keeps the endpoint from being an open
  // memory-poisoning / exfiltration surface (PLANNING §2 dec. 6).
  // `.trim() || '127.0.0.1'` is load-bearing: `??` only catches null/undefined,
  // so a bare `export MNESTRA_WEBHOOK_HOST=` (empty string) would slip through
  // and `server.listen(port, '')` binds ALL interfaces — silently defeating the
  // loopback-only default. Collapse empty/whitespace back to 127.0.0.1.
  const host =
    (
      opts.host ??
      process.env.MNESTRA_WEBHOOK_HOST ??
      process.env.MNESTRA_WEBHOOK_BIND ??
      '127.0.0.1'
    ).trim() || '127.0.0.1';

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      // Sprint 78 T3 ITEM ZERO — auth gate. Runs BEFORE any routing, so no op
      // executes and no memory content is returned without the secret. Only
      // the /healthz liveness probe is exempt (aggregate counts, no content).
      // This covers POST /mnestra (every op via dispatchOp) AND the
      // GET /observation/:id read-exfil path. Loopback presents the secret too
      // — no IP-based bypass, keeping the contract uniform for the Sprint 79
      // materializer and T2's feedback POST.
      if (url.pathname !== '/healthz' && !isAuthorized(req, secret)) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }

      if (req.method === 'POST' && url.pathname === '/mnestra') {
        const body = await readJsonBody(req);
        const result = await dispatchOp(body, deps);
        return sendJson(res, result.status, result.body);
      }

      if (req.method === 'GET' && url.pathname === '/healthz') {
        const result = await handleHealth(opts.client);
        return sendJson(res, result.status, result.body);
      }

      if (req.method === 'GET' && url.pathname.startsWith('/observation/')) {
        const id = decodeURIComponent(url.pathname.slice('/observation/'.length));
        const result = await handleObservation(id, opts.client);
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

  server.listen(port, host, () => {
    console.error(`[mnestra-webhook] listening on ${host}:${port}`);
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
