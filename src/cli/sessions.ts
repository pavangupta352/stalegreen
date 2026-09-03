/**
 * Finds past sessions for `history` and `stats` across harnesses and replays
 * them one at a time.
 */

import { basename } from "node:path";
import type { Config } from "../core/config.js";
import type { Harness } from "../core/grammar.js";
import { claudeTranscriptFiles, replayClaudeSession } from "../harness/claude/transcript.js";
import { codexSessionGroups, codexTranscriptFiles, replayCodexSession } from "../harness/codex/transcript.js";
import type { SessionReplay } from "../harness/replay.js";

export type HarnessChoice = "claude" | "codex" | "all";

export interface SessionSource {
  harness: Harness;
  file: string;
  /** Subagent or child-thread files merged into this session's timeline. */
  children: string[];
  session: string;
  mtime: number;
}

export function parseHarnessChoice(v: unknown): HarnessChoice | null {
  if (v === undefined || v === true) return null;
  if (v === "claude" || v === "codex" || v === "all") return v;
  return null;
}

export function harnessLabel(h: HarnessChoice): string {
  return h === "claude" ? "Claude Code" : h === "codex" ? "Codex" : "Claude Code and Codex";
}

/** Session files touched since `since`, newest first. Claude subagent files are found by the reader; Codex children are grouped here. */
export async function listSessionSources(harness: HarnessChoice, since: Date, sessionPrefix: string | null = null): Promise<SessionSource[]> {
  const out: SessionSource[] = [];
  if (harness === "claude" || harness === "all") {
    for (const f of claudeTranscriptFiles(undefined, since)) {
      out.push({ harness: "claude", file: f.file, children: [], session: basename(f.file, ".jsonl"), mtime: f.mtime });
    }
  }
  if (harness === "codex" || harness === "all") {
    const groups = await codexSessionGroups(codexTranscriptFiles(undefined, since));
    for (const g of groups) {
      out.push({ harness: "codex", file: g.root.file, children: g.children.map((c) => c.file), session: g.root.id ?? basename(g.root.file, ".jsonl"), mtime: g.root.mtime });
    }
  }
  const filtered = sessionPrefix ? out.filter((s) => s.session.startsWith(sessionPrefix) || basename(s.file, ".jsonl").startsWith(sessionPrefix)) : out;
  return filtered.sort((a, b) => b.mtime - a.mtime);
}

export function replaySource(src: SessionSource, opts: { config: Config; allMessages: boolean }): Promise<SessionReplay> {
  if (src.harness === "codex") return replayCodexSession(src.file, { config: opts.config, allMessages: opts.allMessages, children: src.children });
  return replayClaudeSession(src.file, { config: opts.config, allMessages: opts.allMessages });
}
