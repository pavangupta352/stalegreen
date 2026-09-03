/**
 * Codex rollout reader for `history` and `stats`.
 *
 * Reads `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` as a stream. Each line
 * is `{timestamp, type, payload}`:
 *
 * - `session_meta` carries the thread id, `cwd`, `thread_source` and, for a
 *   subagent thread, `parent_thread_id`; child threads are merged into the
 *   parent's timeline the way Claude Code subagent files are.
 * - `turn_context` carries the `model` for the turn.
 * - `response_item` with `payload.type` `message` (role assistant, `phase`
 *   `final_answer` for the turn-ending message), `custom_tool_call` named
 *   `exec` (the shell script in `input`), `custom_tool_call_output` (joined
 *   by `call_id`; the output starts with `Script completed`, `Script failed`
 *   or `Script running with cell ID N`), and `function_call` named `wait`
 *   whose output finishes a running cell.
 * - `event_msg` with `payload.type` `patch_apply_end` is the only record of
 *   file edits; `task_complete` and `user_message` end a turn.
 */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { editsFromBash } from "../../core/edits.js";
import { byTime, clipOutput, emptyMeta, noteTimestamp, replayEvents, TEXT_CAP, type ReplayEvent, type ReplayOptions, type Scope, type SessionMeta, type SessionReplay } from "../replay.js";
import { exitFromCellOutput, extractExecCommands, parseCodexExecOutput } from "./output.js";

interface Line {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

export interface CodexSessionInfo {
  file: string;
  id: string | null;
  parent: string | null;
  cwd: string | null;
  threadSource: string | null;
  source: string | null;
  mtime: number;
  size: number;
}

/** `~/.codex/sessions`, or `$CODEX_HOME/sessions` when Codex keeps its state elsewhere. */
export function codexSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME;
  return join(home && home.trim() ? home : join(homedir(), ".codex"), "sessions");
}

/** Rollout files, newest first, optionally only those touched since `since`. */
export function codexTranscriptFiles(root = codexSessionsDir(), since?: Date): { file: string; mtime: number; size: number }[] {
  if (!existsSync(root)) return [];
  const out: { file: string; mtime: number; size: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) walk(p, depth + 1);
        else if (name.endsWith(".jsonl")) {
          if (since && st.mtimeMs < since.getTime()) continue;
          out.push({ file: p, mtime: st.mtimeMs, size: st.size });
        }
      } catch {
        // ignore
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

async function* lines(file: string): AsyncGenerator<{ line: Line; bad: boolean }> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw) continue;
    try {
      yield { line: JSON.parse(raw) as Line, bad: false };
    } catch {
      yield { line: {}, bad: true };
    }
  }
}

function s(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Reads a rollout's first record, enough to know its id, its parent and where it ran. */
export async function codexSessionInfo(entry: { file: string; mtime: number; size: number }): Promise<CodexSessionInfo> {
  const info: CodexSessionInfo = { file: entry.file, id: null, parent: null, cwd: null, threadSource: null, source: null, mtime: entry.mtime, size: entry.size };
  for await (const { line } of lines(entry.file)) {
    if (line.type !== "session_meta") continue;
    const p = line.payload ?? {};
    info.id = s(p.id) ?? s(p.session_id);
    info.parent = s(p.parent_thread_id);
    info.cwd = s(p.cwd);
    info.threadSource = s(p.thread_source);
    info.source = typeof p.source === "string" ? p.source : p.source && typeof p.source === "object" ? Object.keys(p.source as object)[0] ?? null : null;
    break;
  }
  if (!info.id) info.id = basename(entry.file, ".jsonl");
  return info;
}

/** Groups rollouts into root threads with their subagent children. */
export async function codexSessionGroups(entries: { file: string; mtime: number; size: number }[]): Promise<{ root: CodexSessionInfo; children: CodexSessionInfo[] }[]> {
  const infos: CodexSessionInfo[] = [];
  for (const e of entries) {
    try {
      infos.push(await codexSessionInfo(e));
    } catch {
      // unreadable file
    }
  }
  const byId = new Map(infos.map((i) => [i.id as string, i]));
  const children = new Map<string, CodexSessionInfo[]>();
  const roots: CodexSessionInfo[] = [];
  for (const i of infos) {
    // A child whose ancestor is in the window joins the topmost ancestor present.
    let top: CodexSessionInfo = i;
    const seen = new Set<string>();
    while (top.parent && byId.has(top.parent) && !seen.has(top.parent)) {
      seen.add(top.parent);
      top = byId.get(top.parent) as CodexSessionInfo;
    }
    if (top === i) roots.push(i);
    else (children.get(top.id as string) ?? children.set(top.id as string, []).get(top.id as string))!.push(i);
  }
  return roots.map((root) => ({ root, children: children.get(root.id as string) ?? [] }));
}

function outputText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("\n");
  return "";
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type !== "input_text" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

function entrypointFor(threadSource: string | null, source: string | null): string | null {
  if (source === "exec") return "exec";
  if (threadSource === "user") return "cli";
  if (threadSource === "subagent") return "subagent";
  if (source) return "cli";
  return null;
}

/** Reads one rollout into events. Subagent threads read with scope `sub`. */
export async function readCodexEvents(file: string, scope: Scope, opts: ReplayOptions, meta: SessionMeta): Promise<ReplayEvent[]> {
  const events: ReplayEvent[] = [];
  const maxOutput = opts.maxOutputBytes ?? 256 * 1024;
  const calls = new Map<string, { name: string; command: string; cellId?: string; ts: string; model: string | null }>();
  const cells = new Map<string, { command: string; cwd: string }>();
  const agent = scope === "sub" ? basename(file, ".jsonl") : null;
  let model: string | null = null;
  let cwd = "";
  let seq = 0;
  let lastText: number | null = null;
  const endTurn = () => {
    if (lastText !== null) (events[lastText] as { final: boolean }).final = true;
    lastText = null;
  };
  for await (const { line, bad } of lines(file)) {
    seq++;
    if (bad) {
      meta.badLines++;
      continue;
    }
    const ts = s(line.timestamp) ?? "";
    noteTimestamp(meta, ts);
    const p = line.payload ?? {};
    const type = line.type;
    if (type === "session_meta") {
      if (scope === "main") {
        meta.cwd = meta.cwd ?? s(p.cwd);
        meta.entrypoint = meta.entrypoint ?? entrypointFor(s(p.thread_source), typeof p.source === "string" ? p.source : p.source && typeof p.source === "object" ? Object.keys(p.source as object)[0] ?? null : null);
      }
      cwd = s(p.cwd) ?? cwd;
      continue;
    }
    if (type === "turn_context") {
      model = s(p.model) ?? model;
      cwd = s(p.cwd) ?? cwd;
      continue;
    }
    if (type === "event_msg") {
      const kind = s(p.type);
      if (kind === "patch_apply_end") {
        if (p.success === false) continue;
        const changes = p.changes && typeof p.changes === "object" ? Object.keys(p.changes as object) : [];
        for (const path of changes) events.push({ kind: "edit", ts, seq, path, edit: "apply_patch", scope, agent });
      } else if (kind === "task_complete" || kind === "turn_aborted" || kind === "user_message") {
        endTurn();
      }
      continue;
    }
    if (type !== "response_item") continue;
    const kind = s(p.type);
    if (kind === "message") {
      if (s(p.role) !== "assistant") {
        if (s(p.role) === "user") endTurn();
        continue;
      }
      const text = messageText(p.content);
      if (!text.trim()) continue;
      if (scope === "main") {
        meta.assistantMessages++;
        if (model) meta.models[model] = (meta.models[model] ?? 0) + 1;
      }
      const final = s(p.phase) === "final_answer";
      events.push({ kind: "text", ts, seq, text: text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text, final, scope, model });
      lastText = final ? null : events.length - 1;
      if (final) lastText = null;
      continue;
    }
    if (kind === "custom_tool_call" || kind === "function_call") {
      meta.toolCalls++;
      const callId = s(p.call_id);
      const name = s(p.name) ?? "";
      if (!callId) continue;
      if (kind === "custom_tool_call" && (name === "exec" || name === "shell")) {
        calls.set(callId, { name: "exec", command: typeof p.input === "string" ? p.input : outputText(p.input), ts, model });
      } else if (name === "wait" || name === "exec_wait") {
        let cellId: string | undefined;
        try {
          const args = typeof p.arguments === "string" ? (JSON.parse(p.arguments) as Record<string, unknown>) : (p.arguments as Record<string, unknown>) ?? {};
          if (args.cell_id !== undefined && args.cell_id !== null) cellId = String(args.cell_id);
        } catch {
          // no cell id
        }
        const entry: { name: string; command: string; cellId?: string; ts: string; model: string | null } = { name: "wait", command: "", ts, model };
        if (cellId) entry.cellId = cellId;
        calls.set(callId, entry);
      } else if (name === "shell" || name === "local_shell" || name === "container.exec") {
        let command = "";
        try {
          const args = typeof p.arguments === "string" ? (JSON.parse(p.arguments) as Record<string, unknown>) : (p.arguments as Record<string, unknown>) ?? {};
          const c = args.cmd ?? args.command;
          command = Array.isArray(c) ? c.map(String).join(" ") : typeof c === "string" ? c : "";
        } catch {
          command = "";
        }
        if (command) calls.set(callId, { name: "exec", command, ts, model });
      }
      continue;
    }
    if (kind === "custom_tool_call_output" || kind === "function_call_output") {
      const callId = s(p.call_id);
      const call = callId ? calls.get(callId) : undefined;
      if (!call || !callId) continue;
      calls.delete(callId);
      const parsed = parseCodexExecOutput(outputText(p.output));
      if (call.name === "wait") {
        const cellId = parsed.cellId ?? call.cellId;
        const cell = cellId ? cells.get(cellId) : undefined;
        if (!cell || parsed.state === "running" || parsed.state === "unknown") continue;
        if (cellId) cells.delete(cellId);
        const commands = extractExecCommands(cell.command);
        const isCell = commands.length !== 1 || commands[0] !== cell.command;
        const cellExit = isCell ? (commands.length === 1 ? exitFromCellOutput(parsed.output) : null) : parsed.exit;
        for (const command of commands) {
          events.push({ kind: "run", ts, seq, command, output: clipOutput(parsed.output, maxOutput), exit: cellExit, ...(!isCell && parsed.exitFailed ? { exitFailed: true } : {}), interrupted: parsed.state === "aborted", background: false, cwd: cell.cwd, scope, toolUseId: callId, agent, model: call.model });
          for (const e of editsFromBash(command, parsed.output)) events.push({ kind: "edit", ts, seq, path: e.path, edit: e.kind, scope, agent });
        }
        continue;
      }
      const background = parsed.state === "running";
      if (background && parsed.cellId) cells.set(parsed.cellId, { command: call.command, cwd });
      const output = clipOutput(parsed.output, maxOutput);
      const commands = extractExecCommands(call.command);
      // A JavaScript cell completes whatever its commands returned, so their exit is only known when the cell printed it.
      const isCell = commands.length !== 1 || commands[0] !== call.command;
      const cellExit = isCell ? (commands.length === 1 ? exitFromCellOutput(parsed.output) : null) : parsed.exit;
      for (const command of commands) {
        events.push({ kind: "run", ts, seq, command, output, exit: cellExit, ...(!isCell && parsed.exitFailed ? { exitFailed: true } : {}), interrupted: parsed.state === "aborted", background, cwd, scope, toolUseId: callId, agent, model: call.model });
        if (!background) for (const e of editsFromBash(command, parsed.output)) events.push({ kind: "edit", ts, seq, path: e.path, edit: e.kind, scope, agent });
      }
    }
  }
  endTurn();
  return events;
}

/** Replays one root thread with its subagent threads merged in. */
export async function replayCodexSession(file: string, opts: ReplayOptions & { children?: string[] } = {}): Promise<SessionReplay> {
  const meta = emptyMeta();
  let events = await readCodexEvents(file, "main", opts, meta);
  const children = opts.includeSubagents === false ? [] : (opts.children ?? []);
  for (const child of children) {
    const subMeta = { ...meta, models: {}, assistantMessages: 0, toolCalls: 0, badLines: 0 };
    try {
      events = events.concat(await readCodexEvents(child, "sub", opts, subMeta));
      meta.toolCalls += subMeta.toolCalls;
      meta.badLines += subMeta.badLines;
    } catch {
      meta.badLines++;
    }
  }
  events.sort(byTime);
  const session = await sessionIdOf(file);
  return replayEvents("codex", file, session, events, meta, children.length, opts);
}

async function sessionIdOf(file: string): Promise<string> {
  try {
    const info = await codexSessionInfo({ file, mtime: 0, size: 0 });
    return info.id ?? basename(file, ".jsonl");
  } catch {
    return basename(file, ".jsonl");
  }
}
