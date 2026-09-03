/**
 * Library entry. Everything the hooks and the CLI use is exported here so
 * other tools can reuse the runner catalog, the claim grammar and the gate.
 */

export type {
  Category,
  Claim,
  ClaimScope,
  Counts,
  EditEvent,
  Fingerprint,
  Harness,
  Receipt,
  RunScope,
  RunVerdict,
  Verdict,
  VerdictAction,
  VerdictEvidence,
  VerdictFreshness,
  VerdictKind,
} from "./core/grammar.js";
export { CATEGORIES } from "./core/grammar.js";
export { parseCommand, shQuote, stripGroupingWords } from "./core/shell.js";
export type { Operator, ParsedCommand, Redirect, Segment } from "./core/shell.js";
export { classify, cleanOutput, detect, detectAll, parseCounts, parseOutput, scriptCategory, signalIds, stripWrappers } from "./core/runners.js";
export type { Classification, Detection, ParseOptions, ParseResult } from "./core/runners.js";
export { analyzeMasking } from "./core/masking.js";
export type { MaskAnalysis } from "./core/masking.js";
export { dedupeClaims, extractClaims, splitSentences } from "./core/claims.js";
export { compareFingerprints, computeFingerprint, pathIgnorer } from "./core/fingerprint.js";
export type { FingerprintOptions } from "./core/fingerprint.js";
export { editFromTool, editsFromBash } from "./core/edits.js";
export type { EditCandidate } from "./core/edits.js";
export { evaluate, formatBlockMessage, selectReceipt } from "./core/freshness.js";
export type { GateInput } from "./core/freshness.js";
export { DEFAULT_CONFIG, DEFAULT_FINGERPRINT_IGNORE, findRepoConfig, loadConfig, parseDuration, stalegreenHome } from "./core/config.js";
export type { Config, ExtraRunner } from "./core/config.js";
export { buildReceipts, describeCounts, detectRuns, MARKER_RE, readDeferred, readEdits, readPending, readReceipts, readVerdicts, recordRun, runLogPath } from "./core/receipts.js";
export type { BuiltReceipt, DeferredRun, PendingRun, ReceiptContext, RunInput, VerdictRecord } from "./core/receipts.js";
export { deriveSession, listSessions, sessionDir } from "./core/store.js";
export type { SessionRef } from "./core/store.js";
export { runClaudeHook } from "./harness/claude/hooks.js";
export { runCodexHook } from "./harness/codex/hooks.js";
export { applyPatchEdits, exitFromCellOutput, extractExecCommands, parseCodexExecOutput } from "./harness/codex/output.js";
export type { CodexExecOutput, CodexRunState } from "./harness/codex/output.js";
export { runHook } from "./harness/hooks.js";
export type { HarnessAdapter, HookOutcome, ShellRun } from "./harness/hooks.js";
export { replayClaudeSession, claudeTranscriptFiles } from "./harness/claude/transcript.js";
export { replayCodexSession, readCodexEvents, codexTranscriptFiles, codexSessionGroups } from "./harness/codex/transcript.js";
export type { ReplayOptions, ReplayVerdict, RunStats, SessionReplay } from "./harness/replay.js";
export { VERSION } from "./version.js";
