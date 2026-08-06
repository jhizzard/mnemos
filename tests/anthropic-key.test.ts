/**
 * Mnestra — ANTHROPIC_API_KEY resolution tests (Sprint 70 A-T3).
 *
 * Two branches carry the acceptance criterion "extraction works in a shell
 * WITHOUT ANTHROPIC_API_KEY exported": the env branch (unchanged behavior)
 * and the `~/.termdeck/secrets.env` fallback branch (new). The third case
 * that matters as much as either is the NEGATIVE one — a key that TermDeck
 * deliberately commented out for billing safety must resolve to '', never
 * to the value sitting after the '#'.
 *
 * Fixtures are injected (fs + env + path), so nothing here reads the real
 * secrets file and no test can be perturbed by the ambient environment.
 * Key values are obvious fakes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveAnthropicKey,
  resetAnthropicKeyCache,
  defaultSecretsPath,
} from '../src/anthropic-key.js';
import type { FsLike } from '../src/doctor.js';

const KEY = 'sk-ant-api03-FAKE-not-a-real-key';
const ENV_KEY = 'sk-ant-api03-FAKE-from-env';

/** In-memory secrets.env at the canonical path. */
function fakeFs(contents: string | null, path = '/home/u/.termdeck/secrets.env'): FsLike {
  return {
    existsSync: (p) => p === path && contents !== null,
    readFileSync: (p) => {
      if (p !== path || contents === null) throw new Error('ENOENT');
      return contents;
    },
  };
}

const PATH = '/home/u/.termdeck/secrets.env';
const resolve = (env: Record<string, string | undefined>, contents: string | null) =>
  resolveAnthropicKey(env, fakeFs(contents, PATH), PATH);

// ── Branch 1: process env wins ───────────────────────────────────────────

test('env branch: exported ANTHROPIC_API_KEY resolves and outranks the file', () => {
  assert.equal(resolve({ ANTHROPIC_API_KEY: ENV_KEY }, `ANTHROPIC_API_KEY=${KEY}\n`), ENV_KEY);
});

test('env branch: surrounding whitespace and quotes are stripped', () => {
  assert.equal(resolve({ ANTHROPIC_API_KEY: `  ${ENV_KEY}  ` }, null), ENV_KEY);
  assert.equal(resolve({ ANTHROPIC_API_KEY: `"${ENV_KEY}"` }, null), ENV_KEY);
});

test('env branch: unexpanded ${...} placeholder counts as unset and falls through to the file', () => {
  assert.equal(
    resolve({ ANTHROPIC_API_KEY: '${ANTHROPIC_API_KEY}' }, `ANTHROPIC_API_KEY=${KEY}\n`),
    KEY
  );
});

test('env branch: a QUOTED unexpanded placeholder is still a placeholder (A-T4 audit)', () => {
  // The order matters: quotes come off BEFORE the placeholder test. With the
  // checks reversed, `"${ANTHROPIC_API_KEY}"` does not start with '${', reads
  // as a live key, and is handed to the SDK verbatim — a 401 instead of the
  // fallback. A shell forwarding an unset variable produces exactly this.
  for (const quoted of ['"${ANTHROPIC_API_KEY}"', "'${ANTHROPIC_API_KEY}'"]) {
    assert.equal(
      resolve({ ANTHROPIC_API_KEY: quoted }, `ANTHROPIC_API_KEY=${KEY}\n`),
      KEY,
      `quoted placeholder must fall through to the file: ${quoted}`
    );
    // …and with no file behind it, it must resolve to '' — never the literal.
    assert.equal(resolve({ ANTHROPIC_API_KEY: quoted }, null), '');
  }
});

test('env branch: quoted placeholder with surrounding whitespace also falls through', () => {
  assert.equal(
    resolve({ ANTHROPIC_API_KEY: '  "${ANTHROPIC_API_KEY}"  ' }, `ANTHROPIC_API_KEY=${KEY}\n`),
    KEY
  );
});

test('env branch: a real key that merely CONTAINS ${ is not mistaken for a placeholder', () => {
  // Guard against over-correcting: only a value that is wholly `${...}` is a
  // placeholder. A key with the sequence inside it must still resolve.
  const odd = 'sk-ant-FAKE-${embedded}-tail';
  assert.equal(resolve({ ANTHROPIC_API_KEY: odd }, `ANTHROPIC_API_KEY=${KEY}\n`), odd);
  assert.equal(resolve({ ANTHROPIC_API_KEY: `"${odd}"` }, null), odd);
});

test('env branch: empty / whitespace-only env var falls through to the file', () => {
  assert.equal(resolve({ ANTHROPIC_API_KEY: '' }, `ANTHROPIC_API_KEY=${KEY}\n`), KEY);
  assert.equal(resolve({ ANTHROPIC_API_KEY: '   ' }, `ANTHROPIC_API_KEY=${KEY}\n`), KEY);
});

// ── Branch 2: secrets.env fallback (the key-free panel case) ─────────────

test('file branch: key-free env resolves from ~/.termdeck/secrets.env', () => {
  assert.equal(resolve({}, `ANTHROPIC_API_KEY=${KEY}\n`), KEY);
});

test('file branch: resolves among the other stack secrets, in any position', () => {
  const contents = [
    'SUPABASE_URL=https://example.supabase.co',
    'SUPABASE_SERVICE_ROLE_KEY=fake.service.role',
    'OPENAI_API_KEY=sk-fake-openai',
    `ANTHROPIC_API_KEY=${KEY}`,
    'DATABASE_URL=postgres://u:p@localhost:5432/postgres',
    '',
  ].join('\n');
  assert.equal(resolve({}, contents), KEY);
});

test('file branch: quoted values, CRLF line endings, and `export ` prefixes all parse', () => {
  assert.equal(resolve({}, `ANTHROPIC_API_KEY="${KEY}"\n`), KEY);
  assert.equal(resolve({}, `ANTHROPIC_API_KEY='${KEY}'\n`), KEY);
  assert.equal(resolve({}, `OPENAI_API_KEY=x\r\nANTHROPIC_API_KEY=${KEY}\r\n`), KEY);
  assert.equal(resolve({}, `export ANTHROPIC_API_KEY=${KEY}\n`), KEY);
});

test('file branch: unexpanded ${...} in the file counts as unset', () => {
  assert.equal(resolve({}, 'ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}\n'), '');
});

// ── The negative branch: disabled must NOT resolve ───────────────────────

test('DISABLED: a commented-out key line does NOT resolve (billing-safety contract)', () => {
  const disabled = `# DISABLED-2026-08-05-billing : ANTHROPIC_API_KEY=${KEY}\n`;
  assert.equal(resolve({}, disabled), '');
});

test('DISABLED: every comment shape stays unresolved — leading space, no space, mid-line', () => {
  for (const line of [
    `#ANTHROPIC_API_KEY=${KEY}`,
    `   # ANTHROPIC_API_KEY=${KEY}`,
    `# DISABLED 2026-08-05 — see billing note : ANTHROPIC_API_KEY=${KEY}`,
    `# export ANTHROPIC_API_KEY=${KEY}`,
  ]) {
    assert.equal(resolve({}, `${line}\n`), '', `resolved from: ${line}`);
  }
});

test('DISABLED: anchoring blocks a same-line suffix match even without a comment marker', () => {
  // Defense 2 standing alone: no '#', but the assignment is not at line start.
  assert.equal(resolve({}, `NOTES: previously ANTHROPIC_API_KEY=${KEY}\n`), '');
  assert.equal(resolve({}, `OLD_ANTHROPIC_API_KEY=${KEY}\n`), '');
});

test('DISABLED then re-enabled: a live line below the commented one still resolves', () => {
  const contents = `# DISABLED-2026-08-04 : ANTHROPIC_API_KEY=sk-ant-OLD\nANTHROPIC_API_KEY=${KEY}\n`;
  assert.equal(resolve({}, contents), KEY);
});

// ── Absent / unreadable → '' , never a throw ─────────────────────────────

test('absent file → empty string, no throw', () => {
  assert.equal(resolve({}, null), '');
});

test('empty assignment in the file → empty string', () => {
  assert.equal(resolve({}, 'ANTHROPIC_API_KEY=\n'), '');
  assert.equal(resolve({}, 'ANTHROPIC_API_KEY=""\n'), '');
});

test('unreadable file (permissions, mid-write truncation) → empty string, no throw', () => {
  const throwingFs: FsLike = {
    existsSync: () => true,
    readFileSync: () => {
      throw new Error('EACCES: permission denied');
    },
  };
  assert.equal(resolveAnthropicKey({}, throwingFs, PATH), '');
});

test('no key anywhere → empty string (callers degrade to their empty result)', () => {
  assert.equal(resolve({}, 'SUPABASE_URL=https://example.supabase.co\nDATABASE_URL=postgres://x\n'), '');
});

// ── Real on-disk fixture — proves the readFileSync path, not just the stub ─

test('real fixture file on disk: key-free env resolves through actual fs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mnestra-key-'));
  try {
    const home = join(dir, '.termdeck');
    mkdirSync(home);
    const file = join(home, 'secrets.env');
    writeFileSync(
      file,
      [
        '# TermDeck stack secrets (fixture)',
        'SUPABASE_URL=https://example.supabase.co',
        `# DISABLED-2026-08-05-billing : ANTHROPIC_API_KEY=sk-ant-SHOULD-NOT-RESOLVE`,
        `ANTHROPIC_API_KEY=${KEY}`,
        '',
      ].join('\n'),
      { mode: 0o600 }
    );
    assert.equal(resolveAnthropicKey({}, undefined, file), KEY);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real fixture file on disk: fully disabled key resolves to empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mnestra-key-'));
  try {
    const file = join(dir, 'secrets.env');
    writeFileSync(file, `# DISABLED-2026-08-05-billing : ANTHROPIC_API_KEY=${KEY}\n`, {
      mode: 0o600,
    });
    assert.equal(resolveAnthropicKey({}, undefined, file), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Ambient path + memo ──────────────────────────────────────────────────

test('default secrets path is ~/.termdeck/secrets.env', () => {
  assert.match(defaultSecretsPath(), /[/\\]\.termdeck[/\\]secrets\.env$/);
});

test('memo: only the zero-arg ambient call caches; explicit args always re-read', () => {
  resetAnthropicKeyCache();
  let reads = 0;
  const counting: FsLike = {
    existsSync: () => true,
    readFileSync: () => {
      reads += 1;
      return `ANTHROPIC_API_KEY=${KEY}\n`;
    },
  };
  resolveAnthropicKey({}, counting, PATH);
  resolveAnthropicKey({}, counting, PATH);
  assert.equal(reads, 2, 'explicit-arg calls must not be served from the memo');

  // Ambient calls are memoized; resetting clears it. Uses the real ambient
  // env/fs, so assert on stability rather than on a specific value.
  resetAnthropicKeyCache();
  const first = resolveAnthropicKey();
  assert.equal(resolveAnthropicKey(), first);
  resetAnthropicKeyCache();
  assert.equal(resolveAnthropicKey(), first);
});
