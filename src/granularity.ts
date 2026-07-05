/**
 * Mnestra — granularity classifier (Sprint 79 T1, capture gates)
 *
 * Kitchen-vs-recipe classification (global CLAUDE.md § "Kitchen vs recipes"):
 * a KITCHEN memory is a generalizable principle/tradeoff that survives a
 * codebase rewrite; a RECIPE memory is tied to one file:line, one sprint, one
 * version — git's job, not memory's. This module is the regex tier only.
 * Haiku tier-2 (semantic classification for content that regexes can't call)
 * ships OFF this sprint — env-gated so a future sprint can wire it in without
 * an API change here, but MNESTRA_GRANULARITY_HAIKU_TIER2 does not actually
 * invoke a model yet (see classifyGranularity below).
 *
 * The sole consumer this sprint is recall.ts's smartRank tiebreak — an
 * unread classifier is pure fatigue cost, so shipping this without wiring
 * the consumer was never on the table.
 */

export type Granularity = 'kitchen' | 'recipe' | 'unknown';

export interface GranularityResult {
  granularity: Granularity;
  /** Which marker patterns matched, for observability (echoed back by callers that log it). */
  matched_markers: string[];
}

/**
 * Recipe markers: specific-instance signals (file:line, sprint/migration/PR
 * numbers, semver, commit-SHA-shaped hex runs). Presence alone doesn't make
 * something a recipe — density does (a kitchen lesson often *cites* a recipe
 * as evidence) — see DENSITY_THRESHOLD below.
 */
const RECIPE_MARKERS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'file_line', pattern: /\b[\w./-]+\.(ts|tsx|js|jsx|sql|py|md|json):\d+\b/gi },
  { name: 'sprint_ref', pattern: /\bsprint[\s-]?\d+(\.\d+)?\b/gi },
  { name: 'migration_ref', pattern: /\bmigration\s?\d+\b/gi },
  { name: 'semver', pattern: /\bv?\d+\.\d+\.\d+\b/gi },
  { name: 'pr_ref', pattern: /\b(pr|pull request)\s?#?\d+\b/gi },
  { name: 'commit_sha', pattern: /\b[0-9a-f]{7,40}\b/gi },
  { name: 'iso_date', pattern: /\b\d{4}-\d{2}-\d{2}\b/g },
];

/**
 * Kitchen markers: generalizable-principle language. Presence of ANY kitchen
 * marker overrides recipe density — a memory that both cites a file:line AND
 * states a general principle is a kitchen memory that happens to reference
 * evidence, not a recipe.
 */
const KITCHEN_MARKERS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'why', pattern: /\bwhy\b/gi },
  { name: 'tradeoff', pattern: /\btrade-?off/gi },
  { name: 'pattern', pattern: /\bpattern\b/gi },
  { name: 'principle', pattern: /\bprinciple\b/gi },
  { name: 'in_general', pattern: /\bin general\b/gi },
  { name: 'generalizes', pattern: /\bgeneraliz(e|es|ed|ing|able)\b/gi },
  { name: 'recurring', pattern: /\brecurring\b/gi },
  { name: 'always_never', pattern: /\b(always|never)\b/gi },
];

/** Raw recipe-marker match count at/above this (with zero kitchen markers) reads as 'recipe'. */
const DENSITY_THRESHOLD = 2;

/** Env gate for a not-yet-implemented Haiku tier-2. Off by default this sprint. */
const HAIKU_TIER2_ENV = 'MNESTRA_GRANULARITY_HAIKU_TIER2';
let warnedHaikuTier2NotImplemented = false;

function countMatches(text: string, markers: Array<{ name: string; pattern: RegExp }>): {
  total: number;
  names: string[];
} {
  let total = 0;
  const names: string[] = [];
  for (const { name, pattern } of markers) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      total += matches.length;
      names.push(name);
    }
  }
  return { total, names };
}

/**
 * Regex-tier granularity classification. Pure, synchronous, no I/O — safe to
 * call on the hot recall path per-row.
 *
 * Recipe fires ONLY when recipe-marker density is at/above DENSITY_THRESHOLD
 * AND no kitchen marker is present — a kitchen lesson that cites a recipe as
 * evidence (e.g. "sprint 62 taught us X, in general Y") stays 'kitchen'.
 * Otherwise 'unknown' (not confidently either way) — 'unknown' is NEVER
 * downweighted by the recall.ts consumer, only 'recipe' is.
 */
export function classifyGranularity(content: string): GranularityResult {
  if (process.env[HAIKU_TIER2_ENV] && !warnedHaikuTier2NotImplemented) {
    warnedHaikuTier2NotImplemented = true;
    console.error(
      `[mnestra-granularity] ${HAIKU_TIER2_ENV} is set but Haiku tier-2 is not implemented this ` +
        'sprint (PLANNING §3: regex tier only) — falling back to the regex tier.'
    );
  }

  const kitchen = countMatches(content, KITCHEN_MARKERS);
  if (kitchen.total > 0) {
    return { granularity: 'kitchen', matched_markers: kitchen.names };
  }

  const recipe = countMatches(content, RECIPE_MARKERS);
  if (recipe.total >= DENSITY_THRESHOLD) {
    return { granularity: 'recipe', matched_markers: recipe.names };
  }

  return { granularity: 'unknown', matched_markers: [] };
}
