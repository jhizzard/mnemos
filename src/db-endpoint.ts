/**
 * Mnestra — DATABASE_URL endpoint-shape classifier (Sprint 74 T2).
 *
 * Mnestra itself never opens a Postgres socket (src/db.ts talks PostgREST
 * over HTTPS via SUPABASE_URL), but the stack around it does: the psql
 * migration path in README.md, TermDeck's wizard/migration-runner/health
 * probes, and Rumen all consume a user-pasted DATABASE_URL. Supabase's
 * direct endpoint `db.<project-ref>.supabase.co` — which also hosts the
 * Dedicated Pooler on :6543 — publishes ONLY an AAAA record. On a host
 * without IPv6 (Brad's Dell R730 field report, 2026-06-09; many CI
 * runners and VPSes) pg clients don't fail fast; they hang until a pool
 * timeout. The IPv4-compatible alternative is the Shared Pooler:
 *
 *   postgres://postgres.<project-ref>:<pw>@aws-<n>-<region>.pooler.supabase.com:6543/postgres
 *
 * This module classifies the URL shape so `mnestra doctor` can warn
 * BEFORE the first hang. It never rewrites anything — accept-any-valid-URL
 * + validate-and-warn. Pure string/interface logic; the only ambient read
 * (os.networkInterfaces) is injectable and consulted lazily.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';

import type { FsLike, ProbeResult } from './doctor.js';

// ── Classification ───────────────────────────────────────────────────────

export type DbEndpointKind =
  /** No DATABASE_URL provided — fine; mnestra core doesn't need one. */
  | 'absent'
  /** Set but not parseable as a postgres:// / postgresql:// URL. */
  | 'invalid'
  /**
   * Host `db.<project-ref>.supabase.co|in` — IPv6-only (AAAA, no A record).
   * Covers BOTH the :5432 direct connection and the :6543 Dedicated Pooler;
   * they share the hostname and therefore the IPv4 unreachability.
   */
  | 'direct'
  /** Host `*.pooler.supabase.com` — the Shared Pooler, IPv4-compatible. */
  | 'shared-pooler'
  /** Loopback / local Postgres — endpoint-family concerns don't apply. */
  | 'local'
  /** Anything else (self-hosted, RDS, IPv6 literal, …) — no Supabase-shape concerns. */
  | 'other';

export interface DbEndpointClassification {
  kind: DbEndpointKind;
  /** Lowercased hostname, when the URL parsed. */
  host?: string;
  /** Port string as written ('' when omitted). */
  port?: string;
  /** Decoded username ('' when omitted). */
  username?: string;
  /**
   * True when the host is the Shared Pooler but the username lacks the
   * mandatory `.<project-ref>` suffix (`postgres` instead of
   * `postgres.<project-ref>`) — the documented "Tenant or user not found"
   * failure (GETTING-STARTED Tier 3 gotcha #3 family).
   */
  poolerUserMismatch?: boolean;
}

/** Strip ONE pair of matched surrounding quotes — same defense the
 *  TermDeck dotenv parsers apply; a quoted secrets.env value or
 *  shell-exported literal-quoted URL otherwise classifies as 'invalid'. */
function stripSurroundingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }
  return value;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

export function classifyDbEndpoint(raw: string | undefined | null): DbEndpointClassification {
  if (raw === undefined || raw === null) return { kind: 'absent' };
  const trimmed = stripSurroundingQuotes(raw.trim());
  if (trimmed === '') return { kind: 'absent' };

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { kind: 'invalid' };
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    return { kind: 'invalid' };
  }

  // Normalize: lowercase, drop a trailing FQDN dot.
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  let username = '';
  try {
    username = decodeURIComponent(u.username);
  } catch {
    username = u.username;
  }
  const base = { host, port: u.port, username };

  if (LOCAL_HOSTS.has(host)) return { kind: 'local', ...base };

  if (/^db\.[a-z0-9-]+\.supabase\.(co|in)$/.test(host)) {
    return { kind: 'direct', ...base };
  }

  if (host.endsWith('.pooler.supabase.com')) {
    // Shared Pooler logins are `postgres.<project-ref>` — a dotless
    // username means the URL was hand-assembled from direct-connection
    // parts and will fail with "Tenant or user not found".
    const poolerUserMismatch = username !== '' && !username.includes('.');
    return { kind: 'shared-pooler', ...base, poolerUserMismatch };
  }

  return { kind: 'other', ...base };
}

// ── IPv6 capability heuristic ────────────────────────────────────────────

/** Minimal slice of os.networkInterfaces() entries we inspect. */
export interface NetAddressInfo {
  family: string | number;
  internal: boolean;
  address: string;
}

/**
 * True when any non-internal interface carries a global-unicast IPv6
 * address (2000::/3 — first hex nibble 2 or 3). Link-local (fe80::/10),
 * unique-local (fc00::/7), and loopback addresses don't make the
 * IPv6-only endpoint reachable, so they don't count. A global address is
 * a proxy for (not a guarantee of) a working IPv6 route; its ABSENCE is a
 * guarantee the IPv6-only endpoint is unreachable — which is the
 * direction the red verdict relies on.
 */
export function hasGlobalIpv6(
  interfaces: Record<string, NetAddressInfo[] | undefined> = networkInterfaces()
): boolean {
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.internal) continue;
      if (a.family !== 'IPv6' && a.family !== 6) continue;
      const first = a.address[0]?.toLowerCase();
      if (first === '2' || first === '3') return true;
    }
  }
  return false;
}

// ── Ambient resolution (CLI boundary only — runDoctor never calls this) ──

function isUnexpandedPlaceholder(v: string): boolean {
  return v.startsWith('${') && v.endsWith('}');
}

const defaultFs: FsLike = {
  existsSync: (p) => existsSync(p),
  readFileSync: (p, enc) => readFileSync(p, enc),
};

/**
 * Resolve the DATABASE_URL the surrounding stack would use: process env
 * first, then `~/.termdeck/secrets.env` (the TermDeck stack's secret
 * store — `mnestra doctor` runs after loadTermdeckSecretsFallback(),
 * which deliberately skips the file when SUPABASE_URL is already set, so
 * the doctor reads it directly). Returns undefined when nothing usable
 * is found. Unexpanded `${VAR}` placeholders count as unset.
 */
export function resolveDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
  fs: FsLike = defaultFs,
  secretsPath: string = join(homedir(), '.termdeck', 'secrets.env')
): string | undefined {
  const fromEnv = (env.DATABASE_URL ?? '').trim();
  if (fromEnv && !isUnexpandedPlaceholder(fromEnv)) return fromEnv;

  try {
    if (!fs.existsSync(secretsPath)) return undefined;
    for (const raw of fs.readFileSync(secretsPath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^DATABASE_URL=(.*)$/);
      if (!match) continue;
      const value = stripSurroundingQuotes(match[1]!.trim());
      if (value && !isUnexpandedPlaceholder(value)) return value;
    }
  } catch {
    // Unreadable secrets file → treat as unset; the probe reports 'absent'.
  }
  return undefined;
}

// ── Doctor probe ─────────────────────────────────────────────────────────

const POOLER_FIX_RECOMMENDATIONS = [
  'switch DATABASE_URL to the IPv4-compatible Shared Pooler: Supabase dashboard → Connect → Transaction pooler → toggle ON "Use IPv4 connection (Shared Pooler)" → copy the URL',
  'shared-pooler shape: postgres://postgres.<project-ref>:<password>@aws-<n>-<region>.pooler.supabase.com:6543/postgres — note the username is postgres.<project-ref>, not postgres',
];

/**
 * Probe 5 — DATABASE_URL endpoint IPv4 safety (Sprint 74 T2, Brad R730
 * field report). Pure: the caller supplies the URL (resolveDatabaseUrl at
 * the CLI boundary) and may supply the IPv6 signal; os.networkInterfaces
 * is consulted only when the URL is the IPv6-only direct shape and no
 * signal was injected.
 */
export function evalDbEndpoint(
  databaseUrl: string | undefined,
  ipv6Capable?: boolean
): ProbeResult {
  const name = 'DATABASE_URL endpoint';
  const c = classifyDbEndpoint(databaseUrl);

  switch (c.kind) {
    case 'absent':
      return {
        name,
        status: 'green',
        detail:
          'DATABASE_URL not set — mnestra itself talks to Supabase over HTTPS (SUPABASE_URL); only psql migrations and TermDeck stack components need DATABASE_URL',
        recommendations: [],
      };
    case 'invalid':
      return {
        name,
        status: 'yellow',
        detail: 'DATABASE_URL is set but not parseable as a postgres:// connection string',
        recommendations: [
          'paste the full Connection String from the Supabase Connect modal (Transaction pooler, "Use IPv4 connection" toggled ON), without surrounding quotes',
        ],
      };
    case 'local':
      return {
        name,
        status: 'green',
        detail: `local Postgres (${c.host}) — endpoint-family concerns don't apply`,
        recommendations: [],
      };
    case 'other':
      return {
        name,
        status: 'green',
        detail: `non-Supabase host (${c.host}) — no Supabase endpoint-shape concerns`,
        recommendations: [],
      };
    case 'shared-pooler': {
      if (c.poolerUserMismatch) {
        return {
          name,
          status: 'yellow',
          detail: `Shared Pooler host (${c.host}) with username "${c.username}" — the pooler requires postgres.<project-ref>; connections fail with "Tenant or user not found"`,
          recommendations: [
            'set the username to postgres.<project-ref> — copy the URL from the Connect modal rather than hand-editing the host on a direct-connection string',
          ],
        };
      }
      return {
        name,
        status: 'green',
        detail: `IPv4-compatible Supabase Shared Pooler (${c.host}) — reachable from IPv4-only and IPv6 hosts`,
        recommendations: [],
      };
    }
    case 'direct': {
      const portNote =
        c.port === '6543'
          ? 'the Dedicated Pooler on this host shares its IPv6-only DNS'
          : 'Supabase publishes no A record for this host';
      const capable = ipv6Capable ?? hasGlobalIpv6();
      if (!capable) {
        return {
          name,
          status: 'red',
          detail: `DATABASE_URL points at the IPv6-only endpoint ${c.host} (${portNote}) and this host has no global IPv6 address — pg clients hang until a pool/connect timeout instead of failing fast`,
          recommendations: POOLER_FIX_RECOMMENDATIONS,
        };
      }
      return {
        name,
        status: 'yellow',
        detail: `DATABASE_URL points at the IPv6-only endpoint ${c.host} (${portNote}); this host has IPv6 so it works here, but the same secrets fail with a pool timeout on any IPv4-only host (CI runners, many VPSes and datacenter machines)`,
        recommendations: POOLER_FIX_RECOMMENDATIONS,
      };
    }
  }
}
