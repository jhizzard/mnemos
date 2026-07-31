/**
 * Mnestra — problem_signature (Sprint 83 T2, interface I3)
 *
 * TYPED SHELL. Every rule about what a problem_signature is, and every byte of
 * the normalization, lives in `./problem_signature_core.cjs`. This module adds
 * types and mnestra-specific narrowing (SourceType / Category instead of loose
 * strings) and re-exports; it deliberately implements nothing.
 *
 * The core is plain CommonJS because three consumers must produce identical
 * hashes across two module systems and two repos — mnestra (ESM TS, write
 * side), T3's recall-side expansion, and TermDeck's server (CJS, no build, no
 * mnestra dependency). See the core's header for why one shared implementation
 * is non-negotiable rather than a nicety.
 *
 * THE CONTRACT (T3 and TermDeck import from here, or from the core directly —
 * do not re-implement):
 *
 *   memory_items.metadata.problem_signature = {
 *     v: 1,
 *     class:         'err-pg-permission-denied' | … | 'free:<slug>',
 *     symptom:       '<normalized, redacted, ≤200 chars>',
 *     symptom_hash:  '<sha256(symptom).slice(0,32)>',
 *     extracted_by:  'write-time/regex@1',
 *     extracted_at:  '<ISO-8601>',
 *   }
 *
 * The whole signature sits under ONE metadata key, as an object, not as
 * sibling scalars: remember.ts shallow-merges metadata on a dedup
 * reinforcement (`{...existing, ...incoming}`), so siblings can desync across
 * two writes — class from write A surviving beside symptom_hash from write B —
 * and a desynced signature is worse than an absent one, because it still
 * matches. One key is atomic under that merge.
 *
 * ABSENT means "not a solved-problem write". Never null, never empty string;
 * consumers branch on presence.
 *
 * NO NETWORK, NO ASYNC, NO LLM. This is regex plus string normalization, which
 * is exactly why it runs INLINE in the write payload rather than in the
 * fail-open post-write extractor: microseconds, cannot time out, needs no
 * budget guard. The expensive entity/triple extraction is the part that fails
 * open — see `extract_write.ts`.
 */

import {
  PROBLEM_CLASSES,
  PROBLEM_EXTRACTED_BY,
  PROBLEM_SIGNATURE_VERSION,
  SYMPTOM_MAX_CHARS,
  classifyProblem,
  freeClass,
  normalizeSymptom,
  pickSymptomLine,
  problemLookupKey,
  problemSignature as problemSignatureCore,
  redactSecrets,
  shouldSignProblem as shouldSignProblemCore,
  symptomHash,
  type ProblemLookupKey,
  type ProblemSignature,
} from './problem_signature_core.cjs';

import type { Category, SourceType } from './types.js';

export {
  PROBLEM_CLASSES,
  PROBLEM_EXTRACTED_BY,
  PROBLEM_SIGNATURE_VERSION,
  SYMPTOM_MAX_CHARS,
  classifyProblem,
  freeClass,
  normalizeSymptom,
  pickSymptomLine,
  problemLookupKey,
  redactSecrets,
  symptomHash,
};

export type { ProblemLookupKey, ProblemSignature };

export interface ProblemSignatureInput {
  content: string;
  source_type?: SourceType | null;
  category?: Category | null;
  /**
   * The verbatim failing line, when the caller has it (the flashback path
   * embeds the matched error line; a hook can pass captured stderr). Wins over
   * anything derived from `content` — it IS the symptom, where content is a
   * write-up ABOUT the symptom.
   */
  symptom_text?: string | null;
}

/**
 * Should this write carry a signature at all?
 *
 * `bug_fix` is the solved-problem source_type. `debugging` is ALSO a trigger,
 * but read off `category`, not `source_type` — per the Sprint 82 finding,
 * `debugging` and `convention` are `Category` values and are NOT legal
 * `SourceType`s (see src/types.ts). Keying on source_type alone would silently
 * miss every `decision`-typed write about a bug, which is where a large share
 * of the real fixes live.
 */
export function shouldSignProblem(input: {
  source_type?: SourceType | null;
  category?: Category | null;
}): boolean {
  return shouldSignProblemCore(input);
}

/**
 * Build the signature, or null when this write is not solved-problem-class or
 * carries nothing usable. Pure, synchronous, total — it never throws, because
 * its caller is a write path and a classification failure must never cost a
 * memory.
 */
export function problemSignature(
  input: ProblemSignatureInput,
  now?: Date
): ProblemSignature | null {
  return problemSignatureCore(input, now);
}
