/**
 * Codex shell output and patch formats.
 *
 * Codex's shell tool reports a run as a header followed by the output:
 *
 *   Script completed              (or "Script failed", "Script running with
 *   Wall time 1.2 seconds          cell ID 3", "Script terminated",
 *   Output:                        "aborted by user")
 *   ...the command's output...
 *
 * No numeric exit status is recorded; "Script failed" only says it was not
 * zero. File edits go through `apply_patch`, whose patch text names every
 * file it touches.
 *
 * In rollouts the `exec` tool's input is a JavaScript cell, and the shell
 * commands sit inside it as `await tools.exec_command({ cmd: "..." })`.
 * Hooks see the plain command; the transcript reader has to dig it out.
 */

import type { EditCandidate } from "../../core/edits.js";

export type CodexRunState = "completed" | "failed" | "running" | "terminated" | "aborted" | "unknown";

export interface CodexExecOutput {
  state: CodexRunState;
  /** The cell id of a run that was still going when the tool returned. */
  cellId: string | null;
  wallSeconds: number | null;
  /** The command's own output, without the header. */
  output: string;
  /** 0 for a completed script, a number when the header carries one, else null. */
  exit: number | null;
  /** The header said the script failed but gave no number. */
  exitFailed: boolean;
}

const HEADER_RE = /^\s*(Script completed|Script failed|Script running with cell ID (\d+)|Script terminated|aborted by user)\b[^\n]*/i;
const EXIT_RE = /(?:exit(?:ed)? (?:with )?(?:code|status)|exit code|Process exited with code)[:=]?\s*(-?\d+)/i;
const WALL_RE = /^\s*Wall time ([\d.]+) seconds?\s*$/i;

/** Splits a Codex shell result into its state and the command's output. */
export function parseCodexExecOutput(text: string): CodexExecOutput {
  const lines = text.split("\n");
  const m = HEADER_RE.exec(lines[0] ?? "");
  if (!m) return { state: "unknown", cellId: null, wallSeconds: null, output: text, exit: null, exitFailed: false };
  const head = (m[1] as string).toLowerCase();
  let state: CodexRunState = "unknown";
  if (head.startsWith("script completed")) state = "completed";
  else if (head.startsWith("script failed")) state = "failed";
  else if (head.startsWith("script running")) state = "running";
  else if (head.startsWith("script terminated")) state = "terminated";
  else if (head.startsWith("aborted")) state = "aborted";
  let i = 1;
  let wallSeconds: number | null = null;
  const wall = WALL_RE.exec(lines[i] ?? "");
  if (wall) {
    wallSeconds = Number(wall[1]);
    i++;
  }
  if (/^\s*Output:\s*$/.test(lines[i] ?? "")) i++;
  const output = lines.slice(i).join("\n");
  let exit: number | null = state === "completed" ? 0 : null;
  const exitMatch = EXIT_RE.exec(lines.slice(0, i).join("\n"));
  if (exitMatch) exit = Number(exitMatch[1]);
  return { state, cellId: m[2] ?? null, wallSeconds, output, exit, exitFailed: state === "failed" && exit === null };
}

const PATCH_LINE_RE = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+?)\s*$/gm;

/** The files an `apply_patch` call touches, one edit candidate each. */
export function applyPatchEdits(patch: string): EditCandidate[] {
  const out: EditCandidate[] = [];
  const seen = new Set<string>();
  for (const m of patch.matchAll(PATCH_LINE_RE)) {
    const path = (m[2] as string).trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, kind: "apply_patch" });
  }
  return out;
}

/** Reads a JavaScript string literal starting at `start` (the quote). Returns the value and the index after it. */
function readJsString(src: string, start: number): { value: string; end: number } | null {
  const q = src[start];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  let i = start + 1;
  let out = "";
  while (i < src.length) {
    const c = src[i] as string;
    if (c === "\\") {
      const n = src[i + 1] ?? "";
      const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", b: "\b", f: "\f", v: "\v" };
      if (n === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
        out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
        i += 6;
      } else if (n === "x" && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 2, i + 4))) {
        out += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16));
        i += 4;
      } else if (n === "\n") {
        i += 2; // line continuation
      } else {
        out += simple[n] ?? n;
        i += 2;
      }
      continue;
    }
    if (c === q) return { value: out, end: i + 1 };
    if (q === "`" && c === "$" && src[i + 1] === "{") return null; // an interpolation: not a literal command
    out += c;
    i++;
  }
  return null;
}

const EXEC_CALL_RE = /\bexec_command\s*\(\s*\{/g;
const CMD_KEY_RE = /\b(?:cmd|command)\s*:\s*/y;

/**
 * The shell commands a Codex exec cell runs, in order. Input that is not a
 * JavaScript cell (no `tools.` calls) is taken as a shell command itself.
 */
export function extractExecCommands(script: string): string[] {
  if (!/\btools\.|\bexec_command\s*\(/.test(script)) return script.trim() ? [script] : [];
  const out: string[] = [];
  for (const m of script.matchAll(EXEC_CALL_RE)) {
    const objStart = m.index + m[0].length;
    // Find the cmd key inside the object literal, skipping other keys and nested strings.
    let i = objStart;
    let depth = 1;
    while (i < script.length && depth > 0) {
      const c = script[i] as string;
      if (c === '"' || c === "'" || c === "`") {
        const str = readJsString(script, i);
        i = str ? str.end : i + 1;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        i++;
        continue;
      }
      if (depth === 1) {
        CMD_KEY_RE.lastIndex = i;
        const key = CMD_KEY_RE.exec(script);
        if (key) {
          const str = readJsString(script, key.index + key[0].length);
          if (str && str.value.trim()) out.push(str.value);
          i = str ? str.end : key.index + key[0].length;
          // Skip the rest of this object literal.
          while (i < script.length && depth > 0) {
            const d = script[i] as string;
            if (d === '"' || d === "'" || d === "`") {
              const skip = readJsString(script, i);
              i = skip ? skip.end : i + 1;
              continue;
            }
            if (d === "{") depth++;
            else if (d === "}") depth--;
            i++;
          }
          break;
        }
      }
      i++;
    }
  }
  return out;
}

/** An exit status the cell printed for its command, when it printed the result object. */
export function exitFromCellOutput(output: string): number | null {
  const matches = [...output.matchAll(/["']?exit_code["']?\s*[:=]\s*(-?\d+)/g)];
  if (matches.length === 0) return null;
  return Number(matches[matches.length - 1]![1]);
}
