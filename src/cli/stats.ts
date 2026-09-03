/**
 * `stalegreen stats`: rates over past sessions. How often a green claim was
 * stale, failed, masked or unbacked, and how often a verification run hid its
 * exit status, per model and per session kind.
 *
 * Sessions with no tool calls are excluded, and a status line the agent
 * repeats word for word within one session is counted once per verdict.
 */

import { basename } from "node:path";
import { loadConfig, parseDuration } from "../core/config.js";
import type { VerdictKind } from "../core/grammar.js";
import { claudeTranscriptFiles, replayClaudeSession, type ReplayVerdict, type SessionReplay } from "../harness/claude/transcript.js";

export interface StatsOptions {
  since: string;
  harness: "claude";
  json: boolean;
  allMessages: boolean;
  limit: number;
}

export const DEFAULT_STATS: StatsOptions = { since: "90d", harness: "claude", json: false, allMessages: false, limit: 0 };

export interface ClaimTally {
  counted: number;
  repeated: number;
  fresh: number;
  stale: number;
  failed: number;
  masked: number;
  none: number;
  deferred: number;
}

export interface RunTally {
  total: number;
  hidden: number;
  hidFailure: number;
  noResult: number;
}

export interface StatsBucket {
  sessions: number;
  sessionsWithClaims: number;
  claims: ClaimTally;
  runs: RunTally;
}

export interface StatsReport {
  since: string;
  harness: string;
  files: number;
  seconds: number;
  sessions: number;
  sessionsWithClaims: number;
  claims: ClaimTally;
  runs: RunTally;
  rates: { stale: number | null; failed: number | null; masked: number | null; none: number | null; hiddenExit: number | null; hidFailure: number | null };
  byModel: Record<string, StatsBucket>;
  bySessionKind: Record<string, StatsBucket>;
}

export type SessionKind = "interactive" | "sdk" | "unknown";

export function sessionKind(entrypoint: string | null): SessionKind {
  if (!entrypoint) return "unknown";
  if (entrypoint === "cli") return "interactive";
  if (/^sdk/i.test(entrypoint)) return "sdk";
  return "unknown";
}

function emptyClaims(): ClaimTally {
  return { counted: 0, repeated: 0, fresh: 0, stale: 0, failed: 0, masked: 0, none: 0, deferred: 0 };
}

function emptyRuns(): RunTally {
  return { total: 0, hidden: 0, hidFailure: 0, noResult: 0 };
}

function emptyBucket(): StatsBucket {
  return { sessions: 0, sessionsWithClaims: 0, claims: emptyClaims(), runs: emptyRuns() };
}

const KIND_FIELD: Record<VerdictKind, keyof ClaimTally> = { FRESH: "fresh", STALE: "stale", FAILED: "failed", MASKED: "masked", NONE: "none", DEFERRED: "deferred" };

/** A claim is counted once per session, category, sentence and verdict; repeats are boilerplate. */
export function dedupeStatusLines(verdicts: ReplayVerdict[]): { counted: ReplayVerdict[]; repeated: number } {
  const seen = new Set<string>();
  const counted: ReplayVerdict[] = [];
  let repeated = 0;
  for (const v of verdicts) {
    const key = `${v.claim.category}|${v.verdict.verdict}|${v.claim.sentence.replace(/\s+/g, " ").trim().toLowerCase()}`;
    if (seen.has(key)) {
      repeated++;
      continue;
    }
    seen.add(key);
    counted.push(v);
  }
  return { counted, repeated };
}

function addClaims(into: ClaimTally, counted: ReplayVerdict[], repeated: number): void {
  into.counted += counted.length;
  into.repeated += repeated;
  for (const v of counted) into[KIND_FIELD[v.verdict.verdict]]++;
}

function addRuns(into: RunTally, r: { total: number; masked: number; maskedWithFailMarkers: number; maskedInconclusive: number }): void {
  into.total += r.total;
  into.hidden += r.masked;
  into.hidFailure += r.maskedWithFailMarkers;
  into.noResult += r.maskedInconclusive;
}

/** Folds one replayed session into a report. Exported for tests. */
export function foldSession(report: StatsReport, replay: SessionReplay): void {
  if (replay.toolCalls === 0) return;
  report.sessions++;
  const { counted, repeated } = dedupeStatusLines(replay.verdicts);
  if (counted.length > 0) report.sessionsWithClaims++;
  addClaims(report.claims, counted, repeated);
  addRuns(report.runs, replay.runs);

  const kind = (report.bySessionKind[sessionKind(replay.entrypoint)] ??= emptyBucket());
  kind.sessions++;
  if (counted.length > 0) kind.sessionsWithClaims++;
  addClaims(kind.claims, counted, repeated);
  addRuns(kind.runs, replay.runs);

  // Only models that issued a verification run or made a claim get a row; placeholder
  // models such as <synthetic> never do.
  const models = new Set<string>([...Object.keys(replay.runs.byModel), ...counted.map((v) => v.model ?? "unknown")]);
  for (const model of models) {
    if (model.startsWith("<")) continue;
    const bucket = (report.byModel[model] ??= emptyBucket());
    bucket.sessions++;
    const own = counted.filter((v) => (v.model ?? "unknown") === model);
    if (own.length > 0) bucket.sessionsWithClaims++;
    addClaims(bucket.claims, own, 0);
    const runs = replay.runs.byModel[model];
    if (runs) addRuns(bucket.runs, runs);
  }
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

export function finishReport(report: StatsReport): StatsReport {
  const c = report.claims;
  const r = report.runs;
  report.rates = {
    stale: ratio(c.stale, c.counted),
    failed: ratio(c.failed, c.counted),
    masked: ratio(c.masked, c.counted),
    none: ratio(c.none, c.counted),
    hiddenExit: ratio(r.hidden, r.total),
    hidFailure: ratio(r.hidFailure, r.total),
  };
  return report;
}

export function emptyReport(since: string, harness: string): StatsReport {
  return { since, harness, files: 0, seconds: 0, sessions: 0, sessionsWithClaims: 0, claims: emptyClaims(), runs: emptyRuns(), rates: { stale: null, failed: null, masked: null, none: null, hiddenExit: null, hidFailure: null }, byModel: {}, bySessionKind: {} };
}

function pct(part: number, whole: number): string {
  if (whole === 0) return "   -";
  return `${Math.round((part / whole) * 100)}%`.padStart(4);
}

function num(n: number, width = 7): string {
  return n.toLocaleString("en-US").padStart(width);
}

function shortModel(name: string): string {
  return name.length > 28 ? `${name.slice(0, 27)}…` : name;
}

export function formatStats(report: StatsReport): string[] {
  const c = report.claims;
  const r = report.runs;
  const lines: string[] = [];
  lines.push(`stalegreen stats: ${report.sessions.toLocaleString("en-US")} sessions with tool calls in the last ${report.since} (${report.harness === "claude" ? "Claude Code" : report.harness}, ${report.files} files, ${report.seconds.toFixed(1)}s)`);
  lines.push("");
  lines.push(`Green claims ${num(c.counted)}   in ${report.sessionsWithClaims} sessions${c.repeated > 0 ? `, ${c.repeated} repeated status lines counted once` : ""}`);
  lines.push(`  fresh      ${num(c.fresh)}  ${pct(c.fresh, c.counted)}   a passing run and no edits since`);
  lines.push(`  stale      ${num(c.stale)}  ${pct(c.stale, c.counted)}   a passing run, then edits, no rerun`);
  lines.push(`  failed     ${num(c.failed)}  ${pct(c.failed, c.counted)}   the last matching run failed`);
  lines.push(`  masked     ${num(c.masked)}  ${pct(c.masked, c.counted)}   the exit status was hidden and nothing readable was left`);
  lines.push(`  no run     ${num(c.none)}  ${pct(c.none, c.counted)}   nothing matching ran in the session`);
  if (c.deferred > 0) lines.push(`  deferred   ${num(c.deferred)}  ${pct(c.deferred, c.counted)}   a background run was still in flight`);
  lines.push("");
  lines.push(`Verification runs ${num(r.total)}`);
  lines.push(`  exit hidden     ${num(r.hidden)}  ${pct(r.hidden, r.total)}   piped, redirected, chained or sent to /dev/null`);
  lines.push(`  hid a failure   ${num(r.hidFailure)}  ${pct(r.hidFailure, r.total)}   exit hidden, failure marker in the visible output`);
  lines.push(`  no result       ${num(r.noResult)}  ${pct(r.noResult, r.total)}   exit hidden and no summary line either`);
  const models = Object.entries(report.byModel).sort((a, b) => b[1].claims.counted - a[1].claims.counted || b[1].runs.total - a[1].runs.total);
  if (models.length > 0) {
    lines.push("");
    lines.push(`${"By model".padEnd(30)} ${"claims".padStart(7)} ${"stale".padStart(6)} ${"failed".padStart(6)} ${"masked".padStart(6)} ${"no run".padStart(6)} ${"runs".padStart(8)} ${"hidden".padStart(6)}`);
    for (const [model, b] of models) {
      lines.push(`  ${shortModel(model).padEnd(28)} ${num(b.claims.counted)} ${pct(b.claims.stale, b.claims.counted).padStart(6)} ${pct(b.claims.failed, b.claims.counted).padStart(6)} ${pct(b.claims.masked, b.claims.counted).padStart(6)} ${pct(b.claims.none, b.claims.counted).padStart(6)} ${num(b.runs.total, 8)} ${pct(b.runs.hidden, b.runs.total).padStart(6)}`);
    }
  }
  const kinds = Object.entries(report.bySessionKind).sort((a, b) => b[1].sessions - a[1].sessions);
  if (kinds.length > 1) {
    lines.push("");
    lines.push(`${"By session kind".padEnd(30)} ${"sessions".padStart(8)} ${"claims".padStart(7)} ${"stale".padStart(6)} ${"runs".padStart(8)} ${"hidden".padStart(6)}`);
    for (const [kind, b] of kinds) {
      lines.push(`  ${kind.padEnd(28)} ${num(b.sessions, 8)} ${num(b.claims.counted)} ${pct(b.claims.stale, b.claims.counted).padStart(6)} ${num(b.runs.total, 8)} ${pct(b.runs.hidden, b.runs.total).padStart(6)}`);
    }
  }
  lines.push("");
  if (c.counted === 0 && r.total === 0) {
    lines.push("No green claims and no verification runs in this window.");
  } else {
    const stale = c.counted > 0 ? `${Math.round((c.stale / c.counted) * 100)}% of green claims were stale (${c.stale} of ${c.counted})` : "no green claims";
    const hidden = r.total > 0 ? `${Math.round((r.hidden / r.total) * 100)}% of verification runs hid their exit status (${r.hidden} of ${r.total})` : "no verification runs";
    lines.push(`${stale}; ${hidden}.`);
  }
  return lines;
}

export async function runStats(opts: StatsOptions, log: (line: string) => void = console.log): Promise<number> {
  const ms = parseDuration(opts.since);
  if (ms === null) {
    log(`Invalid --since ${opts.since}; use a value like 90d, 12h or 45m.`);
    return 2;
  }
  const since = new Date(Date.now() - ms);
  let files = claudeTranscriptFiles(undefined, since);
  if (opts.limit > 0) files = files.slice(0, opts.limit);
  const config = loadConfig(process.cwd());
  const report = emptyReport(opts.since, opts.harness);
  report.files = files.length;
  const started = Date.now();
  for (const f of files) {
    let replay: SessionReplay;
    try {
      replay = await replayClaudeSession(f.file, { config, allMessages: opts.allMessages });
    } catch {
      continue;
    }
    if (basename(f.file, ".jsonl").length === 0) continue;
    foldSession(report, replay);
  }
  report.seconds = (Date.now() - started) / 1000;
  finishReport(report);
  if (opts.json) {
    log(JSON.stringify(report, null, 2));
    return 0;
  }
  for (const line of formatStats(report)) log(line);
  return 0;
}
