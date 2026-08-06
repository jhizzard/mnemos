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
export {
  memoryRecall,
  graphRecallEnabled,
  type RecallOutput,
  type RecallDeps,
  type Tier0Item,
} from './recall.js';
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
  collapseHubs,
  renderTier0,
  resolveTier0,
  resolveWalkMode,
  tier0InjectEnabled,
  DEFAULT_HUB_MIN_MEMBERS,
  LEGACY_GRAPH_RPC,
  BOOSTED_GRAPH_RPC,
  type GraphRecallInput,
  type GraphRecallHit,
  type GraphRecallUnit,
  type GraphRecallOutput,
  type GraphWalkMode,
  type HubCitation,
} from './recall_graph.js';
export {
  objectiveList,
  objectiveHistory,
  objectiveRatify,
  objectiveRetire,
  fetchTier0Block,
  tier0FetcherForRecall,
  formatObjectives,
  isObjectiveRejected,
  parseRejection,
  ObjectiveRejectedError,
  OBJECTIVE_LIST_RPC,
  OBJECTIVE_RATIFY_RPC,
  OBJECTIVE_TABLE,
  OBJECTIVE_MAX_ACTIVE,
  OBJECTIVE_TEXT_MAX_CHARS,
  OBJECTIVE_PROJECT_MAX_CHARS,
  OBJECTIVE_RATIFIED_BY_MAX_CHARS,
  OBJECTIVE_METADATA_MAX_BYTES,
  OBJECTIVE_RANK_MIN,
  OBJECTIVE_RANK_MAX,
  OBJECTIVE_STATUS_ACTIVE,
  OBJECTIVE_STATUSES,
  OBJECTIVE_RATIFY_GATE_ENV,
  OBJECTIVE_RATIFY_REJECTED_PREFIX,
  type Objective,
  type ObjectiveStatus,
  type ObjectiveDeps,
  type ObjectiveRatifyInput,
  type ObjectiveRatifyResult,
  type ObjectiveRetireInput,
  type Tier0Block,
} from './objectives.js';
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
