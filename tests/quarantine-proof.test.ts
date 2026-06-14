/**
 * Mnestra — THE QUARANTINE PROOF (Sprint 76 T1 headline test)
 *
 * Policy under test: "CLIs write canonical; web chats write proposals."
 * A `status='pending'` row in public.memory_inbox must be invisible to
 * EVERY read surface in the repo. This suite drives the REAL functions
 * (not mocks) from the T1 inventory FINDING against an instrumented
 * in-memory store that:
 *
 *   1. CONTAINS a pending inbox row whose body carries a sentinel marker —
 *      and whose text deliberately includes the fixture keywords, so any
 *      reader that ever ingests the inbox WOULD match and surface it;
 *   2. SERVES memory_inbox if (and only if) some code path asks for it —
 *      the fake never hides the table, so these assertions have teeth
 *      (see the final "teeth" test, which reads it directly and proves the
 *      sentinel flows the moment something points at the inbox);
 *   3. RECORDS every table name requested via .from() and every rpc name,
 *      so beyond content checks we assert the inbox is never even queried.
 *
 * Each fake rpc() emulates ONLY the table-read semantics of the live SQL
 * function it stands in for (migration of record cited inline) — that is
 * the by-construction claim from the inventory, encoded executably. If a
 * future migration points an RPC at memory_inbox, the emulation here goes
 * stale, T4-style live probes catch it, and the SQL-text hygiene test
 * (tests/migration-026-hygiene.test.ts) pins the propose side; if a future
 * TS change points a reader at the inbox, THIS file goes red.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { memoryRecall } from '../src/recall.js';
import { memorySearch } from '../src/search.js';
import { memoryIndex, memoryTimeline, memoryGet } from '../src/layered.js';
import { memoryRecallGraph } from '../src/recall_graph.js';
import { memoryStatus } from '../src/status.js';
import { memoryRelated } from '../src/relationships.js';
import { exportMemories } from '../src/export-import.js';
import { memoryPropose } from '../src/propose.js';
import { dispatchOp, startWebhookServer, type OpDeps } from '../src/webhook-server.js';
import {
  WEB_SOURCE_AGENTS,
  type ProposeInput,
} from '../src/types.js';

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

const SENTINEL = 'QUARANTINE-SENTINEL-93b1';

const NOW = new Date().toISOString();

const ITEM_A = '00000000-0000-4000-8000-000000000001';
const ITEM_B = '00000000-0000-4000-8000-000000000002';
const INBOX_PENDING_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SESSION_ID = '00000000-0000-4000-8000-00000000aaaa';

interface Store {
  memory_items: any[];
  memory_sessions: any[];
  memory_relationships: any[];
  memory_inbox: any[];
}

function makeStore(): Store {
  return {
    memory_items: [
      {
        id: ITEM_A,
        content: 'TermDeck server listens on port 3000 (canonical fixture alpha)',
        source_type: 'fact',
        category: null,
        project: 'termdeck',
        metadata: {},
        is_active: true,
        archived: false,
        superseded_by: null,
        created_at: NOW,
        updated_at: NOW,
        embedding: [],
        privacy_tags: [],
        source_agent: 'claude',
      },
      {
        id: ITEM_B,
        content: 'Mnestra hybrid search fuses keyword and vector ranks (canonical fixture beta)',
        source_type: 'decision',
        category: 'architecture',
        project: 'termdeck',
        metadata: {},
        is_active: true,
        archived: false,
        superseded_by: null,
        created_at: NOW,
        updated_at: NOW,
        embedding: [],
        privacy_tags: [],
        source_agent: 'claude',
      },
    ],
    memory_sessions: [{ id: SESSION_ID, project: 'termdeck', summary: null, metadata: {}, created_at: NOW }],
    memory_relationships: [
      {
        id: '00000000-0000-4000-8000-00000000eeee',
        source_id: ITEM_A,
        target_id: ITEM_B,
        relationship_type: 'relates_to',
        weight: 0.9,
        created_at: NOW,
      },
    ],
    memory_inbox: [
      {
        id: INBOX_PENDING_ID,
        created_at: NOW,
        source_agent: 'grok-web',
        project_hint: 'termdeck',
        // Deliberately keyword-loaded: contains the fixture terms every
        // query below searches for, so a leak WOULD rank and surface.
        text: `${SENTINEL} canonical TermDeck Mnestra hybrid fixture proposal that must never appear in any recall`,
        status: 'pending',
        promoted_memory_id: null,
        rejection_reason: null,
        metadata: { bridge: { client_id: 'attacker-client' } },
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Instrumented fake Supabase client
// ─────────────────────────────────────────────────────────────────────────

interface Probe {
  /** Every table name passed to .from() — reads AND would-be writes. */
  tablesRequested: string[];
  /** Every rpc name invoked. */
  rpcCalls: string[];
}

/** Generic filter-aware PostgREST-builder stand-in over an array. */
function chainOver(rows: any[]): any {
  const filters: Array<(r: any) => boolean> = [];
  let orderSpec: { col: string; ascending: boolean } | null = null;
  let limitN: number | null = null;
  let rangeSpec: { from: number; to: number } | null = null;
  let head = false;
  let single = false;

  const chain: any = {
    select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.head) head = true;
      return chain;
    },
    eq: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return chain;
    },
    is: (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return chain;
    },
    in: (col: string, vals: unknown[]) => {
      filters.push((r) => vals.includes(r[col]));
      return chain;
    },
    gte: (col: string, val: any) => {
      filters.push((r) => r[col] >= val);
      return chain;
    },
    lte: (col: string, val: any) => {
      filters.push((r) => r[col] <= val);
      return chain;
    },
    order: (col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) => {
      orderSpec = { col, ascending: opts?.ascending !== false };
      return chain;
    },
    limit: (n: number) => {
      limitN = n;
      return chain;
    },
    range: (from: number, to: number) => {
      rangeSpec = { from, to };
      return chain;
    },
    maybeSingle: () => {
      single = true;
      return chain;
    },
    then: (resolve: (v: any) => void, reject?: (e: unknown) => void) => {
      try {
        let out = rows.filter((r) => filters.every((f) => f(r)));
        if (orderSpec) {
          const { col, ascending } = orderSpec;
          out = [...out].sort(
            (a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending ? 1 : -1)
          );
        }
        if (rangeSpec) out = out.slice(rangeSpec.from, rangeSpec.to + 1);
        if (limitN != null) out = out.slice(0, limitN);
        if (single) return resolve({ data: out[0] ? { ...out[0] } : null, error: null });
        if (head) return resolve({ data: null, count: out.length, error: null });
        resolve({ data: out.map((r) => ({ ...r })), count: out.length, error: null });
      } catch (err) {
        if (reject) reject(err);
        else throw err;
      }
    },
  };
  return chain;
}

const activeItem = (r: any) =>
  r.is_active === true && r.archived === false && r.superseded_by === null;

function makeClient(
  store: Store,
  probe: Probe,
  opts: { failStatusRpc?: boolean } = {}
): any {
  let proposeCounter = 0;

  return {
    from: (table: string) => {
      probe.tablesRequested.push(table);
      // Serve WHATEVER is asked for — including memory_inbox. The proof
      // must come from no reader asking, not from the fake hiding it.
      const rows = (store as unknown as Record<string, any[]>)[table] ?? [];
      return chainOver(rows);
    },
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      probe.rpcCalls.push(name);
      switch (name) {
        // migrations/023_privacy_tags_column.sql:126-256 — FROM memory_items
        // only (023:165). Tombstone + project filters as in the live body.
        case 'memory_hybrid_search': {
          const project = (args.filter_project as string | null) ?? null;
          const sourceType = (args.filter_source_type as string | null) ?? null;
          const data = store.memory_items
            .filter(activeItem)
            .filter((r) => (project ? r.project === project : true))
            .filter((r) => (sourceType ? r.source_type === sourceType : true))
            .slice(0, (args.match_count as number) ?? 20)
            .map((r) => ({
              id: r.id,
              content: r.content,
              source_type: r.source_type,
              category: r.category,
              project: r.project,
              metadata: r.metadata,
              score: 0.5,
              created_at: r.created_at,
              privacy_tags: r.privacy_tags ?? [],
            }));
          return { data, error: null };
        }
        // migrations/001_mnestra_tables.sql:121-155 — FROM memory_items only.
        case 'match_memories': {
          const project = (args.filter_project as string | null) ?? null;
          const data = store.memory_items
            .filter(activeItem)
            .filter((r) => (project ? r.project === project : true))
            .slice(0, (args.match_count as number) ?? 3)
            .map((r) => ({
              id: r.id,
              content: r.content,
              source_type: r.source_type,
              category: r.category,
              project: r.project,
              metadata: r.metadata,
              similarity: 0.9,
            }));
          return { data, error: null };
        }
        // migrations/010_memory_recall_graph.sql:30-139 — memory_items
        // (010:63, 010:95-99) + memory_relationships (010:87).
        case 'memory_recall_graph': {
          const project = (args.project_filter as string | null) ?? null;
          const seeds = store.memory_items
            .filter(activeItem)
            .filter((r) => (project ? r.project === project : true));
          const data = seeds.map((r) => ({
            memory_id: r.id,
            content: r.content,
            project: r.project,
            depth: 0,
            vector_score: 0.9,
            edge_weight: 1.0,
            recency_score: 1.0,
            final_score: 0.9,
            path: [r.id],
          }));
          return { data, error: null };
        }
        // migrations/006_memory_status_rpc.sql:13-55 — memory_items +
        // memory_sessions counts only.
        case 'memory_status_aggregation': {
          if (opts.failStatusRpc) {
            return { data: null, error: { message: 'migration 006 not applied (test variant)' } };
          }
          const actives = store.memory_items.filter(
            (r) => r.is_active === true && r.archived === false
          );
          const byProject: Record<string, number> = {};
          for (const r of actives) byProject[r.project] = (byProject[r.project] ?? 0) + 1;
          return {
            data: [
              {
                total_active: actives.length,
                sessions: store.memory_sessions.length,
                by_project: byProject,
                by_source_type: {},
                by_category: {},
              },
            ],
            error: null,
          };
        }
        // migrations/009_memory_relationship_metadata.sql:92-126 —
        // memory_relationships only.
        case 'expand_memory_neighborhood': {
          const start = args.start_id as string;
          const data = store.memory_relationships
            .filter((e) => e.source_id === start || e.target_id === start)
            .map((e) => {
              const other = e.source_id === start ? e.target_id : e.source_id;
              return {
                memory_id: other,
                depth: 1,
                path: [start, other],
                edge_kinds: [e.relationship_type],
              };
            });
          return {
            data: [{ memory_id: start, depth: 0, path: [start], edge_kinds: [] }, ...data],
            error: null,
          };
        }
        // migrations/026_memory_inbox.sql — the SECURITY DEFINER RPC.
        // Emulates whitelist + caps + status:'pending' INSERT; parity with
        // the SQL body is pinned by tests/migration-026-hygiene.test.ts.
        case 'memory_propose': {
          const agent = String(args.p_source_agent ?? '')
            .trim()
            .toLowerCase();
          if (!(WEB_SOURCE_AGENTS as readonly string[]).includes(agent)) {
            return {
              data: null,
              error: { message: `MEMORY_PROPOSE_REJECTED: invalid_source_agent (got ${agent})` },
            };
          }
          const text = String(args.p_text ?? '').trim();
          if (!text) return { data: null, error: { message: 'MEMORY_PROPOSE_REJECTED: empty_text' } };
          if (text.length > 4000) {
            return { data: null, error: { message: 'MEMORY_PROPOSE_REJECTED: text_too_long' } };
          }
          const id = `55555555-5555-4555-8555-${String(++proposeCounter).padStart(12, '0')}`;
          store.memory_inbox.push({
            id,
            created_at: new Date().toISOString(),
            source_agent: agent,
            project_hint: (args.p_project_hint as string | null) ?? null,
            text,
            status: 'pending',
            promoted_memory_id: null,
            rejection_reason: null,
            metadata: (args.p_metadata as Record<string, unknown>) ?? {},
          });
          return { data: id, error: null };
        }
        default:
          return { data: null, error: { message: `unexpected rpc ${name}` } };
      }
    },
  };
}

const fakeEmbed = async (_text: string) => new Array(1536).fill(0);

function assertClean(label: string, value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.ok(
    !serialized.includes(SENTINEL),
    `${label} leaked the quarantined proposal: ${serialized.slice(0, 300)}`
  );
}

function realOpDeps(client: any): OpDeps {
  const deps = { client, generateEmbedding: fakeEmbed };
  return {
    remember: async () => {
      throw new Error('remember not under test here');
    },
    recall: (input) => memoryRecall(input, deps),
    search: (input) => memorySearch(input, deps),
    status: () => memoryStatus(client),
    index: (input) => memoryIndex(input, deps),
    timeline: (input) => memoryTimeline(input, deps),
    get: (input) => memoryGet(input, deps),
    propose: (input: ProposeInput) => memoryPropose(input, { client }),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Every src read surface, driven for real
// ─────────────────────────────────────────────────────────────────────────

test('quarantine proof: a pending inbox row is invisible to every src read surface', async () => {
  const store = makeStore();
  const probe: Probe = { tablesRequested: [], rpcCalls: [] };
  const client = makeClient(store, probe);
  const deps = { client, generateEmbedding: fakeEmbed };

  // memory_recall — plain, project-filtered, and filtered FOR the web agent
  // (an attacker-aligned filter must still not pull the proposal).
  const recallPlain = await memoryRecall({ query: 'canonical fixture' }, deps);
  assert.ok(recallPlain.hits.length >= 2, 'sanity: canonical rows recall fine');
  assertClean('memory_recall', recallPlain);

  const recallWebFilter = await memoryRecall(
    { query: 'canonical fixture', source_agents: ['grok-web'] },
    deps
  );
  assertClean('memory_recall(source_agents=[grok-web])', recallWebFilter);
  assert.equal(
    recallWebFilter.hits.length,
    0,
    'no canonical row is grok-web yet, and the pending proposal must not satisfy the filter'
  );

  // memory_search (also the literal memory_hybrid_search direct-RPC shape).
  const search = await memorySearch({ query: 'canonical fixture' }, deps);
  assert.ok(search.length >= 2);
  assertClean('memory_search', search);

  // memory_index / memory_timeline / memory_get.
  const index = await memoryIndex({ query: 'canonical fixture' }, deps);
  assert.ok(index.length >= 2);
  assertClean('memory_index', index);

  const timeline = await memoryTimeline({ query: 'canonical fixture', window: '7d' }, deps);
  assert.ok(timeline.length >= 2);
  assertClean('memory_timeline', timeline);

  // The sharp one: hand memory_get the inbox row's EXACT UUID.
  const got = await memoryGet({ ids: [ITEM_A, INBOX_PENDING_ID] }, deps);
  assertClean('memory_get', got);
  assert.deepEqual(
    got.map((r) => r.id),
    [ITEM_A],
    'memory_get must resolve only the canonical row — the inbox UUID yields nothing'
  );

  // memory_recall_graph + memory_related (graph surfaces).
  const graph = await memoryRecallGraph({ query: 'canonical fixture' }, deps);
  assert.ok(graph.hits.length >= 2);
  assertClean('memory_recall_graph', graph);

  const related = await memoryRelated({ id: ITEM_A }, client);
  assert.ok(related.length >= 1);
  assertClean('memory_related', related);

  // memory_status — RPC path and the legacy client-side fallback.
  const status = await memoryStatus(client);
  assertClean('memory_status', status);
  assert.equal(status.total_active, 2, 'status counts memory_items only — not inbox rows');
  assert.equal(status.sessions, 1);

  const fallbackProbe: Probe = { tablesRequested: [], rpcCalls: [] };
  const fallbackClient = makeClient(store, fallbackProbe, { failStatusRpc: true });
  const statusFallback = await memoryStatus(fallbackClient);
  assertClean('memory_status(fallback)', statusFallback);
  assert.equal(statusFallback.total_active, 2);
  assert.ok(
    !fallbackProbe.tablesRequested.includes('memory_inbox'),
    'status fallback reads memory_items/memory_sessions only'
  );

  // export — full-store dump must not include quarantined proposals.
  const exported: string[] = [];
  const collector = { write: (line: string) => (exported.push(line), true) } as any;
  const report = await exportMemories({ out: collector, client });
  assert.equal(report.rows, 2);
  assertClean('exportMemories', exported);

  // The structural assertions: nothing ever even ASKED for the inbox.
  assert.ok(
    !probe.tablesRequested.includes('memory_inbox'),
    `no read surface may query memory_inbox (tables requested: ${[...new Set(probe.tablesRequested)].join(', ')})`
  );
  assert.deepEqual(
    [...new Set(probe.tablesRequested)].sort(),
    ['memory_items'],
    'the only table the driven read surfaces touch via PostgREST builders is memory_items'
  );
  const expectedRpcs = new Set([
    'memory_hybrid_search',
    'match_memories',
    'memory_recall_graph',
    'memory_status_aggregation',
    'expand_memory_neighborhood',
  ]);
  for (const name of probe.rpcCalls) {
    assert.ok(expectedRpcs.has(name), `unexpected rpc from a read surface: ${name}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 2. The webhook surface (dispatch ops + HTTP citation/health endpoints)
// ─────────────────────────────────────────────────────────────────────────

test('quarantine proof: webhook ops never surface the pending proposal', async () => {
  const store = makeStore();
  const probe: Probe = { tablesRequested: [], rpcCalls: [] };
  const client = makeClient(store, probe);
  const ops = realOpDeps(client);

  const payloads: Array<Record<string, unknown>> = [
    { op: 'recall', question: 'canonical fixture' },
    { op: 'search', query: 'canonical fixture' },
    { op: 'index', query: 'canonical fixture' },
    { op: 'timeline', query: 'canonical fixture', window: '7d' },
    { op: 'get', ids: [ITEM_A, INBOX_PENDING_ID] },
    { op: 'status' },
  ];
  for (const payload of payloads) {
    const result = await dispatchOp(payload, ops);
    assert.equal(result.status, 200, `op ${payload.op} should succeed`);
    assertClean(`webhook op ${payload.op}`, result.body);
  }
  assert.ok(!probe.tablesRequested.includes('memory_inbox'));
});

test('quarantine proof: GET /observation/<inbox-uuid> is 404; /healthz counts canonical rows only', async () => {
  const store = makeStore();
  const probe: Probe = { tablesRequested: [], rpcCalls: [] };
  const client = makeClient(store, probe);
  // Sprint 78 T3: /observation is a memory-content read path → now behind the
  // shared secret. Authenticate those reads; /healthz stays exempt (asserted
  // below by NOT sending the header).
  const QP_SECRET = 'quarantine-test-secret';
  const QP_AUTH = { 'x-mnestra-secret': QP_SECRET };
  const server = startWebhookServer({
    port: 0,
    secret: QP_SECRET,
    deps: realOpDeps(client),
    client,
  });
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
  });
  try {
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const obsInbox = await fetch(`${base}/observation/${INBOX_PENDING_ID}`, { headers: QP_AUTH });
    assert.equal(
      obsInbox.status,
      404,
      'the citation endpoint must not resolve an inbox UUID — it reads memory_items only'
    );
    assertClean('GET /observation/<inbox-uuid>', await obsInbox.json());

    const obsCanonical = await fetch(`${base}/observation/${ITEM_A}`, { headers: QP_AUTH });
    assert.equal(obsCanonical.status, 200, 'sanity: canonical rows resolve');
    assertClean('GET /observation/<canonical-uuid>', await obsCanonical.json());

    // /healthz unauthenticated — proves the liveness exemption.
    const health = await fetch(`${base}/healthz`);
    const healthBody = (await health.json()) as { store: { rows: number } };
    assert.equal(health.status, 200);
    assert.equal(healthBody.store.rows, 2, 'healthz counts memory_items, not inbox rows');
    assertClean('GET /healthz', healthBody);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.ok(!probe.tablesRequested.includes('memory_inbox'));
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Propose → quarantine round trip
// ─────────────────────────────────────────────────────────────────────────

test('propose round trip: the proposal lands in the inbox (pending) and STAYS invisible to recall', async () => {
  const store = makeStore();
  store.memory_inbox.length = 0; // start with an empty inbox for clean counts
  const probe: Probe = { tablesRequested: [], rpcCalls: [] };
  const client = makeClient(store, probe);
  const ops = realOpDeps(client);
  const deps = { client, generateEmbedding: fakeEmbed };

  const proposalText = `${SENTINEL} canonical TermDeck fixture proposal submitted via the bridge`;
  const result = await dispatchOp(
    {
      op: 'propose',
      source_agent: ' Grok-Web ', // normalization exercised end-to-end
      text: proposalText,
      project_hint: 'termdeck',
      metadata: { bridge: { client_id: 'cid-web-1' } },
    },
    ops
  );
  assert.equal(result.status, 200);
  const body = result.body as { ok: boolean; id: string; status: string };
  assert.equal(body.ok, true);
  assert.equal(body.status, 'pending');

  // Quarantined, not lost: the row is durably in the inbox…
  assert.equal(store.memory_inbox.length, 1);
  assert.equal(store.memory_inbox[0]!.id, body.id);
  assert.equal(store.memory_inbox[0]!.status, 'pending');
  assert.equal(store.memory_inbox[0]!.source_agent, 'grok-web');

  // …and invisible everywhere, including memory_get by its fresh UUID.
  assertClean('post-propose recall', await memoryRecall({ query: 'canonical fixture proposal' }, deps));
  assertClean('post-propose search', await memorySearch({ query: 'canonical fixture proposal' }, deps));
  assertClean('post-propose index', await memoryIndex({ query: 'canonical fixture proposal' }, deps));
  const got = await memoryGet({ ids: [body.id] }, deps);
  assert.deepEqual(got, [], 'the fresh proposal id resolves to nothing on the canonical surface');
  const status = await memoryStatus(client);
  assert.equal(status.total_active, 2, 'proposing must not change canonical counts');

  // The ONLY rpc that ever names the inbox is the propose channel itself;
  // no PostgREST builder ever touched the table.
  assert.ok(!probe.tablesRequested.includes('memory_inbox'));
  assert.equal(probe.rpcCalls.filter((n) => n === 'memory_propose').length, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Teeth — prove a leak WOULD be caught
// ─────────────────────────────────────────────────────────────────────────

test('instrumentation teeth: a reader pointed at memory_inbox DOES surface the sentinel', async () => {
  const store = makeStore();
  const probe: Probe = { tablesRequested: [], rpcCalls: [] };
  const client = makeClient(store, probe);

  // Simulate the regression this suite guards against: some future read
  // path querying the inbox like any other table.
  const leaked = await client.from('memory_inbox').select('*').eq('status', 'pending');
  assert.equal(leaked.data.length, 1);
  assert.ok(
    JSON.stringify(leaked.data).includes(SENTINEL),
    'the fake store serves the inbox when asked — so the clean-output assertions above have teeth'
  );
  assert.ok(probe.tablesRequested.includes('memory_inbox'), 'and the probe records the access');
});
