/**
 * DeepSeek Harness adapter. The Cordis plugin (`dsh-plugin-stalegreen`)
 * listens on `tools/pre-execute`, `tools/post-execute` and
 * `agent/turn-stopping`, turns each into a payload of this shape and hands it
 * here, so the receipt, edit and gate logic is the same code as for Claude
 * Code and Codex.
 *
 * Payload fields: `session_id`, `cwd`, `turn` (the agent's turn number, the
 * loop-guard key), `tool_name`, `tool_input` (the parsed tool arguments),
 * `tool_use_id`, `tool_response` (the model-facing text of the result),
 * `is_error`, and for Stop `last_assistant_message`.
 *
 * DeepSeek Harness's pre-execute waterfall cannot rewrite a tool call, so no
 * rewrite is offered; the bash tool reports a non-zero exit as a
 * `[exit code: N]` line at the end of its output and the full output of a
 * long run is saved to a file whose path it reports.
 */

import { editFromTool, type EditCandidate } from "../../core/edits.js";
import { obj, runHook, str, type DeferredOutput, type HarnessAdapter, type HookOutcome, type Input, type ShellRun } from "../hooks.js";

export type { HookOutcome } from "../hooks.js";

const EXIT_MARKER_RE = /\[exit code: (-?\d+)\]\s*$/;
const SAVED_OUTPUT_RE = /(?:full output (?:was )?saved to|saved to file):?\s+(\S+)/i;
const FILE_TOOLS = new Set(["edit", "write", "str_replace_editor", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The command output without the harness's exit marker, and the exit it carried. */
export function splitDshOutput(text: string): { output: string; exit: number | null; savedTo: string | null } {
  const m = EXIT_MARKER_RE.exec(text);
  const output = m ? text.slice(0, m.index).replace(/\s+$/, "") : text;
  const saved = SAVED_OUTPUT_RE.exec(text);
  return { output, exit: m ? Number(m[1]) : null, savedTo: saved ? (saved[1] as string) : null };
}

export const dshAdapter: HarnessAdapter = {
  harness: "dsh",
  rewriteNeedsAllow: true,
  turnId: (input) => (input.turn === undefined || input.turn === null ? null : String(input.turn)),
  allowDecision: () => ({ allow: false, reason: "" }),
  shellRun(input: Input): ShellRun | null {
    const toolName = str(input.tool_name);
    if (toolName !== "bash" && toolName !== "Bash") return null;
    const toolInput = obj(input.tool_input);
    const command = str(toolInput.command);
    if (!command) return null;
    const text = typeof input.tool_response === "string" ? input.tool_response : str(obj(input.tool_response).text) ?? "";
    const { output, exit } = splitDshOutput(text);
    const background = toolInput.run_in_background === true;
    // No marker means the command exited 0 unless the harness itself reported an error (timeout, abort, sandbox denial).
    const known = exit !== null ? exit : input.is_error === true ? null : 0;
    return { command, stdout: output, stderr: "", exit: known, exitFailed: false, interrupted: false, background, cellId: null };
  },
  deferredOutput(input: Input): DeferredOutput | null {
    const toolName = str(input.tool_name);
    if (toolName !== "job_output") return null;
    const text = typeof input.tool_response === "string" ? input.tool_response : "";
    const { output, exit } = splitDshOutput(text);
    return { text: output, state: exit === null ? null : exit === 0 ? "completed" : "failed", exit, cellId: null };
  },
  editsFromTool(toolName: string, toolInput: unknown): EditCandidate[] {
    if (!FILE_TOOLS.has(toolName)) return [];
    const input = obj(toolInput);
    if (toolName === "str_replace_editor" && str(input.command) === "view") return [];
    const path = str(input.path) ?? str(input.file_path) ?? null;
    if (path) return [{ path, kind: toolName }];
    const e = editFromTool(toolName, toolInput);
    return e ? [e] : [];
  },
  block(message: string): HookOutcome {
    return { exit: 2, stderr: message };
  },
};

/** Handles one DeepSeek Harness event. Throws only on programming errors. */
export function runDshHook(event: string, raw: unknown): HookOutcome {
  return runHook(dshAdapter, event, raw);
}
