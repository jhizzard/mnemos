/**
 * Mnestra — public API entry point
 *
 * Re-exports the core memory functions for programmatic use. If you
 * want the stdio MCP server, import from `@jhizzard/mnestra/mcp-server`
 * or run the `mnestra` bin.
 */

export { memoryRemember } from './remember.js';
export { memoryCite, CITATION_RPC, type CiteInput, type CiteResult, type CiteDeps } from './cite.js';
export {
  extractGraphForMemory,
  scheduleWriteExtraction,
  drainWriteExtractions,
  extractionEnabled,
  __resetExtractState,
  type ExtractInput,
  type ExtractDeps,
  type ExtractReport,
  type ExtractedEntity,
  type ExtractedTriple,
} from './extract_write.js';
export {
  problemSignature,
  problemLookupKey,
  shouldSignProblem,
  normalizeSymptom,
  symptomHash,
  classifyProblem,
  freeClass,
  pickSymptomLine,
  PROBLEM_CLASSES,
  PROBLEM_SIGNATURE_VERSION,
  PROBLEM_EXTRACTED_BY,
  type ProblemSignature,
  type ProblemLookupKey,
} from './problem_signature.js';
export { memoryRecall, type RecallOutput, type RecallDeps } from './recall.js';
export {
  memoryPropose,
  isProposeRejected,
  ProposeRejectedError,
  PROPOSE_REJECTED_PREFIX,
  PROPOSE_TEXT_MAX_CHARS,
  PROPOSE_PROJECT_HINT_MAX_CHARS,
  PROPOSE_METADATA_MAX_BYTES,
  type ProposeDeps,
} from './propose.js';
export {
  memoryRecallGraph,
  type GraphRecallInput,
  type GraphRecallHit,
  type GraphRecallOutput,
} from './recall_graph.js';
export { memorySearch } from './search.js';
export { memoryForget } from './forget.js';
export { memoryStatus, formatStatus } from './status.js';
export { memorySummarizeSession, type SummarizeResult } from './summarize.js';
export { consolidateMemories, type ConsolidationReport } from './consolidate.js';
export {
  memoryIndex,
  memoryTimeline,
  memoryGet,
  type IndexHit,
  type IndexInput,
  type TimelineInput,
  type TimelineWindow,
  type GetInput,
} from './layered.js';
export { generateEmbedding, formatEmbedding } from './embeddings.js';
export { getSupabase, resetSupabaseClient } from './db.js';
export {
  memoryLink,
  memoryUnlink,
  memoryRelated,
  type LinkInput,
  type LinkResult,
  type UnlinkInput,
  type UnlinkResult,
  type RelatedInput,
  type RelatedNode,
} from './relationships.js';
export * from './types.js';
