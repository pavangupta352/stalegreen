/**
 * Claude Code transcript reader for `history` and `stats`.
 *
 * Reads `~/.claude/projects/<slug>/<session>.jsonl` (and the session's
 * subagent files) as a stream, rebuilds the verification runs, edit events
 * and final messages, and replays the freshness gate over them. Live hooks
 * never use this; the transcript can lag the conversation.
 */

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { dedupeClaims, extractClaims } from "../../core/claims.js";
import { DEFAULT_CONFIG, type Config } from "../../core/config.js";
import { editFromTool, editsFromBash, toEditEvent } from "../../core/edits.js";
import { evaluate } from "../../core/freshness.js";
import type { Category, Claim, EditEvent, Fingerprint, Receipt, Verdict } from "../../core/grammar.js";
import { buildReceipts, resolveLogRead, type ReceiptContext } from "../../core/receipts.js";

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

type Scope = "main" | "sub";

interface TextEvent {
  kind: "text";
  ts: string;
  seq: number;
  text: string;
  final: boolean;
  scope: Scope;
  model: string | null;
}
interface RunEvent {
  kind: "run";
  ts: string;
  seq: number;
  command: string;
  output: string;
  exit: number | null;
  interrupted: boolean;
  background: boolean;
  cwd: string;
  scope: Scope;
  toolUseId: string;
  agent: string | null;
  model: string | null;
}
interface EditEventRaw {
  kind: "edit";
  ts: string;
  seq: number;
  path: string | null;
  edit: string;
  scope: Scope;
  agent: string | null;
}
type Event = TextEvent | RunEvent | EditEventRaw;

interface JsonRecord {
  type?: string;
  timestamp?: string;
  entrypoint?: string;
  cwd?: string;
  message?: { id?: string; model?: string; role?: string; content?: unknown };
  toolUseResult?: unknown;
}

const INTERESTING = /"type":"(?:assistant|user)"/;
const TEXT_CAP = 32 * 1024;

/** `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects` when Claude Code is configured elsewhere. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env.CLAUDE_CONFIG_DIR;
  return join(configDir && configDir.trim() ? configDir : join(homedir(), ".claude"), "projects");
}

/** Top-level session files, newest first, optionally only those touched since `since`. */
export function claudeTranscriptFiles(root = claudeProjectsDir(), since?: Date): { file: string; mtime: number; size: number }[] {
  if (!existsSync(root)) return [];
  const out: { file: string; mtime: number; size: number }[] = [];
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      try {
        const st = statSync(file);
        if (!st.isFile()) continue;
        if (since && st.mtimeMs < since.getTime()) continue;
        out.push({ file, mtime: st.mtimeMs, size: st.size });
      } catch {
        // ignore
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Subagent transcripts that belong to a session file. */
export function subagentFilesFor(file: string): string[] {
  const dir = join(dirname(file), basename(file, ".jsonl"), "subagents");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(d, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p, depth + 1);
        else if (name.endsWith(".jsonl")) out.push(p);
      } catch {
        // ignore
      }
    }
  };
  walk(dir, 0);
  return out.sort();
}

async function* records(file: string): AsyncGenerator<{ record: JsonRecord; bad: boolean }> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || !INTERESTING.test(line)) continue;
    try {
      yield { record: JSON.parse(line) as JsonRecord, bad: false };
    } catch {
      yield { record: {}, bad: true };
    }
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("");
  return "";
}

function clipOutput(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max / 4);
  return `${s.slice(0, head)}\n[stalegreen] replay clipped ${s.length - max} characters\n${s.slice(s.length - (max - head))}`;
}

function persistedOutput(tur: Record<string, unknown>, max: number): string | null {
  const p = tur.persistedOutputPath;
  if (typeof p !== "string" || !existsSync(p)) return null;
  try {
    if (statSync(p).size > max * 4) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Reads one transcript file into timeline events. */
export async function readClaudeEvents(file: string, scope: Scope, opts: ReplayOptions, meta: { entrypoint: string | null; cwd?: string | null; models: Record<string, number>; assistantMessages: number; toolCalls: number; badLines: number; firstTs: string | null; lastTs: string | null }): Promise<Event[]> {
  const events: Event[] = [];
  const pending = new Map<string, { name: string; input: Record<string, unknown>; ts: string; model: string | null }>();
  const toolMessageIds = new Set<string>();
  const seenMessageIds = new Set<string>();
  const maxOutput = opts.maxOutputBytes ?? 256 * 1024;
  const agent = scope === "sub" ? basename(file, ".jsonl") : null;
  let seq = 0;
  for await (const { record, bad } of records(file)) {
    seq++;
    if (bad) {
      meta.badLines++;
      continue;
    }
    const ts = typeof record.timestamp === "string" ? record.timestamp : "";
    if (ts) {
      if (!meta.firstTs || ts < meta.firstTs) meta.firstTs = ts;
      if (!meta.lastTs || ts > meta.lastTs) meta.lastTs = ts;
    }
    if (typeof record.entrypoint === "string" && !meta.entrypoint) meta.entrypoint = record.entrypoint;
    if (typeof record.cwd === "string" && scope === "main" && !meta.cwd) meta.cwd = record.cwd;
    const msg = record.message ?? {};
    const content = msg.content;
    if (record.type === "assistant" && Array.isArray(content)) {
      const id = typeof msg.id === "string" ? msg.id : `seq-${seq}`;
      if (scope === "main" && !seenMessageIds.has(id)) {
        seenMessageIds.add(id);
        meta.assistantMessages++;
        if (typeof msg.model === "string") meta.models[msg.model] = (meta.models[msg.model] ?? 0) + 1;
      }
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          events.push({ kind: "text", ts, seq, text: b.text.length > TEXT_CAP ? b.text.slice(0, TEXT_CAP) : b.text, final: false, scope, model: typeof msg.model === "string" ? msg.model : null });
          (events[events.length - 1] as TextEvent & { msgId?: string }).msgId = id;
        } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          meta.toolCalls++;
          toolMessageIds.add(id);
          const input = b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
          pending.set(b.id, { name: b.name, input, ts, model: typeof msg.model === "string" ? msg.model : null });
          const edit = editFromTool(b.name, input);
          if (edit) events.push({ kind: "edit", ts, seq, path: edit.path, edit: edit.kind, scope, agent });
          // Bash edits are recorded when the result arrives, so git operations can be judged by their output.
        }
      }
    } else if (record.type === "user" && Array.isArray(content)) {
      const tur = record.toolUseResult && typeof record.toolUseResult === "object" ? (record.toolUseResult as Record<string, unknown>) : null;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const call = pending.get(b.tool_use_id);
        if (!call || call.name !== "Bash") continue;
        const command = typeof call.input.command === "string" ? call.input.command : "";
        if (!command) continue;
        const text = contentText(b.content);
        let exit: number | null = 0;
        if (b.is_error) {
          const m = /^\s*Exit code:?\s*(-?\d+)/.exec(text);
          if (!m) continue; // a harness error such as a denied permission or a timeout, not an execution
          exit = Number(m[1]);
        }
        const background = call.input.run_in_background === true || (tur !== null && typeof tur.backgroundTaskId === "string") || /^Command running in background/.test(text);
        const interrupted = tur !== null && tur.interrupted === true;
        let output = text;
        if (tur) {
          const persisted = persistedOutput(tur, maxOutput);
          if (persisted !== null) output = persisted;
          else if (typeof tur.stdout === "string" || typeof tur.stderr === "string") output = `${typeof tur.stdout === "string" ? tur.stdout : ""}\n${typeof tur.stderr === "string" ? tur.stderr : ""}`;
        }
        const cwd = typeof record.cwd === "string" ? record.cwd : "";
        events.push({ kind: "run", ts, seq, command, output: clipOutput(output, maxOutput), exit, interrupted, background, cwd, scope, toolUseId: b.tool_use_id, agent, model: call.model });
        for (const e of editsFromBash(command, output)) events.push({ kind: "edit", ts, seq, path: e.path, edit: e.kind, scope, agent });
      }
    }
  }
  // A text block is turn-ending when its API response carried no tool call.
  for (const e of events) {
    if (e.kind !== "text") continue;
    const msgId = (e as TextEvent & { msgId?: string }).msgId ?? "";
    e.final = !toolMessageIds.has(msgId);
  }
  return events;
}

const unavailable: Fingerprint = { head: null, tree: null, available: false, reason: "replay" };

function byTime(a: Event, b: Event): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.seq - b.seq;
}

/** Replays one session (with its subagents) through the receipt builder and the gate. */
export async function replayClaudeSession(file: string, opts: ReplayOptions = {}): Promise<SessionReplay> {
  const config = opts.config ?? DEFAULT_CONFIG;
  const meta = { entrypoint: null as string | null, cwd: null as string | null, models: {} as Record<string, number>, assistantMessages: 0, toolCalls: 0, badLines: 0, firstTs: null as string | null, lastTs: null as string | null };
  const session = basename(file, ".jsonl");
  let events = await readClaudeEvents(file, "main", opts, meta);
  const subs = opts.includeSubagents === false ? [] : subagentFilesFor(file);
  for (const sub of subs) {
    const subMeta = { ...meta, models: {}, assistantMessages: 0, toolCalls: 0, badLines: 0 };
    try {
      events = events.concat(await readClaudeEvents(sub, "sub", opts, subMeta));
      meta.toolCalls += subMeta.toolCalls;
      meta.badLines += subMeta.badLines;
    } catch {
      meta.badLines++;
    }
  }
  events.sort(byTime);

  const receipts: Receipt[] = [];
  const edits: EditEvent[] = [];
  const verdicts: ReplayVerdict[] = [];
  const runs: RunStats = { total: 0, masked: 0, maskedWithFailMarkers: 0, maskedInconclusive: 0, failed: 0, passed: 0, inconclusive: 0, background: 0, byCategory: { test: 0, typecheck: 0, lint: 0, build: 0 }, byModel: {} };
  let claims = 0;
  let seqId = 0;
  let mainTexts = 0;
  const lastEvidenceIndex = new Map<string, number>();
  const ctx: ReceiptContext = { harness: "claude", root: session, agent: null, config, fingerprintFor: () => unavailable };

  for (const e of events) {
    if (e.kind === "edit") {
      edits.push(toEditEvent({ path: e.path, kind: e.edit }, e.ts, e.agent));
      continue;
    }
    if (e.kind === "run") {
      if (e.background) {
        runs.background++;
        continue;
      }
      const runInput = { command: e.command, stdout: e.output, stderr: "", exit: e.exit, interrupted: e.interrupted, cwd: e.cwd || "/", toolUseId: e.toolUseId };
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
      verdicts.push({ file, session, ts: e.ts, model: e.model, claim, verdict: v, distance: Math.max(0, mainTexts - evidenceIdx - 1) });
    }
  }
  return { file, session, entrypoint: meta.entrypoint, models: meta.models, assistantMessages: meta.assistantMessages, toolCalls: meta.toolCalls, subagentFiles: subs.length, receipts, edits, verdicts, claims, runs, badLines: meta.badLines, firstTs: meta.firstTs, lastTs: meta.lastTs };
}
