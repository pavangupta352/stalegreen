/**
 * Claude Code hook handlers: PreToolUse, PostToolUse, Stop and SubagentStop.
 * Input arrives as JSON on stdin; a block is exit code 2 with the message on
 * stderr. Every handler fails open.
 */

import { join } from "node:path";
import { dedupeClaims, extractClaims } from "../../core/claims.js";
import { loadConfig, type Config } from "../../core/config.js";
import { editFromTool, editsFromBash, toEditEvent } from "../../core/edits.js";
import { computeFingerprint } from "../../core/fingerprint.js";
import { evaluate, formatBlockMessage } from "../../core/freshness.js";
import type { Category, Fingerprint, Receipt } from "../../core/grammar.js";
import { parseOutput } from "../../core/runners.js";
import { detectRuns, MARKER_RE, readDeferred, readEdits, readReceipts, recordRun, type DeferredRun, type PendingRun, type VerdictRecord } from "../../core/receipts.js";
import { appendJsonl, deriveSession, ensureDir, nextReceiptId, readJsonFile, sessionDir, writeJsonFile } from "../../core/store.js";

export interface HookOutcome {
  exit: number;
  stdout?: string;
  stderr?: string;
}

interface TurnState {
  promptId: string | null;
  blocked: Category[];
  ts: string;
}

type Input = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function obj(v: unknown): Input {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Input) : {};
}

function nowIso(): string {
  return new Date().toISOString();
}

function turnStatePath(dir: string, agent: string | null): string {
  return join(dir, agent ? `turn-${agent.replace(/[^A-Za-z0-9._-]/g, "_")}.json` : "turn.json");
}

/** Handles one Claude Code hook event. Throws only on programming errors; the entry point catches those. */
export function runClaudeHook(event: string, raw: unknown): HookOutcome {
  const input = obj(raw);
  const cwd = str(input.cwd) ?? process.cwd();
  const config = loadConfig(cwd);
  const session = deriveSession(input);
  const dir = sessionDir(session.root);
  switch (event) {
    case "PreToolUse":
      return preToolUse(input, cwd, config, session.root, session.agent, dir);
    case "PostToolUse":
      return postToolUse(input, cwd, config, session.root, session.agent, dir);
    case "Stop":
    case "SubagentStop":
      return stop(event, input, cwd, config, session.root, session.agent, dir);
    default:
      return { exit: 0 };
  }
}

function preToolUse(input: Input, cwd: string, config: Config, root: string, agent: string | null, dir: string): HookOutcome {
  if (str(input.tool_name) !== "Bash") return { exit: 0 };
  const toolInput = obj(input.tool_input);
  const command = str(toolInput.command);
  if (!command) return { exit: 0 };
  const detections = detectRuns(command, config).filter((d) => d.notRun === null);
  if (detections.length === 0) return { exit: 0 };
  const d = detections[0]!;
  ensureDir(dir);
  const pending: PendingRun = {
    id: nextReceiptId(dir),
    ts: nowIso(),
    toolUseId: str(input.tool_use_id),
    command,
    wrappedCommand: null,
    cwd,
    runner: d.runner,
    category: d.category,
    scope: d.scope,
    cd: d.cd,
    background: toolInput.run_in_background === true,
    agent,
    log: null,
  };
  appendJsonl(join(dir, "pending.jsonl"), pending);
  return { exit: 0 };
}

function postToolUse(input: Input, cwd: string, config: Config, root: string, agent: string | null, dir: string): HookOutcome {
  const toolName = str(input.tool_name) ?? "";
  const toolInput = obj(input.tool_input);
  const ts = nowIso();
  if (toolName === "Bash") {
    const command = str(toolInput.command);
    if (!command) return { exit: 0 };
    const response = input.tool_response;
    const r = obj(response);
    const stdout = str(r.stdout) ?? (typeof response === "string" ? response : "");
    const stderr = str(r.stderr) ?? "";
    const exit = typeof r.exit_code === "number" ? r.exit_code : typeof r.exitCode === "number" ? r.exitCode : null;
    const interrupted = r.interrupted === true;
    const background = toolInput.run_in_background === true;
    const detections = detectRuns(command, config).filter((d) => d.notRun === null);
    const hasMarker = MARKER_RE.test(`${stdout}\n${stderr}`);
    if (background && detections.length > 0) {
      for (const d of detections) {
        const rec: DeferredRun = { id: nextReceiptId(dir), ts, category: d.category, runner: d.runner, cmd: d.segment.head };
        appendJsonl(join(dir, "deferred.jsonl"), rec);
      }
    } else if (detections.length > 0 || hasMarker) {
      recordRun({ command, stdout, stderr, exit, interrupted, cwd, toolUseId: str(input.tool_use_id) }, { harness: "claude", root, agent, config, now: ts });
    }
    for (const e of editsFromBash(command)) appendJsonl(join(dir, "edits.jsonl"), toEditEvent(e, ts, agent));
    return { exit: 0 };
  }
  if (toolName === "TaskOutput" || toolName === "BashOutput") {
    const r = obj(input.tool_response);
    const text = [str(r.stdout), str(r.output), str(r.stderr), typeof input.tool_response === "string" ? input.tool_response : null].filter((s): s is string => !!s).join("\n");
    if (!text) return { exit: 0 };
    for (const d of readDeferred(root)) {
      const parsed = parseOutput(d.category, text, { exit: null });
      if (parsed.verdict !== "fail") continue;
      const fingerprint: Fingerprint = computeFingerprint(cwd, { budgetMs: config.fingerprintBudgetMs, ignore: config.fingerprintIgnore });
      const receipt: Receipt = {
        id: d.id,
        ts,
        harness: "claude",
        session: root,
        agent,
        cwd,
        cmd: d.cmd,
        source: d.cmd,
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
    return { exit: 0 };
  }
  const edit = editFromTool(toolName, toolInput);
  if (edit) appendJsonl(join(dir, "edits.jsonl"), toEditEvent(edit, ts, agent));
  return { exit: 0 };
}

function stop(event: string, input: Input, cwd: string, config: Config, root: string, agent: string | null, dir: string): HookOutcome {
  const text = str(input.last_assistant_message);
  if (!text) return { exit: 0 };
  const claims = dedupeClaims(extractClaims(text));
  if (claims.length === 0) return { exit: 0 };
  const now = nowIso();
  const promptId = str(input.prompt_id);
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
    return { exit: 2, stderr: message ?? "" };
  }
  if (!sameTurn) writeJsonFile(statePath, { promptId, blocked: [], ts: now } satisfies TurnState);
  return { exit: 0 };
}
