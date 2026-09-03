/**
 * Masking analysis: decides whether the exit status and summary of a runner
 * segment can reach the transcript, and records what hides them.
 */

import type { ParsedCommand, Segment } from "./shell.js";

export interface MaskAnalysis {
  masked: boolean;
  reasons: string[];
  /** False when a pipe, `||`, `;` chain or `!` replaces the runner's exit status. */
  exitPreserved: boolean;
  /** False when stdout goes to a file, `/dev/null`, or through a filtering pipe. */
  outputVisible: boolean;
  /** The agent's own `tail -n K` after the pipe, if any. */
  tailLines: number | null;
  /** The agent's own `head -n K` after the pipe, if any. */
  headLines: number | null;
  /** The output went through a filter (grep, sed, awk, cut, wc, sort, uniq, tr) that can hide lines. */
  filtered: boolean;
  pipefail: boolean;
  /** The segment is backgrounded with `&`. */
  background: boolean;
  /** Index of the last segment that belongs to the runner's pipeline. */
  pipelineEnd: number;
}

const FILTERS = new Set(["grep", "egrep", "fgrep", "rg", "head", "sed", "awk", "cut", "wc", "sort", "uniq", "tr", "xargs", "jq", "less", "more", "tail"]);
const PASSTHROUGH = new Set(["cat", "tee"]);

function isDevNull(target: string): boolean {
  return target === "/dev/null";
}

function tailCount(words: string[]): number | null {
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as string;
    let m = /^-n(\d+)$/.exec(w) ?? /^-(\d+)$/.exec(w) ?? /^--lines=(\d+)$/.exec(w);
    if (m) return Number(m[1]);
    if ((w === "-n" || w === "--lines") && words[i + 1]) {
      m = /^\+?(\d+)$/.exec(words[i + 1] as string);
      if (m) return Number(m[1]);
    }
  }
  return 10;
}

function remainderText(parsed: ParsedCommand, from: number): string {
  return parsed.segments
    .slice(from)
    .map((s) => s.head)
    .join(" ; ");
}

function hasPipefail(parsed: ParsedCommand, before: number): boolean {
  for (let i = 0; i < before; i++) {
    const s = parsed.segments[i] as Segment;
    if (s.words[0] === "set" && s.words.some((w) => w === "pipefail") && s.words.some((w) => w === "-o" || /^-[a-z]*o[a-z]*$/.test(w))) return true;
  }
  return false;
}

/** Analyses the runner segment at `index` inside `parsed`. */
export function analyzeMasking(parsed: ParsedCommand, index: number): MaskAnalysis {
  const seg = parsed.segments[index] as Segment;
  const reasons: string[] = [];
  let exitPreserved = true;
  let outputVisible = true;
  let tailLines: number | null = null;
  let headLines: number | null = null;
  let filtered = false;
  const pipefail = hasPipefail(parsed, index);
  let pipelineEnd = index;

  if (seg.negated) {
    reasons.push("negated");
    exitPreserved = false;
  }
  for (const r of seg.redirects) {
    const toStdout = r.fd === null || r.fd === 1;
    if ((r.op === ">" || r.op === ">>" || r.op === ">|") && toStdout) {
      if (isDevNull(r.target)) {
        reasons.push("devnull:stdout");
        outputVisible = false;
      } else if (!/^&\d$/.test(r.target)) {
        reasons.push(`redirect:${r.target}`);
        outputVisible = false;
      }
    } else if ((r.op === ">" || r.op === ">>") && r.fd === 2 && isDevNull(r.target)) {
      reasons.push("devnull:stderr");
    } else if (r.op === "&>" || r.op === "&>>") {
      reasons.push(isDevNull(r.target) ? "devnull:both" : `redirect:${r.target}`);
      outputVisible = false;
    }
  }

  let j = index + 1;
  // A pipeline: the segments joined by `|` immediately after the runner.
  while (j < parsed.segments.length && (parsed.segments[j] as Segment).op === "|") {
    const next = parsed.segments[j] as Segment;
    const cmd = next.words[0] ?? "";
    pipelineEnd = j;
    if (!pipefail) exitPreserved = false;
    if (FILTERS.has(cmd)) {
      reasons.push(`pipe:${cmd}`);
      if (cmd === "tail") tailLines = tailCount(next.words);
      else if (cmd === "head") {
        headLines = tailCount(next.words);
        outputVisible = false;
      } else {
        outputVisible = false;
        filtered = true;
      }
    } else if (PASSTHROUGH.has(cmd)) {
      reasons.push(`pipe:${cmd}`);
    } else {
      reasons.push(`pipe:${cmd || "?"}`);
      outputVisible = false;
    }
    j++;
  }
  if (j - 1 === pipelineEnd && pipelineEnd > index && pipefail) {
    // With pipefail the exit survives; a `tail`, `cat` or `tee` keeps the summary visible.
  }

  let background = seg.background;
  // The operators after the pipeline decide whether the exit status survives.
  let k = pipelineEnd;
  if ((parsed.segments[k] as Segment).background) background = true;
  while (k + 1 < parsed.segments.length) {
    const next = parsed.segments[k + 1] as Segment;
    const op = next.op;
    if (op === "&&") {
      k++;
      continue;
    }
    if (op === "||") {
      const rest = remainderText(parsed, k + 1);
      if (!/\b(?:exit|return|false|kill)\b/.test(rest)) {
        reasons.push("or-chain");
        exitPreserved = false;
      }
      break;
    }
    if (op === ";" || op === "newline") {
      const rest = remainderText(parsed, k + 1);
      if (rest.trim().length > 0 && !/\bexit \$\?/.test(rest) && !/^\s*(?:true|:)\s*$/.test(rest)) {
        reasons.push("semicolon");
        exitPreserved = false;
      }
      break;
    }
    if (op === "&") {
      break;
    }
    break;
  }
  if ((parsed.segments[k] as Segment).background) background = true;

  const masked = reasons.some((r) => r !== "devnull:stderr") || !exitPreserved;
  return { masked, reasons, exitPreserved, outputVisible, tailLines, headLines, filtered, pipefail, background, pipelineEnd };
}
