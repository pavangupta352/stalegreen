/**
 * The hook handlers shared by every harness: PreToolUse (unmask), PostToolUse
 * (receipts and edit events) and Stop or SubagentStop (the freshness gate).
 *
 * A harness adapter supplies what differs: the turn id for the loop guard,
 * how the shell tool reports its output, which tools edit files, whether a
 * rewrite may carry an allow decision, and how a block is expressed.
 * Every handler fails open; the entry point catches anything thrown here.
 */

import { join } from "node:path";
import { dedupeClaims, extractClaims } from "../core/claims.js";
import { loadConfig, type Config } from "../core/config.js";
import { editsFromBash, toEditEvent, type EditCandidate } from "../core/edits.js";
import { computeFingerprint } from "../core/fingerprint.js";
import { evaluate, formatBlockMessage } from "../core/freshness.js";
import type { Category, Fingerprint, Harness, Receipt } from "../core/grammar.js";
import { analyzeMasking } from "../core/masking.js";
import { parseOutput, type Detection } from "../core/runners.js";
import { detectRuns, MARKER_RE, readDeferred, readEdits, readReceipts, recordRun, resolveLogRead, runLogPath, type DeferredRun, type PendingRun, type VerdictRecord } from "../core/receipts.js";
import { planRewrite, type RewriteTarget } from "../core/rewrite.js";
import { parseCommand, type ParsedCommand } from "../core/shell.js";
import { appendJsonl, deriveSession, ensureDir, nextReceiptId, readJsonFile, sessionDir, writeJsonFile } from "../core/store.js";

export interface HookOutcome {
  exit: number;
  stdout?: string;
  stderr?: string;
}

export type Input = Record<string, unknown>;

/** What a harness reported about one shell run. */
export interface ShellRun {
  command: string;
  stdout: string;
  stderr: string;
  exit: number | null;
  /** The harness said the run failed without giving a number. */
  exitFailed: boolean;
  interrupted: boolean;
  /** The run was still going when the tool returned. */
  background: boolean;
  /** The id a still-running command can be waited on with, when the harness has one. */
  cellId: string | null;
}

/** Output that completes an earlier background run. */
export interface DeferredOutput {
  text: string;
  /** Known when the harness reports how the run ended; null means only a failure can be read from the text. */
  state: "completed" | "failed" | null;
  exit: number | null;
  cellId: string | null;
}

export interface AllowDecision {
  allow: boolean;
  reason: string;
}

export interface HarnessAdapter {
  harness: Harness;
  /** The id of the user turn the event belongs to, for the loop guard. */
  turnId(input: Input): string | null;
  /** Whether a wrapped command may be returned with an allow decision, and why. */
  allowDecision(input: Input, config: Config, ctx: { command: string; targets: RewriteTarget[]; parsed: ParsedCommand; cwd: string }): AllowDecision;
  /** True when the harness accepts `updatedInput` only together with an allow decision. */
  rewriteNeedsAllow: boolean;
  /** The shell run in a PostToolUse payload, or null when the tool is not the shell. */
  shellRun(input: Input): ShellRun | null;
  /** Output of a tool that reports on an earlier background run, or null. */
  deferredOutput(input: Input): DeferredOutput | null;
  /** Edits made by a non-shell tool. */
  editsFromTool(toolName: string, toolInput: unknown): EditCandidate[];
  /** How the harness is told to keep going instead of stopping. */
  block(message: string): HookOutcome;
}

interface TurnState {
  promptId: string | null;
  blocked: Category[];
  ts: string;
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function obj(v: unknown): Input {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Input) : {};
}

function nowIso(): string {
  return new Date().toISOString();
}

function turnStatePath(dir: string, agent: string | null): string {
  return join(dir, agent ? `turn-${agent.replace(/[^A-Za-z0-9._-]/g, "_")}.json` : "turn.json");
}

/** Handles one hook event for a harness. Throws only on programming errors. */
export function runHook(adapter: HarnessAdapter, event: string, raw: unknown): HookOutcome {
  const input = obj(raw);
  const cwd = str(input.cwd) ?? process.cwd();
  const config = loadConfig(cwd);
  const session = deriveSession(input);
  const dir = sessionDir(session.root);
  const ctx: Ctx = { adapter, input, cwd, config, root: session.root, agent: session.agent, dir };
  switch (event) {
    case "PreToolUse":
      return preToolUse(ctx);
    case "PostToolUse":
      return postToolUse(ctx);
    case "Stop":
    case "SubagentStop":
      return stop(ctx, event);
    default:
      return { exit: 0 };
  }
}

interface Ctx {
  adapter: HarnessAdapter;
  input: Input;
  cwd: string;
  config: Config;
  root: string;
  agent: string | null;
  dir: string;
}

function preToolUse({ adapter, input, cwd, config, root, agent, dir }: Ctx): HookOutcome {
  if (str(input.tool_name) !== "Bash") return { exit: 0 };
  const toolInput = obj(input.tool_input);
  const command = str(toolInput.command);
  if (!command) return { exit: 0 };
  const parsed = parseCommand(command);
  const detections = detectRuns(command, config, parsed).filter((d) => d.notRun === null);
  if (detections.length === 0) return { exit: 0 };
  ensureDir(dir);
  const ts = nowIso();
  const background = toolInput.run_in_background === true;
  const record = (d: Detection, id: string, wrappedCommand: string | null, unwrapped: string | null, log: string | null): PendingRun => {
    const p: PendingRun = { id, ts, toolUseId: str(input.tool_use_id), command, wrappedCommand, cwd, runner: d.runner, category: d.category, scope: d.scope, cd: d.cd, background, agent, log };
    if (unwrapped) p.unwrapped = unwrapped;
    appendJsonl(join(dir, "pending.jsonl"), p);
    return p;
  };
  if (config.mode === "off" || background) {
    record(detections[0]!, nextReceiptId(dir), null, config.mode === "off" ? "mode-off" : "background", null);
    return { exit: 0 };
  }
  const targets: RewriteTarget[] = detections.map((d) => {
    const id = nextReceiptId(dir);
    return { detection: d, id, log: runLogPath(root, id) };
  });
  const plan = planRewrite(command, targets, config, parsed);
  const deny = (reason: string): HookOutcome => ({ exit: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) });
  if (!plan.command) {
    record(detections[0]!, targets[0]!.id, null, plan.reason, null);
    if (config.mode === "strict") {
      const analysis = analyzeMasking(parsed, detections[0]!.segmentIndex);
      if (analysis.masked && !analysis.exitPreserved) {
        return deny(`stalegreen: \`${detections[0]!.segment.head}\` is piped or chained so its result would not be recorded, and it cannot be wrapped (${plan.reason}). Run it without the pipe or suffix so the result is recorded.`);
      }
    }
    return { exit: 0 };
  }
  const decision = adapter.allowDecision(input, config, { command, targets, parsed, cwd });
  if (adapter.rewriteNeedsAllow && !decision.allow) {
    // The harness only takes a rewrite together with an allow decision, and this run may not carry one.
    record(detections[0]!, targets[0]!.id, null, "no-allow", null);
    if (config.mode === "strict") {
      const analysis = analyzeMasking(parsed, detections[0]!.segmentIndex);
      if (analysis.masked && !analysis.exitPreserved) {
        return deny(`stalegreen: \`${detections[0]!.segment.head}\` is piped or chained so its result would not be recorded. Run it without the pipe or suffix so the result is recorded.`);
      }
    }
    return { exit: 0 };
  }
  for (const t of targets) record(t.detection, t.id, plan.command, null, t.log);
  const hookSpecificOutput: Record<string, unknown> = { hookEventName: "PreToolUse", updatedInput: { ...toolInput, command: plan.command } };
  if (decision.allow) {
    hookSpecificOutput.permissionDecision = "allow";
    hookSpecificOutput.permissionDecisionReason = decision.reason;
  }
  return { exit: 0, stdout: JSON.stringify({ hookSpecificOutput }) };
}

function postToolUse(ctx: Ctx): HookOutcome {
  const { adapter, input, cwd, config, root, agent, dir } = ctx;
  const toolName = str(input.tool_name) ?? "";
  const toolInput = obj(input.tool_input);
  const ts = nowIso();
  const receiptCtx = { harness: adapter.harness, root, agent, config, now: ts };
  const run = adapter.shellRun(input);
  if (run) {
    const combined = `${run.stdout}\n${run.stderr}`;
    const detections = detectRuns(run.command, config).filter((d) => d.notRun === null);
    const hasMarker = MARKER_RE.test(combined);
    if (run.background && detections.length > 0 && !hasMarker) {
      for (const d of detections) {
        const rec: DeferredRun = { id: nextReceiptId(dir), ts, category: d.category, runner: d.runner, cmd: d.segment.head, command: run.command, cwd };
        if (run.cellId) rec.cellId = run.cellId;
        appendJsonl(join(dir, "deferred.jsonl"), rec);
      }
    } else if (detections.length > 0 || hasMarker) {
      recordRun({ command: run.command, stdout: run.stdout, stderr: run.stderr, exit: run.exit, exitFailed: run.exitFailed, interrupted: run.interrupted, cwd, toolUseId: str(input.tool_use_id) }, receiptCtx);
    } else {
      const read = resolveLogRead({ command: run.command, stdout: run.stdout, stderr: run.stderr, exit: run.exit, interrupted: run.interrupted, cwd, toolUseId: str(input.tool_use_id) }, receiptCtx, readReceipts(root));
      if (read) {
        read.id = nextReceiptId(dir);
        appendJsonl(join(dir, "receipts.jsonl"), read);
      }
    }
    for (const e of editsFromBash(run.command, combined)) appendJsonl(join(dir, "edits.jsonl"), toEditEvent(e, ts, agent));
    return { exit: 0 };
  }
  const deferredOut = adapter.deferredOutput(input);
  if (deferredOut) {
    resolveDeferred(ctx, deferredOut, ts);
    return { exit: 0 };
  }
  for (const edit of adapter.editsFromTool(toolName, toolInput)) appendJsonl(join(dir, "edits.jsonl"), toEditEvent(edit, ts, agent));
  return { exit: 0 };
}

/** Output of a wait or task-output tool: finishes the background runs it belongs to. */
function resolveDeferred({ adapter, input, cwd, config, root, agent, dir }: Ctx, out: DeferredOutput, ts: string): void {
  const text = out.text;
  if (!text && out.state === null) return;
  const pending = readDeferred(root).filter((d) => !("resolved" in d));
  const matching = out.cellId ? pending.filter((d) => d.cellId === out.cellId) : pending;
  if (matching.length === 0) return;
  const receiptCtx = { harness: adapter.harness, root, agent, config, now: ts };
  if (out.state !== null || MARKER_RE.test(text)) {
    // The harness said how the run ended (or our own marker did): the receipt is built like any other run.
    const command = matching[0]!.command ?? matching[0]!.cmd;
    const exitFailed = out.state === "failed" && out.exit === null;
    recordRun({ command, stdout: text, stderr: "", exit: out.exit ?? (out.state === "completed" ? 0 : null), exitFailed, interrupted: false, background: true, cwd: matching[0]!.cwd ?? cwd, toolUseId: str(input.tool_use_id) }, receiptCtx);
    for (const d of matching) appendJsonl(join(dir, "deferred.jsonl"), { ...d, ts, resolved: true });
    return;
  }
  // Only the text is known: a failure marker in it is enough to record a failed run.
  for (const d of matching) {
    const parsed = parseOutput(d.category, text, { exit: null });
    if (parsed.verdict !== "fail") continue;
    const fingerprint: Fingerprint = computeFingerprint(cwd, { budgetMs: config.fingerprintBudgetMs, ignore: config.fingerprintIgnore });
    const receipt: Receipt = {
      id: d.id,
      ts,
      harness: adapter.harness,
      session: root,
      agent,
      cwd,
      cmd: d.cmd,
      source: d.command ?? d.cmd,
      runner: d.runner,
      category: d.category,
      scope: "all",
      exit: null,
      verdict: "fail",
      counts: parsed.counts,
      signal: parsed.signal,
      masked: false,
      wrapped: false,
      background: true,
      fingerprint,
      log: null,
    };
    appendJsonl(join(dir, "receipts.jsonl"), receipt);
    appendJsonl(join(dir, "deferred.jsonl"), { ...d, ts, resolved: true });
  }
}

function stop({ adapter, input, cwd, config, root, agent, dir }: Ctx, event: string): HookOutcome {
  const text = str(input.last_assistant_message);
  if (!text) return { exit: 0 };
  const claims = dedupeClaims(extractClaims(text));
  if (claims.length === 0) return { exit: 0 };
  const now = nowIso();
  const promptId = adapter.turnId(input);
  const stopHookActive = input.stop_hook_active === true;
  const statePath = turnStatePath(dir, agent);
  const state = readJsonFile<TurnState>(statePath);
  const sameTurn = state !== null && (promptId ? state.promptId === promptId : stopHookActive);
  const blockedThisTurn = new Set<Category>(sameTurn ? state!.blocked : []);
  const cache = new Map<string, Fingerprint>();
  const fingerprintFor = (c: string): Fingerprint => {
    let f = cache.get(c);
    if (!f) {
      f = computeFingerprint(c, { budgetMs: config.fingerprintBudgetMs, ignore: config.fingerprintIgnore });
      cache.set(c, f);
    }
    return f;
  };
  const verdicts = evaluate({
    claims,
    receipts: readReceipts(root),
    edits: readEdits(root),
    deferred: readDeferred(root),
    now,
    cwd,
    config,
    fingerprintFor,
    blockedThisTurn,
  });
  const blocked = verdicts.filter((v) => v.action === "blocked");
  const message = blocked.length > 0 ? formatBlockMessage(blocked, cwd) : undefined;
  const record: VerdictRecord = { ts: now, root, agent, promptId, event, verdicts, blocked: blocked.length > 0 };
  if (message) record.message = message;
  appendJsonl(join(dir, "verdicts.jsonl"), record);
  if (blocked.length > 0) {
    const categories = new Set<Category>([...blockedThisTurn, ...blocked.map((v) => v.claim.category)]);
    writeJsonFile(statePath, { promptId, blocked: [...categories], ts: now } satisfies TurnState);
    return adapter.block(message ?? "");
  }
  if (!sameTurn) writeJsonFile(statePath, { promptId, blocked: [], ts: now } satisfies TurnState);
  return { exit: 0 };
}
