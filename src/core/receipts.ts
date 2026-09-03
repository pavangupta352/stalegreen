/**
 * Receipts: one record per verification run, built from the command, its
 * output and its exit status, joined to the pending record the PreToolUse
 * hook wrote before the command ran.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "./config.js";
import { computeFingerprint } from "./fingerprint.js";
import type { Category, Counts, EditEvent, Fingerprint, Harness, Receipt, RunScope, RunVerdict, Verdict } from "./grammar.js";
import { analyzeMasking, type MaskAnalysis } from "./masking.js";
import { detectAll, parseOutput, type Detection } from "./runners.js";
import { parseCommand, type ParsedCommand } from "./shell.js";
import { appendJsonl, ensureDir, nextReceiptId, readJsonl, sessionDir } from "./store.js";

export interface PendingRun {
  id: string;
  ts: string;
  toolUseId: string | null;
  command: string;
  wrappedCommand: string | null;
  cwd: string;
  runner: string;
  category: Category;
  scope: RunScope;
  cd: string | null;
  background: boolean;
  unwrapped?: string;
  agent: string | null;
  log: string | null;
}

export interface DeferredRun {
  id: string;
  ts: string;
  category: Category;
  runner: string;
  cmd: string;
  resolved?: boolean;
}

export interface VerdictRecord {
  ts: string;
  root: string;
  agent: string | null;
  promptId: string | null;
  event: string;
  verdicts: Verdict[];
  blocked: boolean;
  message?: string;
}

export interface RunInput {
  command: string;
  stdout: string;
  stderr: string;
  exit: number | null;
  interrupted: boolean;
  cwd: string;
  toolUseId?: string | null;
}

export interface ReceiptContext {
  harness: Harness;
  root: string;
  agent: string | null;
  config: Config;
  now?: string;
}

export const MARKER_RE = /\[stalegreen\] exit=(-?\d+) receipt=(r-[\w-]+)(?: lines=(\d+))?(?: log=(\S+))?/;

export function runLogPath(root: string, id: string): string {
  return join(sessionDir(root), "runs", `${id}.log`);
}

export function readReceipts(root: string): Receipt[] {
  return readJsonl<Receipt>(join(sessionDir(root), "receipts.jsonl"));
}

export function readEdits(root: string): EditEvent[] {
  return readJsonl<EditEvent>(join(sessionDir(root), "edits.jsonl"));
}

export function readPending(root: string): PendingRun[] {
  return readJsonl<PendingRun>(join(sessionDir(root), "pending.jsonl"));
}

export function readDeferred(root: string): DeferredRun[] {
  const all = readJsonl<DeferredRun>(join(sessionDir(root), "deferred.jsonl"));
  const resolved = new Set(all.filter((d) => d.resolved).map((d) => d.id));
  return all.filter((d) => !d.resolved && !resolved.has(d.id));
}

export function readVerdicts(root: string): VerdictRecord[] {
  return readJsonl<VerdictRecord>(join(sessionDir(root), "verdicts.jsonl"));
}

/** Detects runs in a command, honouring `ignoreCommands`, disabled categories and `extraRunners`. */
export function detectRuns(command: string, config: Config, parsed?: ParsedCommand): Detection[] {
  const p = parsed ?? parseCommand(command);
  let found = detectAll(command, p);
  if (config.extraRunners.length > 0) {
    const taken = new Set(found.map((d) => d.segmentIndex));
    p.segments.forEach((seg, i) => {
      if (taken.has(i) || seg.words.length === 0) return;
      for (const extra of config.extraRunners) {
        let re: RegExp;
        try {
          re = new RegExp(extra.match);
        } catch {
          continue;
        }
        if (!re.test(seg.head)) continue;
        found.push({ runner: extra.match, category: extra.category, scope: "all", segmentIndex: i, segment: seg, words: seg.words, cd: null, quiet: false, notRun: null, sudo: false, nested: false });
        break;
      }
    });
    found.sort((a, b) => a.segmentIndex - b.segmentIndex);
  }
  found = found.filter((d) => config.categories[d.category] !== false);
  if (config.ignoreCommands.length > 0) {
    found = found.filter((d) => !config.ignoreCommands.some((ig) => ig.length > 0 && (d.segment.head.includes(ig) || command.includes(ig))));
  }
  return found;
}

function truncateLog(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.2);
  const tail = max - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[stalegreen] log truncated: ${omitted} characters omitted\n${text.slice(text.length - tail)}`;
}

function readLog(path: string, max: number): string | null {
  try {
    if (!existsSync(path)) return null;
    const size = statSync(path).size;
    if (size > max * 4) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function extraVerdict(config: Config, runner: string, output: string, exit: number | null): { verdict: RunVerdict; signal: string } | null {
  const extra = config.extraRunners.find((e) => e.match === runner);
  if (!extra) return null;
  try {
    if (extra.fail && new RegExp(extra.fail, "m").test(output)) return { verdict: "fail", signal: "extra-fail" };
    if (extra.pass && exit === 0 && new RegExp(extra.pass, "m").test(output)) return { verdict: "pass", signal: "extra-pass" };
  } catch {
    return null;
  }
  return null;
}

function maskingFor(parsed: ParsedCommand, d: Detection): MaskAnalysis {
  const outer = analyzeMasking(parsed, d.segmentIndex);
  if (!d.inner) return outer;
  const innerParsed = parseCommand(d.inner.command);
  const inner = analyzeMasking(innerParsed, d.inner.index);
  return {
    masked: outer.masked || inner.masked,
    reasons: [...inner.reasons, ...outer.reasons],
    exitPreserved: outer.exitPreserved && inner.exitPreserved,
    outputVisible: outer.outputVisible && inner.outputVisible,
    tailLines: inner.tailLines ?? outer.tailLines,
    pipefail: inner.pipefail,
    background: outer.background || inner.background,
    pipelineEnd: outer.pipelineEnd,
  };
}

export interface BuiltReceipt {
  receipt: Receipt;
  output: string;
}

/**
 * Builds receipts for a finished command. Pure apart from the fingerprint.
 * Ids are placeholders (`r-?`) until `recordRun` assigns them.
 */
export function buildReceipts(input: RunInput, ctx: ReceiptContext, pending: PendingRun | null): BuiltReceipt[] {
  const now = ctx.now ?? new Date().toISOString();
  const combined = `${input.stdout ?? ""}${input.stderr ? `\n${input.stderr}` : ""}`;
  const marker = MARKER_RE.exec(combined);
  const fingerprints = new Map<string, Fingerprint>();
  const fingerprintFor = (cwd: string): Fingerprint => {
    let f = fingerprints.get(cwd);
    if (!f) {
      f = computeFingerprint(cwd, { budgetMs: ctx.config.fingerprintBudgetMs, ignore: ctx.config.fingerprintIgnore });
      fingerprints.set(cwd, f);
    }
    return f;
  };
  const base = (d: Detection | null, extra: Partial<Receipt>): Receipt => ({
    id: "r-?",
    ts: now,
    harness: ctx.harness,
    session: ctx.root,
    agent: ctx.agent,
    cwd: input.cwd,
    cmd: d ? d.segment.head : input.command,
    source: input.command,
    runner: d?.runner ?? "unknown",
    category: d?.category ?? "test",
    scope: d?.scope ?? "all",
    exit: null,
    verdict: "inconclusive",
    counts: {},
    signal: null,
    masked: false,
    wrapped: false,
    fingerprint: { head: null, tree: null, available: false, reason: "not-computed" },
    log: null,
    ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
    ...extra,
  });

  if (marker) {
    // The wrapped path: the exit status came through the marker and the full output is on disk.
    const id = marker[2] as string;
    const exit = Number(marker[1]);
    const logPath = marker[4] ?? runLogPath(ctx.root, id);
    const output = readLog(logPath, ctx.config.maxLogBytes) ?? combined;
    const source = pending?.command ?? input.command;
    const detections = detectRuns(source, ctx.config);
    const d = detections.find((x) => x.notRun === null) ?? detections[0] ?? null;
    const cwd = resolve(input.cwd, pending?.cd ?? d?.cd ?? ".");
    const category = pending?.category ?? d?.category ?? "test";
    const parsed = parseOutput(category, output, { exit, interrupted: input.interrupted });
    const extra = extraVerdict(ctx.config, pending?.runner ?? d?.runner ?? "", output, exit);
    const receipt = base(d, {
      id,
      cwd,
      cmd: d?.segment.head ?? pending?.command ?? input.command,
      source,
      runner: pending?.runner ?? d?.runner ?? "unknown",
      category,
      scope: pending?.scope ?? d?.scope ?? "all",
      exit,
      verdict: extra?.verdict ?? parsed.verdict,
      counts: parsed.counts,
      signal: extra?.signal ?? parsed.signal,
      masked: false,
      wrapped: true,
      ...(d?.quiet ? { quiet: true } : {}),
      ...(input.interrupted ? { interrupted: true } : {}),
      fingerprint: fingerprintFor(cwd),
      log: logPath,
    });
    return [{ receipt, output }];
  }

  const parsedCommand = parseCommand(input.command);
  const detections = detectRuns(input.command, ctx.config, parsedCommand).filter((d) => d.notRun === null);
  if (detections.length === 0) return [];
  const exitKnown = input.exit !== null && input.exit !== undefined;
  const analyses = detections.map((d) => maskingFor(parsedCommand, d));
  const output = combined;
  const preliminary = detections.map((d, i) => parseOutput(d.category, output, { exit: null, interrupted: input.interrupted }));
  const anyFail = preliminary.some((r) => r.verdict === "fail");
  const out: BuiltReceipt[] = [];
  detections.forEach((d, i) => {
    const analysis = analyses[i] as MaskAnalysis;
    if (analysis.background) return;
    let exit: number | null = null;
    let signalNote: string | null = null;
    if (exitKnown && analysis.exitPreserved) {
      if (input.exit === 0) exit = 0;
      else if (detections.length === 1) exit = input.exit;
      else if ((preliminary[i] as { verdict: RunVerdict }).verdict === "fail") exit = input.exit;
      else if (!anyFail && i === detections.length - 1) exit = input.exit;
      else signalNote = "compound-exit-unattributed";
    }
    const parsed = parseOutput(d.category, output, { exit, interrupted: input.interrupted });
    const extra = extraVerdict(ctx.config, d.runner, output, exit);
    let verdict = extra?.verdict ?? parsed.verdict;
    let signal = extra?.signal ?? parsed.signal;
    if (signalNote && verdict === "inconclusive") signal = signalNote;
    if (verdict === "pass" && analysis.masked && !analysis.exitPreserved) {
      verdict = "inconclusive";
      signal = "masked";
    }
    const cwd = resolve(input.cwd, d.cd ?? ".");
    const receipt = base(d, {
      cwd,
      exit,
      verdict,
      counts: parsed.counts,
      signal,
      masked: analysis.masked,
      ...(analysis.reasons.length ? { maskReason: analysis.reasons.join(",") } : {}),
      wrapped: false,
      ...(pending?.unwrapped ? { unwrapped: pending.unwrapped } : {}),
      ...(d.quiet ? { quiet: true } : {}),
      ...(input.interrupted ? { interrupted: true } : {}),
      fingerprint: fingerprintFor(cwd),
    });
    out.push({ receipt, output });
  });
  return out;
}

/** Builds and stores receipts, assigning ids and writing run logs. */
export function recordRun(input: RunInput, ctx: ReceiptContext): Receipt[] {
  const dir = sessionDir(ctx.root);
  ensureDir(dir);
  const pendingAll = readPending(ctx.root);
  const combined = `${input.stdout ?? ""}\n${input.stderr ?? ""}`;
  const marker = MARKER_RE.exec(combined);
  let pending: PendingRun | null = null;
  if (marker) pending = pendingAll.find((p) => p.id === marker[2]) ?? null;
  else if (input.toolUseId) pending = pendingAll.filter((p) => p.toolUseId === input.toolUseId).pop() ?? null;
  else pending = pendingAll.filter((p) => p.command === input.command && !p.wrappedCommand).pop() ?? null;
  const built = buildReceipts(input, ctx, pending);
  const receipts: Receipt[] = [];
  built.forEach((b, i) => {
    const r = b.receipt;
    if (r.id === "r-?") r.id = i === 0 && pending && !marker ? pending.id : nextReceiptId(dir);
    if (!r.log) {
      const logPath = runLogPath(ctx.root, r.id);
      try {
        ensureDir(join(dir, "runs"));
        writeFileSync(logPath, truncateLog(b.output, ctx.config.maxLogBytes));
        r.log = logPath;
      } catch {
        r.log = null;
      }
    }
    appendJsonl(join(dir, "receipts.jsonl"), r);
    receipts.push(r);
  });
  return receipts;
}

/** A compact, human-readable description of a receipt for messages. */
export function describeCounts(counts: Counts): string {
  const parts: string[] = [];
  if (counts.failed !== undefined && counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.errors !== undefined && counts.errors > 0) parts.push(`${counts.errors} error${counts.errors === 1 ? "" : "s"}`);
  if (counts.passed !== undefined) parts.push(`${counts.passed} passed`);
  if (parts.length === 0 && counts.errors === 0) parts.push("0 errors");
  return parts.join(", ");
}
