/**
 * `stalegreen history`: replays past sessions through the gate and lists the
 * claims whose evidence was stale, failed or masked.
 */

import { basename } from "node:path";
import { loadConfig, parseDuration } from "../core/config.js";
import type { VerdictKind } from "../core/grammar.js";
import { describeCounts } from "../core/receipts.js";
import type { ReplayVerdict, SessionReplay } from "../harness/replay.js";
import { harnessLabel, listSessionSources, replaySource, type HarnessChoice } from "./sessions.js";

export interface HistoryOptions {
  since: string;
  harness: HarnessChoice;
  includeNone: boolean;
  includeFresh: boolean;
  allMessages: boolean;
  json: boolean;
  limit: number;
  explain: boolean;
  session: string | null;
}

export const DEFAULT_HISTORY: HistoryOptions = { since: "30d", harness: "all", includeNone: false, includeFresh: false, allMessages: false, json: false, limit: 0, explain: false, session: null };

function clock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function short(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function formatHistoryVerdict(v: ReplayVerdict, explain: boolean, receipt?: { source: string; maskReason?: string; exit: number | null; signal: string | null }): string {
  const e = v.verdict.evidence;
  const evidence = e ? `${e.receipt} \`${short(e.cmd, 60)}\` ${e.verdict}${describeCounts(e.counts) ? ` (${describeCounts(e.counts)})` : ""}${e.masked ? ` masked${receipt?.maskReason ? `:${receipt.maskReason}` : ""}` : ""}` : "no run";
  const after = v.verdict.freshness.editsAfter;
  const edits = after.length > 0 ? ` +${after.length} edit${after.length === 1 ? "" : "s"}: ${after.slice(0, 3).map((x) => (x.path ? basename(x.path) : x.kind)).join(", ")}${after.length > 3 ? ", ..." : ""}` : "";
  const head = `${clock(v.ts)}  ${v.verdict.verdict.padEnd(7)} ${v.claim.category.padEnd(9)} "${short(v.claim.text, 48)}"  <-  ${evidence}${edits}`;
  if (!explain) return head;
  const lines = [head, `    ${v.harness} session ${v.session}${v.model ? `  model ${v.model}` : ""}  distance ${v.distance} messages`];
  if (e) lines.push(`    evidence ${clock(e.ts)}  scope ${e.scope}  exit ${receipt?.exit ?? "?"}  signal ${receipt?.signal ?? "?"}  in ${e.cwd}`);
  if (receipt && receipt.source !== e?.cmd) lines.push(`    command ${short(receipt.source.replace(/\s+/g, " "), 160)}`);
  if (v.verdict.note) lines.push(`    note ${v.verdict.note}`);
  lines.push(`    sentence ${short(v.claim.sentence.replace(/\s+/g, " "), 160)}`);
  return lines.join("\n");
}

export function selectVerdicts(replay: SessionReplay, opts: HistoryOptions): ReplayVerdict[] {
  const kinds = new Set<VerdictKind>(["STALE", "FAILED", "MASKED"]);
  if (opts.includeNone) kinds.add("NONE");
  if (opts.includeFresh) {
    kinds.add("FRESH");
    kinds.add("DEFERRED");
  }
  return replay.verdicts.filter((v) => kinds.has(v.verdict.verdict));
}

export async function runHistory(opts: HistoryOptions, log: (line: string) => void = console.log): Promise<number> {
  const ms = parseDuration(opts.since);
  if (ms === null) {
    log(`Invalid --since ${opts.since}; use a value like 30d, 12h or 45m.`);
    return 2;
  }
  const since = new Date(Date.now() - ms);
  let sources = await listSessionSources(opts.harness, since, opts.session);
  if (opts.limit > 0) sources = sources.slice(0, opts.limit);
  const config = loadConfig(process.cwd());
  const all: { v: ReplayVerdict; receipt?: { source: string; maskReason?: string; exit: number | null; signal: string | null } }[] = [];
  let sessions = 0;
  let sessionsWithClaims = 0;
  let claims = 0;
  const runs = { total: 0, masked: 0, maskedWithFailMarkers: 0, maskedInconclusive: 0 };
  const counts: Record<string, number> = {};
  const started = Date.now();
  const files = sources.reduce((n, s) => n + 1 + s.children.length, 0);
  for (const src of sources) {
    let replay: SessionReplay;
    try {
      replay = await replaySource(src, { config, allMessages: opts.allMessages });
    } catch {
      continue;
    }
    if (replay.toolCalls === 0) continue;
    sessions++;
    if (replay.claims > 0) sessionsWithClaims++;
    claims += replay.claims;
    runs.total += replay.runs.total;
    runs.masked += replay.runs.masked;
    runs.maskedWithFailMarkers += replay.runs.maskedWithFailMarkers;
    runs.maskedInconclusive += replay.runs.maskedInconclusive;
    for (const v of replay.verdicts) counts[v.verdict.verdict] = (counts[v.verdict.verdict] ?? 0) + 1;
    const byId = new Map(replay.receipts.map((r) => [r.id, r]));
    for (const v of selectVerdicts(replay, opts)) {
      const r = v.verdict.evidence ? byId.get(v.verdict.evidence.receipt) : undefined;
      all.push({ v, ...(r ? { receipt: { source: r.source, ...(r.maskReason ? { maskReason: r.maskReason } : {}), exit: r.exit, signal: r.signal } } : {}) });
    }
  }
  all.sort((a, b) => (a.v.ts < b.v.ts ? 1 : a.v.ts > b.v.ts ? -1 : 0));
  if (opts.json) {
    log(JSON.stringify({ since: opts.since, harness: opts.harness, sessions, sessionsWithClaims, claims, runs, counts, verdicts: all.map((x) => ({ ...x.v, receipt: x.receipt ?? null })) }, null, 2));
    return 0;
  }
  log(`stalegreen history: ${sessions} sessions with tool calls since ${opts.since} (${harnessLabel(opts.harness)}, ${files} files, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  log(`claims ${claims} in ${sessionsWithClaims} sessions`);
  log(`verification runs ${runs.total}: exit masked ${runs.masked}, of which hid a failure ${runs.maskedWithFailMarkers}, left no result ${runs.maskedInconclusive}`);
  log(`verdicts: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  log("");
  if (all.length === 0) {
    log(opts.includeNone ? "No stale, failed, masked or unbacked claims." : "No stale, failed or masked claims. Add --include-none to list claims with no run at all.");
    return 0;
  }
  for (const x of all) log(formatHistoryVerdict(x.v, opts.explain, x.receipt));
  return 0;
}
