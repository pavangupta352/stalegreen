/**
 * The on-disk store: `~/.stalegreen/sessions/<root>/` holds append-only JSONL
 * files (receipts, edits, pending, verdicts, deferred) plus per-run logs.
 * Everything here is written to be safe under concurrent hook processes.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stalegreenHome } from "./config.js";

export interface SessionRef {
  /** Top-level session id, shared by a parent session and its subagents. */
  root: string;
  agent: string | null;
}

const SAFE_ID = /[^A-Za-z0-9._-]/g;

function safe(id: string): string {
  const s = id.replace(SAFE_ID, "_");
  return s.length > 0 ? s.slice(0, 120) : "unknown";
}

/**
 * Derives the root session and agent from a hook payload. Subagent transcripts
 * live under `<session>/subagents/`, so the parent directory name is the root.
 */
export function deriveSession(input: { session_id?: unknown; transcript_path?: unknown; agent_id?: unknown }): SessionRef {
  const transcript = typeof input.transcript_path === "string" ? input.transcript_path.replace(/\\/g, "/") : "";
  const sessionId = typeof input.session_id === "string" && input.session_id.length > 0 ? input.session_id : null;
  const agentId = typeof input.agent_id === "string" && input.agent_id.length > 0 ? input.agent_id : null;
  if (transcript) {
    const m = /\/([^/]+)\/subagents\/(?:[^/]+\/)*?([^/]+)\.jsonl$/.exec(transcript);
    if (m) return { root: safe(m[1] as string), agent: agentId ?? safe(m[2] as string) };
    const base = basename(transcript);
    if (base.endsWith(".jsonl")) return { root: safe(base.slice(0, -6)), agent: agentId };
  }
  return { root: safe(sessionId ?? "unknown"), agent: agentId };
}

export function sessionsRoot(): string {
  return join(stalegreenHome(), "sessions");
}

export function sessionDir(root: string): string {
  return join(sessionsRoot(), safe(root));
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function appendJsonl(file: string, record: unknown): void {
  ensureDir(dirname(file));
  appendFileSync(file, JSON.stringify(record) + "\n");
}

/** Reads a JSONL file, skipping lines that do not parse. Missing files yield an empty list. */
export function readJsonl<T>(file: string): T[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A partially written line from a concurrent process; ignore it.
    }
  }
  return out;
}

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  try {
    // rename is atomic on POSIX; fall back to a direct write elsewhere.
    renameSync(tmp, file);
  } catch {
    writeFileSync(file, JSON.stringify(value, null, 2));
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

/** Runs `fn` while holding a directory lock. Falls back to running without the lock after a short wait. */
export function withLock<T>(dir: string, fn: () => T): T {
  ensureDir(dir);
  const lock = join(dir, ".lock");
  const deadline = Date.now() + 200;
  let held = false;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lock);
      held = true;
      break;
    } catch {
      // Stale locks older than five seconds are removed.
      try {
        const age = Date.now() - statSync(lock).mtimeMs;
        if (age > 5000) rmdirSync(lock);
      } catch {
        // ignore
      }
      const until = Date.now() + 5;
      while (Date.now() < until) {
        // brief spin; hooks are short-lived processes
      }
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        rmdirSync(lock);
      } catch {
        // ignore
      }
    }
  }
}

/** Next sequential receipt id for a session, for example `r-0017`. */
export function nextReceiptId(dir: string): string {
  return withLock(dir, () => {
    const file = join(dir, "seq");
    let n = 0;
    try {
      n = Number(readFileSync(file, "utf8").trim()) || 0;
    } catch {
      n = 0;
    }
    n += 1;
    writeFileSync(file, String(n));
    return `r-${String(n).padStart(4, "0")}`;
  });
}

/** Records a hook failure without ever throwing. */
export function recordError(event: string, error: unknown): void {
  try {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    appendJsonl(join(stalegreenHome(), "errors.jsonl"), { ts: new Date().toISOString(), event, error: message.slice(0, 500) });
  } catch {
    // nothing left to do
  }
}

/** Session directories ordered by most recent modification. */
export function listSessions(): { root: string; dir: string; mtime: number }[] {
  const base = sessionsRoot();
  if (!existsSync(base)) return [];
  const out: { root: string; dir: string; mtime: number }[] = [];
  for (const name of readdirSync(base)) {
    const dir = join(base, name);
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue;
      let mtime = st.mtimeMs;
      for (const f of ["receipts.jsonl", "edits.jsonl", "verdicts.jsonl"]) {
        try {
          mtime = Math.max(mtime, statSync(join(dir, f)).mtimeMs);
        } catch {
          // ignore
        }
      }
      out.push({ root: name, dir, mtime });
    } catch {
      // ignore
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
