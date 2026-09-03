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
import { detectAll, hasFailSignal, isSilent, parseOutput, type Detection } from "./runners.js";
import { parseCommand, stripGroupingWords, type ParsedCommand, type Segment } from "./shell.js";
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
  /** Overrides the fingerprint computation, for example during a transcript replay where no tree exists. */
  fingerprintFor?: (cwd: string) => Fingerprint;
}

export const MARKER_RE = /\[stalegreen\] exit=(-?\d+) receipt=([\w-]+)(?: lines=(\d+))?(?: log=(\S+))?/;
const MARKER_RE_ALL = new RegExp(MARKER_RE.source, "g");

/** Every marker line in a command's output, in order. */
export function findMarkers(text: string): { exit: number; id: string; log: string | null }[] {
  const out: { exit: number; id: string; log: string | null }[] = [];
  for (const m of text.matchAll(MARKER_RE_ALL)) out.push({ exit: Number(m[1]), id: m[2] as string, log: m[4] ?? null });
  return out;
}

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

/**
 * The number printed by a `grep -c` or `wc -l` pipeline, optionally relabelled
 * by a following `xargs echo <label>`. Null when no such line is visible.
 */
function countedMatches(output: string, parsed: ParsedCommand, pipelineEnd: number): number | null {
  const last = parsed.segments[pipelineEnd] as Segment;
  const words = stripGroupingWords(last.words);
  let label = "";
  if (words[0] === "xargs" && words[1] === "echo") label = words.slice(2).join(" ");
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${escaped}\\s*(\\d+)\\s*$`, "m");
  const m = re.exec(output);
  return m ? Number(m[1]) : null;
}

/** Number of lines in a chunk of output, blank lines included, so a lone newline counts as one. */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  const parts = text.split("\n");
  return text.endsWith("\n") ? parts.length - 1 : parts.length;
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
    headLines: inner.headLines ?? outer.headLines,
    filtered: inner.filtered || outer.filtered,
    filterPatterns: [...inner.filterPatterns, ...outer.filterPatterns],
    countOnly: inner.countOnly || outer.countOnly,
    pipefail: inner.pipefail,
    background: outer.background || inner.background,
    pipelineEnd: outer.pipelineEnd,
  };
}

export interface BuiltReceipt {
  receipt: Receipt;
  output: string;
}

/** Output lines a runner prints first, used to find where its output starts inside a compound command's output. */
const RUNNER_HEADERS: [RegExp, RegExp][] = [
  [/^vitest$/, /^\s*RUN\s+v\d/],
  [/^pytest$/, /^=+ test session starts =+\s*$/],
  [/^jest$/, /^(?:PASS|FAIL) \S/],
  [/^next build$/, /^\s*▲ Next\.js/],
  [/^vite build$/, /^vite v\d/],
  [/^tsup$/, /^CLI Building entry/],
  [/^cargo /, /^\s+(?:Compiling|Checking|Finished|Running|Downloading|Updating)\b/],
  [/^go test$/, /^(?:ok|FAIL|\?)\s+\S+\s/],
  [/^playwright test$/, /^Running \d+ tests? using/],
  [/^mix test$/, /^Running ExUnit with seed/],
  [/^rspec$/, /^(?:Randomized with seed|Run options)/],
  [/^phpunit$/, /^PHPUnit \d/],
  [/^dotnet /, /^\s*Determining projects to restore/],
];

/** Text an `echo` or `printf` segment prints, when it is literal. */
function literalEcho(seg: Segment): string | null {
  const words = stripGroupingWords(seg.words);
  const w0 = words[0];
  if (w0 !== "echo" && w0 !== "printf") return null;
  const args = words.slice(1).filter((w) => !(w0 === "echo" && /^-[neE]+$/.test(w)));
  if (args.length === 0) return null;
  const text = w0 === "printf" ? (args[0] as string).replace(/\\n/g, "") : args.join(" ");
  if (/[$`]/.test(text) || text.trim().length < 3) return null;
  return text.trim();
}

/** Words in a grep pattern that make it a search for failures. */
const ERROR_PATTERN_RE = /error|✖|problem|fail|warning|Exception|panic|✘/i;

/** The tool a package script ran, from the second banner line npm, pnpm and yarn print. */
function scriptVia(output: string): string | undefined {
  const m = /^>\s+(?!\S+@\S+\s)([a-z][\w./@-]*(?: [^\n]*)?)$/m.exec(output) ?? /^\$ ([a-z][\w./@-]*(?: [^\n]*)?)$/m.exec(output);
  return m ? (m[1] as string).trim().slice(0, 120) : undefined;
}

/**
 * Agents often print the exit status themselves: `cmd; echo "exit: $?"` or
 * `cmd | tail; echo "EXIT:${PIPESTATUS[0]}"`. When such an echo follows the
 * runner's pipeline, its printed number is the runner's exit status. A bare
 * `$?` after a pipe is the last filter's status and is ignored there.
 */
export function recoverExitFromEcho(parsed: ParsedCommand, pipelineEnd: number, hasPipe: boolean, output: string): number | null {
  for (let j = pipelineEnd + 1; j <= Math.min(pipelineEnd + 2, parsed.segments.length - 1); j++) {
    const seg = parsed.segments[j] as Segment;
    if (j === pipelineEnd + 1 && seg.op !== ";" && seg.op !== "newline" && seg.op !== "&&") return null;
    const w0 = seg.words[0];
    if (w0 !== "echo" && w0 !== "printf") continue;
    const raw = seg.head;
    const pipeStatus = /\$\{?PIPESTATUS\[0\]\}?|\$pipestatus\[1\]/i.test(raw);
    const plain = /\$\?/.test(raw);
    if (!pipeStatus && !plain) continue;
    if (plain && !pipeStatus && hasPipe) return null;
    // Rebuild the printed line from the echo's literal text.
    const text = seg.words.slice(1).filter((w) => !(w0 === "echo" && /^-[neE]+$/.test(w))).join(" ");
    const escaped = text.replace(/\$\{?PIPESTATUS\[0\]\}?|\$pipestatus\[1\]|\$\?/gi, " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "(-?\\d+)");
    if (!escaped.includes("(-?\\d+)")) continue;
    const m = new RegExp(`^${escaped.replace(/\\\\n/g, "")}\\s*$`, "m").exec(output);
    if (m) return Number(m[1]);
    return null;
  }
  return null;
}

/**
 * Lines printed by the agent's own status echoes after a pipeline, such as
 * `TSC_EXIT:0` or `tsc exit: ` (empty under zsh), are not tool output.
 */
function stripStatusEchoLines(output: string, parsed: ParsedCommand, pipelineEnd: number): string {
  const patterns: RegExp[] = [];
  for (let j = pipelineEnd + 1; j <= Math.min(pipelineEnd + 2, parsed.segments.length - 1); j++) {
    const seg = parsed.segments[j] as Segment;
    const w0 = seg.words[0];
    if (w0 !== "echo" && w0 !== "printf") continue;
    if (!/\$[?{(]|\$[A-Za-z_]/.test(seg.head)) continue;
    const text = seg.words.slice(1).filter((w) => !(w0 === "echo" && /^-[neE]+$/.test(w))).join(" ");
    const escaped = text.replace(/\$\{[^}]*\}|\$\([^)]*\)|\$\??[A-Za-z_?]*/g, "\0").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\0/g, ".*");
    if (escaped.trim().length > 0) patterns.push(new RegExp(`^${escaped.replace(/\\\\n/g, "")}\\s*$`));
  }
  if (patterns.length === 0) return output;
  return output
    .split("\n")
    .filter((line) => !patterns.some((p) => p.test(line)))
    .join("\n");
}

/**
 * Splits a compound command's output between its segments using anchors: the
 * agent's own echo separators, package-manager script banners and the first
 * line each runner prints. Segments without anchors share the output between
 * the neighbouring anchors, which is never less than they had before.
 */
export function attributeOutput(parsed: ParsedCommand, detections: Detection[], output: string): Map<number, string> {
  const lines = output.split("\n");
  const pos = new Map<number, number>();
  let cursor = 0;
  const findLine = (test: (line: string) => boolean): number => {
    for (let i = cursor; i < lines.length; i++) if (test(lines[i] as string)) return i;
    return -1;
  };
  const byIndex = new Map(detections.map((d) => [d.segmentIndex, d]));
  parsed.segments.forEach((seg, i) => {
    const echo = literalEcho(seg);
    let found = -1;
    if (echo !== null) found = findLine((l) => l.trim() === echo);
    else {
      const d = byIndex.get(i);
      if (d) {
        const script = /^(?:npm run|npm|pnpm run|pnpm|yarn run|yarn|bun run) (\S+)$/.exec(d.runner)?.[1];
        if (script) found = findLine((l) => new RegExp(`^> \\S+@\\S+ ${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(l) || /^\$ /.test(l));
        if (found < 0) {
          const header = RUNNER_HEADERS.find(([r]) => r.test(d.runner))?.[1];
          if (header) found = findLine((l) => header.test(l));
        }
      }
    }
    if (found >= 0) {
      pos.set(i, found);
      cursor = found + 1;
    }
  });
  const out = new Map<number, string>();
  if (pos.size === 0) {
    for (const d of detections) out.set(d.segmentIndex, output);
    return out;
  }
  for (const d of detections) {
    const i = d.segmentIndex;
    let start = 0;
    for (const [j, p] of pos) {
      // An earlier segment's anchor line belongs to that segment; the runner's own header stays in its chunk.
      const from = j === i ? p : p + 1;
      if (j <= i && from >= start) start = from;
    }
    let end = lines.length;
    for (const [j, p] of pos) if (j > i && p < end) end = p;
    out.set(i, lines.slice(start, Math.max(start, end)).join("\n"));
  }
  return out;
}

/**
 * Builds receipts for a finished command. Pure apart from the fingerprint.
 * Ids are placeholders (`r-?`) until `recordRun` assigns them.
 */
export function buildReceipts(input: RunInput, ctx: ReceiptContext, pending: PendingRun | null, pendingAll: PendingRun[] = pending ? [pending] : []): BuiltReceipt[] {
  const now = ctx.now ?? new Date().toISOString();
  const combined = `${input.stdout ?? ""}${input.stderr ? `\n${input.stderr}` : ""}`;
  const markers = findMarkers(combined);
  const fingerprints = new Map<string, Fingerprint>();
  const fingerprintFor = (cwd: string): Fingerprint => {
    let f = fingerprints.get(cwd);
    if (!f) {
      f = ctx.fingerprintFor ? ctx.fingerprintFor(cwd) : computeFingerprint(cwd, { budgetMs: ctx.config.fingerprintBudgetMs, ignore: ctx.config.fingerprintIgnore });
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

  if (markers.length > 0) {
    // The wrapped path: each marker carries the exit status and the full output is on disk.
    const out: BuiltReceipt[] = [];
    for (const marker of markers) {
      const p = pendingAll.find((x) => x.id === marker.id) ?? (pending?.id === marker.id ? pending : null);
      const logPath = marker.log ?? p?.log ?? runLogPath(ctx.root, marker.id);
      const output = readLog(logPath, ctx.config.maxLogBytes) ?? combined;
      const source = p?.command ?? input.command;
      const detections = detectRuns(source, ctx.config);
      const d = (p ? detections.find((x) => x.notRun === null && x.runner === p.runner) : null) ?? detections.find((x) => x.notRun === null) ?? detections[0] ?? null;
      const cwd = resolve(input.cwd, p?.cd ?? d?.cd ?? ".");
      const category = p?.category ?? d?.category ?? "test";
      const parsed = parseOutput(category, output, { exit: marker.exit, interrupted: input.interrupted });
      const extra = extraVerdict(ctx.config, p?.runner ?? d?.runner ?? "", output, marker.exit);
      const runnerName = p?.runner ?? d?.runner ?? "unknown";
      const via = /^(?:npm|pnpm|yarn|bun) /.test(runnerName) ? scriptVia(output) : undefined;
      const receipt = base(d, {
        id: marker.id,
        cwd,
        cmd: d?.segment.head ?? p?.command ?? input.command,
        source,
        runner: runnerName,
        ...(via ? { via } : {}),
        category,
        scope: p?.scope ?? d?.scope ?? "all",
        exit: marker.exit,
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
      out.push({ receipt, output });
    }
    return out;
  }

  const parsedCommand = parseCommand(input.command);
  const detections = detectRuns(input.command, ctx.config, parsedCommand).filter((d) => d.notRun === null);
  if (detections.length === 0) return [];
  const exitKnown = input.exit !== null && input.exit !== undefined;
  const analyses = detections.map((d) => maskingFor(parsedCommand, d));
  const chunks = attributeOutput(parsedCommand, detections, combined);
  const preliminary = detections.map((d) => parseOutput(d.category, chunks.get(d.segmentIndex) ?? combined, { exit: null, interrupted: input.interrupted }));
  const anyFail = preliminary.some((r) => r.verdict === "fail");
  const out: BuiltReceipt[] = [];
  detections.forEach((d, i) => {
    const analysis = analyses[i] as MaskAnalysis;
    if (analysis.background) return;
    let output = stripStatusEchoLines(chunks.get(d.segmentIndex) ?? combined, parsedCommand, analysis.pipelineEnd);
    let exit: number | null = null;
    let signalNote: string | null = null;
    if (exitKnown && analysis.exitPreserved) {
      if (input.exit === 0) exit = 0;
      else if (detections.length === 1) exit = input.exit;
      else if ((preliminary[i] as { verdict: RunVerdict }).verdict === "fail") exit = input.exit;
      else if (!anyFail && i === detections.length - 1) exit = input.exit;
      else signalNote = "compound-exit-unattributed";
    }
    let recovered: number | null = null;
    if (exit === null && !d.nested) {
      recovered = recoverExitFromEcho(parsedCommand, analysis.pipelineEnd, analysis.pipelineEnd > d.segmentIndex, combined);
      if (recovered !== null) exit = recovered;
    }
    // A run redirected to a file that the same command reads back with cat or tail is visible after all.
    const redirectTarget = analysis.reasons.map((r) => (r.startsWith("redirect:") ? r.slice(9) : null)).find((r): r is string => r !== null) ?? null;
    let readBack = false;
    if (redirectTarget) {
      for (let j = analysis.pipelineEnd + 1; j < parsedCommand.segments.length; j++) {
        const seg = parsedCommand.segments[j] as Segment;
        const w0 = seg.words[0] ?? "";
        if ((w0 === "cat" || w0 === "tail" || w0 === "less" || w0 === "more") && seg.words.includes(redirectTarget)) {
          readBack = true;
          output = combined;
          break;
        }
      }
    }
    // A head or tail shows everything when the output is shorter than its line count (blank lines count).
    const lines = countLines(output);
    const complete = (analysis.tailLines !== null && lines < analysis.tailLines) || (analysis.headLines !== null && lines < analysis.headLines);
    // A tail shorter than three lines can cut a multi-line summary; treat it like a filter, where one-line summaries still count.
    const shortTail = analysis.tailLines !== null && analysis.tailLines < 3 && !complete;
    const outputVisible = readBack || complete || (analysis.outputVisible && !shortTail);
    const filtered = (analysis.filtered || shortTail) && !complete && !readBack;
    const parsed = parseOutput(d.category, output, { exit, interrupted: input.interrupted, outputVisible, filtered });
    const extra = extraVerdict(ctx.config, d.runner, output, exit);
    let verdict = extra?.verdict ?? parsed.verdict;
    let signal = extra?.signal ?? parsed.signal;
    const errorSearch = analysis.filterPatterns.length > 0 ? analysis.filterPatterns.every((p) => !p.startsWith("!") && ERROR_PATTERN_RE.test(p)) : analysis.countOnly && d.category !== "build";
    if (verdict === "inconclusive" && exit === null && filtered && d.category !== "test" && errorSearch) {
      // The agent searched the output for error lines.
      if (analysis.countOnly) {
        const count = countedMatches(output, parsedCommand, analysis.pipelineEnd);
        if (count === 0) {
          verdict = "pass";
          signal = "count-zero";
        } else if (count !== null && count > 0) {
          verdict = "fail";
          signal = "count-nonzero";
        }
      } else if (isSilent(output)) {
        verdict = "pass";
        signal = "grep-empty";
      }
    }
    if (verdict === "inconclusive" && exit === null && (d.category === "typecheck" || d.category === "lint") && !hasFailSignal(d.category, combined)) {
      // A typecheck or lint tool prints its findings first, so a `head` of at least three lines would show
      // an error line, and an error search that found nothing means there was nothing to find.
      if (analysis.headLines !== null && analysis.headLines >= 3 && !analysis.filtered) {
        verdict = "pass";
        signal = "head-no-errors";
      } else if (analysis.filtered && errorSearch && !analysis.countOnly) {
        verdict = "pass";
        signal = "grep-no-errors";
      }
    }
    if (recovered !== null && verdict !== "inconclusive") signal = `${signal}+exit-from-echo`;
    if (signalNote && verdict === "inconclusive") signal = signalNote;
    const cwd = resolve(input.cwd, d.cd ?? ".");
    const via = /^(?:npm|pnpm|yarn|bun) /.test(d.runner) ? scriptVia(output) : undefined;
    const receipt = base(d, {
      cwd,
      exit,
      verdict,
      counts: parsed.counts,
      signal,
      masked: analysis.masked,
      ...(via ? { via } : {}),
      ...(analysis.reasons.length ? { maskReason: analysis.reasons.join(",") } : {}),
      ...(redirectTarget && verdict === "inconclusive" ? { logFile: resolve(cwd, redirectTarget) } : {}),
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

const LOG_READERS = new Set(["cat", "tail", "head", "less", "more", "grep", "egrep", "rg", "bat"]);

/**
 * When a verification run was redirected to a file and the agent later reads
 * that file, the read is the run's visible output. Returns a receipt derived
 * from the earlier one, or null when the command is not such a read.
 */
export function resolveLogRead(input: RunInput, ctx: ReceiptContext, receipts: Receipt[]): Receipt | null {
  const parsed = parseCommand(input.command);
  const seg = parsed.segments.find((s) => s.words.length > 0);
  if (!seg || parsed.segments.filter((s) => s.words.length > 0).length !== 1) return null;
  const words = seg.words;
  const cmd = (words[0] ?? "").replace(/^.*\//, "");
  if (!LOG_READERS.has(cmd)) return null;
  const files = words.slice(1).filter((w) => !w.startsWith("-") && !/^\+?\d+$/.test(w));
  const target = cmd === "grep" || cmd === "egrep" || cmd === "rg" ? files[files.length - 1] : files[0];
  if (!target) return null;
  const abs = resolve(input.cwd, target);
  const candidates = receipts.filter((r) => r.verdict === "inconclusive" && r.logFile !== undefined && r.logFile === abs);
  const original = candidates[candidates.length - 1];
  if (!original) return null;
  const output = `${input.stdout ?? ""}${input.stderr ? `\n${input.stderr}` : ""}`;
  const lines = countLines(output);
  let n: number | null = null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as string;
    const m = /^-n(\d+)$/.exec(w) ?? /^-(\d+)$/.exec(w) ?? /^--lines=(\d+)$/.exec(w);
    if (m) n = Number(m[1]);
    else if ((w === "-n" || w === "--lines") && words[i + 1]) n = Number(words[i + 1]) || null;
  }
  const complete = (cmd === "head" || cmd === "tail") && n !== null ? lines < n : cmd === "cat" || cmd === "less" || cmd === "more" || cmd === "bat";
  const outputVisible = complete || cmd === "cat" || cmd === "tail" || cmd === "less" || cmd === "more" || cmd === "bat";
  const filtered = cmd === "grep" || cmd === "egrep" || cmd === "rg" || (cmd === "head" && !complete);
  const parsedOut = parseOutput(original.category, output, { exit: null, outputVisible, filtered });
  if (parsedOut.verdict === "inconclusive") return null;
  return {
    ...original,
    id: "r-?",
    ts: ctx.now ?? new Date().toISOString(),
    source: input.command,
    verdict: parsedOut.verdict,
    counts: parsedOut.counts,
    signal: `log-read:${parsedOut.signal ?? "?"}`,
    maskReason: `${original.maskReason ?? "redirect"},read`,
    ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
  };
}

/** Builds and stores receipts, assigning ids and writing run logs. */
export function recordRun(input: RunInput, ctx: ReceiptContext): Receipt[] {
  const dir = sessionDir(ctx.root);
  ensureDir(dir);
  const pendingAll = readPending(ctx.root);
  const combined = `${input.stdout ?? ""}\n${input.stderr ?? ""}`;
  const markers = findMarkers(combined);
  const marker = markers[0] ?? null;
  let pending: PendingRun | null = null;
  if (marker) pending = pendingAll.find((p) => p.id === marker.id) ?? null;
  else if (input.toolUseId) pending = pendingAll.filter((p) => p.toolUseId === input.toolUseId).pop() ?? null;
  else pending = pendingAll.filter((p) => p.command === input.command && !p.wrappedCommand).pop() ?? null;
  const built = buildReceipts(input, ctx, pending, pendingAll);
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
