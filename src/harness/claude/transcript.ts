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
import { editFromTool, editsFromBash } from "../../core/edits.js";
import { byTime, clipOutput, emptyMeta, noteTimestamp, replayEvents, TEXT_CAP, type ReplayEvent, type ReplayOptions, type Scope, type SessionMeta, type SessionReplay, type TextEvent } from "../replay.js";

export type { ReplayOptions, ReplayVerdict, RunStats, SessionReplay } from "../replay.js";

interface JsonRecord {
  type?: string;
  timestamp?: string;
  entrypoint?: string;
  cwd?: string;
  message?: { id?: string; model?: string; role?: string; content?: unknown };
  toolUseResult?: unknown;
}

const INTERESTING = /"type":"(?:assistant|user)"/;

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

export async function readClaudeEvents(file: string, scope: Scope, opts: ReplayOptions, meta: SessionMeta): Promise<ReplayEvent[]> {
  const events: ReplayEvent[] = [];
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
    noteTimestamp(meta, ts);
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

/** Replays one session (with its subagents) through the receipt builder and the gate. */
export async function replayClaudeSession(file: string, opts: ReplayOptions = {}): Promise<SessionReplay> {
  const meta = emptyMeta();
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
  return replayEvents("claude", file, session, events, meta, subs.length, opts);
}
