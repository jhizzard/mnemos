/**
 * Types for `problem_signature_core.cjs`.
 *
 * Hand-written rather than generated: the core is deliberately plain
 * CommonJS JavaScript so TermDeck's server (CJS, no TypeScript, no build) can
 * `require()` or vendor it verbatim. See that file's header for the full
 * rationale — this declaration exists only so the ESM/TS side of the house
 * gets types over the same single implementation.
 *
 * KEEP IN SYNC BY HAND. There is no compiler check tying this to the .cjs; a
 * signature drift here is a lie the type-checker will happily believe.
 */

export interface ProblemSignature {
  v: number;
  class: string;
  symptom: string;
  symptom_hash: string;
  extracted_by: string;
  extracted_at: string;
}

export interface ProblemSignatureInput {
  content: string;
  source_type?: string | null;
  category?: string | null;
  /** Verbatim failing line, when the caller has it. Wins over `content`. */
  symptom_text?: string | null;
}

export interface ProblemLookupKey {
  class: string;
  symptom: string;
  symptom_hash: string;
}

export const PROBLEM_SIGNATURE_VERSION: number;
export const PROBLEM_EXTRACTED_BY: string;
export const SYMPTOM_MAX_CHARS: number;
export const PROBLEM_CLASSES: string[];

export function redactSecrets(text: string): string;
export function normalizeSymptom(raw: unknown, maxLen?: number): string;
export function symptomHash(normalized: string): string;
export function classifyProblem(text: unknown): string | null;
export function freeClass(normalizedSymptom: string): string;
export function pickSymptomLine(text: string): string;
export function shouldSignProblem(input: {
  source_type?: string | null;
  category?: string | null;
}): boolean;
export function problemSignature(
  input: ProblemSignatureInput,
  now?: Date
): ProblemSignature | null;
export function problemLookupKey(errorText: string): ProblemLookupKey | null;
