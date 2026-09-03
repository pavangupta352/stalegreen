/**
 * The unmask rewrite: wraps a verification command so its full output lands
 * in a log file, the tail is shown to the agent, an explicit exit marker is
 * printed and the exit status is preserved. POSIX sh only: no bashisms and no
 * top-level `exit`, because the agent's shell may be persistent.
 */

import { dirname } from "node:path";
import type { Config } from "./config.js";
import { analyzeMasking } from "./masking.js";
import type { Detection } from "./runners.js";
import { parseCommand, shQuote, type ParsedCommand, type Segment } from "./shell.js";

export interface RewritePlan {
  /** The rewritten command line, or null when the command must be left alone. */
  command: string | null;
  /** Why the command was left alone. */
  reason: string | null;
  /** Number of log lines shown to the agent. */
  tailLines: number;
  ids: string[];
}

export interface RewriteTarget {
  detection: Detection;
  id: string;
  log: string;
}

/** Filters whose only job is to hide output; safe to drop once the log holds everything. */
const DROPPABLE = new Set(["tail", "head", "grep", "egrep", "fgrep", "rg", "wc", "cut", "awk", "sed", "less", "more", "cat", "sort", "uniq", "tr", "jq", "column", "nl"]);

function teeTargets(seg: Segment): { files: string[]; append: boolean } | null {
  if (seg.words[0] !== "tee") return null;
  const files: string[] = [];
  let append = false;
  for (const w of seg.words.slice(1)) {
    if (w === "-a" || w === "--append") append = true;
    else if (w.startsWith("-")) return null;
    else files.push(w);
  }
  return files.length > 0 ? { files, append } : null;
}

/** Decides whether a parsed command can be wrapped at all. */
export function refusalReason(parsed: ParsedCommand, detection: Detection): string | null {
  if (!parsed.confident) return `unreadable: ${parsed.reasons[0] ?? "parse"}`;
  if (parsed.heredoc) return "heredoc";
  if (parsed.processSubstitution) return "process-substitution";
  if (parsed.grouping) return "grouping";
  if (parsed.segments.some((s) => s.background)) return "background";
  if (detection.sudo) return "sudo";
  if (detection.nested) return "nested-shell";
  if (detection.notRun) return detection.notRun;
  const seg = detection.segment;
  for (const r of seg.redirects) {
    const stdout = r.fd === null || r.fd === 1;
    if ((r.op === ">" || r.op === ">>" || r.op === ">|" || r.op === "&>" || r.op === "&>>") && stdout && !/^&\d$/.test(r.target)) return `redirect:${r.target}`;
    if (r.op === "<" || r.op === "<<<" || r.op === "<&") return "stdin-redirect";
  }
  if (seg.negated) return "negated";
  return null;
}

/** The log path as the POSIX shell sees it; Git Bash on Windows takes forward slashes in every position. */
function shellPath(p: string): string {
  return process.platform === "win32" ? p.replace(/\\/g, "/") : p;
}

function wrapper(head: string, id: string, log: string, tailLines: number, tee: { files: string[]; append: boolean } | null): string {
  const q = shQuote(shellPath(log));
  const dir = shQuote(shellPath(dirname(log)));
  const parts: string[] = [];
  parts.push(`__sg_log=${q}`);
  parts.push(`mkdir -p ${dir}`);
  parts.push(`{ ${head} ; } > "$__sg_log" 2>&1`);
  parts.push("__sg_rc=$?");
  if (tee) for (const f of tee.files) parts.push(`cat "$__sg_log" ${tee.append ? ">>" : ">"} ${shQuote(f)}`);
  parts.push(`tail -n ${tailLines} "$__sg_log"`);
  parts.push(`printf '\\n[stalegreen] exit=%s receipt=${id} lines=%s log=%s\\n' "$__sg_rc" "$(wc -l < "$__sg_log" | tr -d ' ')" "$__sg_log"`);
  parts.push(`(exit "$__sg_rc")`);
  return `{ ${parts.join("; ")}; }`;
}

/** The original command with the filter pipes after each runner removed: what the wrapper actually runs. */
export function unfilteredCommand(command: string, targets: RewriteTarget[], parsed?: ParsedCommand): string {
  const p = parsed ?? parseCommand(command);
  const ends = new Map<number, number>();
  for (const t of targets) ends.set(t.detection.segmentIndex, analyzeMasking(p, t.detection.segmentIndex).pipelineEnd);
  let out = "";
  let cursor = 0;
  for (let i = 0; i < p.segments.length; i++) {
    const end = ends.get(i);
    if (end === undefined || end === i) continue;
    const first = p.segments[i] as Segment;
    const last = p.segments[end] as Segment;
    const rawLast = p.source.slice(last.start, last.end);
    out += p.source.slice(cursor, first.end).replace(/\s+$/, "");
    cursor = last.end - (rawLast.length - rawLast.trimEnd().length);
    i = end;
  }
  out += p.source.slice(cursor);
  return out;
}

/**
 * Builds the rewritten command. Every runner segment gets its own receipt id
 * and log; filter pipes after a runner are dropped because the log now holds
 * the full output. Returns `command: null` with a reason when any runner
 * segment cannot be wrapped safely.
 */
export function planRewrite(command: string, targets: RewriteTarget[], config: Config, parsed?: ParsedCommand): RewritePlan {
  const p = parsed ?? parseCommand(command);
  if (targets.length === 0) return { command: null, reason: "no-runner", tailLines: config.tailLines, ids: [] };
  let tailLines = config.tailLines;
  const replacements = new Map<number, { text: string; end: number }>();
  for (const t of targets) {
    const d = t.detection;
    const refuse = refusalReason(p, d);
    if (refuse) return { command: null, reason: refuse, tailLines, ids: [] };
    const analysis = analyzeMasking(p, d.segmentIndex);
    // The agent's own tail count wins, raised to a floor of 20 lines.
    if (analysis.tailLines !== null) tailLines = targets.length === 1 ? Math.max(20, analysis.tailLines) : Math.max(tailLines, Math.max(20, analysis.tailLines));
    let tee: { files: string[]; append: boolean } | null = null;
    for (let j = d.segmentIndex + 1; j <= analysis.pipelineEnd; j++) {
      const seg = p.segments[j] as Segment;
      const cmd = seg.words[0] ?? "";
      const t2 = teeTargets(seg);
      if (t2) {
        tee = tee ? { files: [...tee.files, ...t2.files], append: tee.append && t2.append } : t2;
        continue;
      }
      if (!DROPPABLE.has(cmd)) return { command: null, reason: `pipe:${cmd || "?"}`, tailLines, ids: [] };
      if (seg.redirects.length > 0) return { command: null, reason: `pipe-redirect:${cmd}`, tailLines, ids: [] };
    }
    if (analysis.pipefail && analysis.pipelineEnd > d.segmentIndex) {
      // With pipefail the agent's pipe already preserves the exit; still wrap so the log is complete.
    }
    replacements.set(d.segmentIndex, { text: wrapper(d.segment.head, t.id, t.log, tailLines, tee), end: analysis.pipelineEnd });
  }
  // Rebuild the command from the original source text, replacing runner pipelines.
  let out = "";
  let cursor = 0;
  const segments = p.segments;
  for (let i = 0; i < segments.length; i++) {
    const rep = replacements.get(i);
    if (!rep) continue;
    const first = segments[i] as Segment;
    const last = segments[rep.end] as Segment;
    // Segment offsets include the whitespace around operators; keep it so `a && b` stays `a && b`.
    const rawFirst = p.source.slice(first.start, first.end);
    const rawLast = p.source.slice(last.start, last.end);
    const startPos = first.start + (rawFirst.length - rawFirst.trimStart().length);
    const endPos = last.end - (rawLast.length - rawLast.trimEnd().length);
    out += p.source.slice(cursor, startPos);
    out += rep.text;
    cursor = endPos;
    i = rep.end;
  }
  out += p.source.slice(cursor);
  // Tail lines can only be known after every target is seen; re-render with the final value.
  if (targets.length > 0 && tailLines !== config.tailLines) {
    out = out.replace(/tail -n \d+ "\$__sg_log"/g, `tail -n ${tailLines} "$__sg_log"`);
  }
  return { command: out, reason: null, tailLines, ids: targets.map((t) => t.id) };
}
