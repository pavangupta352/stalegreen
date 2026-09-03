/**
 * Replays a session's events (assistant text, shell runs, file edits) through
 * the receipt builder and the freshness gate. The harness readers produce
 * the events; this module is the same for all of them.
 */

import { dedupeClaims, extractClaims } from "../core/claims.js";
import { DEFAULT_CONFIG, type Config } from "../core/config.js";
import { evaluate } from "../core/freshness.js";
import type { Category, Claim, EditEvent, Fingerprint, Harness, Receipt, Verdict } from "../core/grammar.js";
import { buildReceipts, resolveLogRead, type ReceiptContext } from "../core/receipts.js";

export interface ReplayOptions {
  includeSubagents?: boolean;
  /** Evaluate every assistant text block, not only turn-ending ones. */
  allMessages?: boolean;
  config?: Config;
  /** Bytes of a run's output kept for parsing. */
  maxOutputBytes?: number;
}

export interface ReplayVerdict {
  file: string;
  session: string;
  harness: Harness;
  ts: string;
  model: string | null;
  claim: Claim;
  verdict: Verdict;
  /** Assistant messages between the evidence and the claim. */
  distance: number;
}

export interface RunStats {
  total: number;
  masked: number;
  /** Masked runs whose visible output still carried a failure marker. */
  maskedWithFailMarkers: number;
  /** Masked runs that left no usable result at all. */
  maskedInconclusive: number;
  failed: number;
  passed: number;
  inconclusive: number;
  background: number;
  byCategory: Record<Category, number>;
  /** The same tallies per model, keyed by the model that issued the command. */
  byModel: Record<string, { total: number; masked: number; maskedWithFailMarkers: number; maskedInconclusive: number }>;
}

export interface SessionReplay {
  file: string;
  session: string;
  harness: Harness;
  /** `cli` for an interactive session, `sdk-*` or `exec` for an automated one, null when unknown. */
  entrypoint: string | null;
  models: Record<string, number>;
  assistantMessages: number;
  toolCalls: number;
  subagentFiles: number;
  receipts: Receipt[];
  edits: EditEvent[];
  verdicts: ReplayVerdict[];
  claims: number;
  runs: RunStats;
  badLines: number;
  firstTs: string | null;
  lastTs: string | null;
}

export type Scope = "main" | "sub";

export interface TextEvent {
  kind: "text";
  ts: string;
  seq: number;
  text: string;
  final: boolean;
  scope: Scope;
  model: string | null;
}
export interface RunEvent {
  kind: "run";
  ts: string;
  seq: number;
  command: string;
  output: string;
  exit: number | null;
  /** The harness reported a failure without a number. */
  exitFailed?: boolean;
  interrupted: boolean;
  background: boolean;
  cwd: string;
  scope: Scope;
  toolUseId: string;
  agent: string | null;
  model: string | null;
}
export interface EditEventRaw {
  kind: "edit";
  ts: string;
  seq: number;
  path: string | null;
  edit: string;
  scope: Scope;
  agent: string | null;
}
export type ReplayEvent = TextEvent | RunEvent | EditEventRaw;

/** What a reader learns about a session besides its events. */
export interface SessionMeta {
  entrypoint: string | null;
  cwd: string | null;
  models: Record<string, number>;
  assistantMessages: number;
  toolCalls: number;
  badLines: number;
  firstTs: string | null;
  lastTs: string | null;
}

export function emptyMeta(): SessionMeta {
  return { entrypoint: null, cwd: null, models: {}, assistantMessages: 0, toolCalls: 0, badLines: 0, firstTs: null, lastTs: null };
}

export function noteTimestamp(meta: SessionMeta, ts: string): void {
  if (!ts) return;
  if (!meta.firstTs || ts < meta.firstTs) meta.firstTs = ts;
  if (!meta.lastTs || ts > meta.lastTs) meta.lastTs = ts;
}

export const TEXT_CAP = 32 * 1024;

export function clipOutput(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max / 4);
  return `${s.slice(0, head)}\n[stalegreen] replay clipped ${s.length - max} characters\n${s.slice(s.length - (max - head))}`;
}

const unavailable: Fingerprint = { head: null, tree: null, available: false, reason: "replay" };

export function byTime(a: ReplayEvent, b: ReplayEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.seq - b.seq;
}

/** Runs the events of one session through receipts, edits and the gate. Events must be sorted. */
export function replayEvents(harness: Harness, file: string, session: string, events: ReplayEvent[], meta: SessionMeta, subagentFiles: number, opts: ReplayOptions = {}): SessionReplay {
  const config = opts.config ?? DEFAULT_CONFIG;
  const receipts: Receipt[] = [];
  const edits: EditEvent[] = [];
  const verdicts: ReplayVerdict[] = [];
  const runs: RunStats = { total: 0, masked: 0, maskedWithFailMarkers: 0, maskedInconclusive: 0, failed: 0, passed: 0, inconclusive: 0, background: 0, byCategory: { test: 0, typecheck: 0, lint: 0, build: 0 }, byModel: {} };
  let claims = 0;
  let seqId = 0;
  let mainTexts = 0;
  const lastEvidenceIndex = new Map<string, number>();
  const ctx: ReceiptContext = { harness, root: session, agent: null, config, fingerprintFor: () => unavailable };

  for (const e of events) {
    if (e.kind === "edit") {
      const ev: EditEvent = { ts: e.ts, path: e.path, kind: e.edit };
      if (e.agent) ev.agent = e.agent;
      edits.push(ev);
      continue;
    }
    if (e.kind === "run") {
      if (e.background) {
        runs.background++;
        continue;
      }
      const runInput = { command: e.command, stdout: e.output, stderr: "", exit: e.exit, ...(e.exitFailed ? { exitFailed: true } : {}), interrupted: e.interrupted, cwd: e.cwd || "/", toolUseId: e.toolUseId };
      const built = buildReceipts(runInput, { ...ctx, agent: e.agent, now: e.ts }, null, []);
      if (built.length === 0) {
        const read = resolveLogRead(runInput, { ...ctx, agent: e.agent, now: e.ts }, receipts);
        if (read) built.push({ receipt: read, output: e.output });
      }
      for (const b of built) {
        const r = b.receipt;
        r.id = `r-${String(++seqId).padStart(4, "0")}`;
        r.ts = e.ts;
        receipts.push(r);
        runs.total++;
        runs.byCategory[r.category]++;
        if (r.masked) runs.masked++;
        if (r.masked && r.verdict === "fail" && r.exit === null) runs.maskedWithFailMarkers++;
        if (r.masked && r.verdict === "inconclusive") runs.maskedInconclusive++;
        const perModel = (runs.byModel[e.model ?? "unknown"] ??= { total: 0, masked: 0, maskedWithFailMarkers: 0, maskedInconclusive: 0 });
        perModel.total++;
        if (r.masked) perModel.masked++;
        if (r.masked && r.verdict === "fail" && r.exit === null) perModel.maskedWithFailMarkers++;
        if (r.masked && r.verdict === "inconclusive") perModel.maskedInconclusive++;
        if (r.verdict === "fail") runs.failed++;
        else if (r.verdict === "pass") runs.passed++;
        else runs.inconclusive++;
        lastEvidenceIndex.set(r.id, mainTexts);
      }
      continue;
    }
    if (e.scope !== "main") continue;
    mainTexts++;
    if (!e.final && !opts.allMessages) continue;
    const found = dedupeClaims(extractClaims(e.text));
    if (found.length === 0) continue;
    claims += found.length;
    const result = evaluate({ claims: found, receipts, edits, deferred: [], now: e.ts, cwd: meta.cwd ?? "/", config, fingerprintFor: () => unavailable, blockedThisTurn: new Set() });
    for (let i = 0; i < result.length; i++) {
      const v = result[i] as Verdict;
      const claim = found[i] as Claim;
      const evidenceIdx = v.evidence ? (lastEvidenceIndex.get(v.evidence.receipt) ?? mainTexts) : mainTexts;
      verdicts.push({ file, session, harness, ts: e.ts, model: e.model, claim, verdict: v, distance: Math.max(0, mainTexts - evidenceIdx - 1) });
    }
  }
  return { file, session, harness, entrypoint: meta.entrypoint, models: meta.models, assistantMessages: meta.assistantMessages, toolCalls: meta.toolCalls, subagentFiles, receipts, edits, verdicts, claims, runs, badLines: meta.badLines, firstTs: meta.firstTs, lastTs: meta.lastTs };
}
