/**
 * Mnestra — read-after-write staleness verdict test (Sprint 74 T3,
 * "flush-before-recall" — Brad's R730 gap-map item 3).
 *
 * THE QUESTION: when a client POSTs a memory to the webhook write path and a
 * bridge `memory_recall` arrives moments later, is the new row in the answer —
 * or is the connector a sync-cycle behind?
 *
 * WHAT THIS PROVES (and what it delegates):
 *
 *   1. The webhook's 200 for {op:'remember'} is sent strictly AFTER the row is
 *      committed to the store — the dispatch chain awaits embed → dedup →
 *      insert end-to-end (webhook-server.ts:88-100 → remember.ts:42,46,87).
 *      There is no queue, debounce, batch, or async embedding job that could
 *      produce an accepted-but-not-yet-recallable state.
 *   2. A recall issued the instant the 200 arrives sees the row, because
 *      memoryRecall reads the live store per call (fresh RPC, no cache —
 *      recall.ts:129-138).
 *   3. SENSITIVITY CONTROL: a deliberately broken server whose remember
 *      fire-and-forgets (200 before commit — the hypothetical async-accept
 *      design) makes the same immediate recall MISS. The verdict test would
 *      go red if anyone ever introduces that shape; green is meaningful.
 *
 *   Delegated to Postgres, not re-proven here: commit-then-visible ordering
 *   between two PostgREST calls on the same primary (read-committed). The
 *   fake store models exactly that contract: a row becomes readable at the
 *   moment its insert promise resolves, never before.
 *
 * Mechanism: the REAL HTTP server (startWebhookServer, port 0) dispatches to
 * the REAL memoryRemember / memoryRecall, injected with a shared in-memory
 * fake Supabase client. Every fake store operation resolves on a real async
 * hop (setImmediate), so any ordering the assertions observe can only come
 * from the production await chain — not from synchronous-by-accident fakes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { startWebhookServer, type OpDeps } from '../src/webhook-server.js';
import { memoryRemember } from '../src/remember.js';
import { memoryRecall } from '../src/recall.js';
import type { RememberInput } from '../src/types.js';

// Sprint 78 T3: the webhook now requires the shared secret. These tests drive
// the REAL HTTP server, so every POST authenticates with the test secret.
const RAW_SECRET = 'raw-test-secret';

interface StoreRow {
  id: string;
  content: string;
  source_type: string;
  category: string | null;
  project: string;
  metadata: Record<string, unknown>;
  score: number;
  created_at: string;
  privacy_tags: string[];
}

interface FakeStore {
  client: any;
  /** Committed rows — a row appears here only when its insert resolves. */
  rows: StoreRow[];
  /** Ordered trace of store + HTTP events for ordering assertions. */
  events: string[];
  /** Outstanding insert promises (the fire-and-forget control drains these). */
  pendingInserts: Promise<void>[];
}

/**
 * In-memory stand-in for the two Supabase surfaces the write+read paths use:
 * rpc('match_memories') (dedup probe), rpc('memory_hybrid_search') (recall),
 * from('memory_items').insert (the write). insertDelayMs widens the gap
 * between "writer started the insert" and "row committed" — the control test
 * uses a generous delay so 200-before-commit is unambiguous.
 */
function makeFakeStore(opts: { insertDelayMs?: number } = {}): FakeStore {
  const rows: StoreRow[] = [];
  const events: string[] = [];
  const pendingInserts: Promise<void>[] = [];
  let nextId = 1;

  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      await tick();
      if (name === 'match_memories') {
        events.push('rpc:match_memories');
        return { data: [], error: null }; // no near-dups → insert branch
      }
      assert.equal(name, 'memory_hybrid_search');
      events.push('rpc:memory_hybrid_search');
      // Read-committed semantics: only rows committed at call time are
      // candidates. Keyword filter stands in for the FTS leg.
      const queryText = String(args.query_text ?? '').toLowerCase();
      const terms = queryText.split(/\s+/).filter((t) => t.length >= 4);
      const data = rows
        .filter((r) => terms.some((t) => r.content.toLowerCase().includes(t)))
        .map((r) => ({ ...r }));
      return { data, error: null };
    },
    from: (table: string) => {
      assert.equal(table, 'memory_items');
      return {
        insert: (row: Record<string, unknown>) => {
          events.push('insert:start');
          const p = (async () => {
            await tick();
            if (opts.insertDelayMs) await delay(opts.insertDelayMs);
            rows.push({
              id: `00000000-0000-0000-0000-${String(nextId++).padStart(12, '0')}`,
              content: String(row.content),
              source_type: String(row.source_type),
              category: (row.category as string | null) ?? null,
              project: String(row.project),
              metadata: (row.metadata as Record<string, unknown>) ?? {},
              score: 0.5,
              created_at: new Date().toISOString(),
              privacy_tags: [],
            });
            events.push('insert:committed');
          })();
          pendingInserts.push(p.then(() => undefined));
          return p.then(() => ({ error: null }));
        },
      };
    },
  };

  return { client, rows, events, pendingInserts };
}

const fakeEmbed = async (_text: string) => {
  await tick();
  return new Array(1536).fill(0);
};

function unusedOps(): Pick<
  OpDeps,
  'search' | 'status' | 'index' | 'timeline' | 'get' | 'propose'
> {
  const unreachable = (op: string) => async () => {
    throw new Error(`unexpected ${op} call in read-after-write test`);
  };
  return {
    search: unreachable('search') as OpDeps['search'],
    status: unreachable('status') as OpDeps['status'],
    index: unreachable('index') as OpDeps['index'],
    timeline: unreachable('timeline') as OpDeps['timeline'],
    get: unreachable('get') as OpDeps['get'],
    propose: unreachable('propose') as OpDeps['propose'],
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/mnestra`;
}

const PROBE_CONTENT =
  'palimpsest-quokka 7741 read-after-write probe: webhook remember then immediate bridge recall';
const PROBE_QUERY = 'palimpsest-quokka 7741 probe';

test('write→200→recall is synchronous: the row is committed before the 200 and visible to an immediate recall', async () => {
  const store = makeFakeStore();
  const deps: OpDeps = {
    remember: (input: RememberInput) =>
      memoryRemember(input, { client: store.client, generateEmbedding: fakeEmbed }),
    recall: (input) =>
      memoryRecall(input, { client: store.client, generateEmbedding: fakeEmbed }),
    ...unusedOps(),
  };
  const server = startWebhookServer({ port: 0, secret: RAW_SECRET, deps });
  try {
    const url = await listen(server);

    // 1. Write through the real HTTP surface (the same op the panels' MCP
    //    memory_remember and any webhook client lands on).
    const writeRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mnestra-secret': RAW_SECRET },
      body: JSON.stringify({
        op: 'remember',
        content: PROBE_CONTENT,
        project: 'staleness-probe',
      }),
    });
    store.events.push('http:200:remember');
    assert.equal(writeRes.status, 200);
    assert.deepEqual(await writeRes.json(), { ok: true, result: 'inserted' });

    // THE verdict assertion: at the moment the 200 was observable, the row
    // was already committed. Accepted ⟹ recallable; no in-between state.
    assert.equal(store.rows.length, 1, 'row must be committed before the 200 is sent');
    assert.ok(
      store.events.indexOf('insert:committed') < store.events.indexOf('http:200:remember'),
      `commit must precede the 200 (events: ${store.events.join(' → ')})`
    );

    // 2. Recall immediately — zero settling time, exactly what a web chat
    //    calling the bridge right after a capture does.
    const recallRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mnestra-secret': RAW_SECRET },
      body: JSON.stringify({ op: 'recall', question: PROBE_QUERY, project: 'staleness-probe' }),
    });
    assert.equal(recallRes.status, 200);
    const body = (await recallRes.json()) as {
      ok: boolean;
      hits: Array<{ content: string }>;
      text: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.hits.length, 1, 'immediate recall must include the just-written row');
    assert.match(body.hits[0]!.content, /palimpsest-quokka 7741/);
    assert.match(body.text, /palimpsest-quokka 7741/);

    // The write pipeline ran in production order: embed → dedup probe → insert.
    const order = ['rpc:match_memories', 'insert:start', 'insert:committed', 'http:200:remember', 'rpc:memory_hybrid_search'];
    const positions = order.map((e) => store.events.indexOf(e));
    assert.ok(positions.every((p) => p >= 0), `missing events (got: ${store.events.join(' → ')})`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'pipeline order must hold');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('SENSITIVITY CONTROL: a fire-and-forget remember (200 before commit) makes the immediate recall miss — the failure mode this suite guards against is detectable', async () => {
  // Generous artificial commit latency so "200 raced ahead of the commit" is
  // unambiguous even on a slow CI box.
  const store = makeFakeStore({ insertDelayMs: 250 });
  const deps: OpDeps = {
    // The hypothetical async-accept design: kick off the real write, but
    // acknowledge immediately. THIS IS THE BUG SHAPE, deliberately built.
    remember: (input: RememberInput) => {
      void memoryRemember(input, { client: store.client, generateEmbedding: fakeEmbed }).catch(
        () => {}
      );
      return Promise.resolve('inserted' as const);
    },
    recall: (input) =>
      memoryRecall(input, { client: store.client, generateEmbedding: fakeEmbed }),
    ...unusedOps(),
  };
  const server = startWebhookServer({ port: 0, secret: RAW_SECRET, deps });
  try {
    const url = await listen(server);

    const writeRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mnestra-secret': RAW_SECRET },
      body: JSON.stringify({
        op: 'remember',
        content: PROBE_CONTENT,
        project: 'staleness-probe',
      }),
    });
    assert.equal(writeRes.status, 200);

    // Accepted but NOT committed — the state the real path never enters.
    assert.equal(store.rows.length, 0, 'control: 200 must precede the commit here');

    const recallRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mnestra-secret': RAW_SECRET },
      body: JSON.stringify({ op: 'recall', question: PROBE_QUERY, project: 'staleness-probe' }),
    });
    const body = (await recallRes.json()) as { ok: boolean; hits: unknown[] };
    assert.equal(body.ok, true);
    assert.equal(body.hits.length, 0, 'control: immediate recall must MISS under fire-and-forget');

    // Drain the in-flight write: the row lands EVENTUALLY (that is precisely
    // "a sync-cycle behind") — and only then does recall see it.
    await Promise.all(store.pendingInserts);
    assert.equal(store.rows.length, 1);
    const lateRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-mnestra-secret': RAW_SECRET },
      body: JSON.stringify({ op: 'recall', question: PROBE_QUERY, project: 'staleness-probe' }),
    });
    const lateBody = (await lateRes.json()) as { ok: boolean; hits: unknown[] };
    assert.equal(lateBody.hits.length, 1, 'control: the late recall sees the drained write');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
