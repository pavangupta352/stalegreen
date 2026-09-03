/**
 * Codex hook adapter: PreToolUse, PostToolUse, Stop and SubagentStop.
 *
 * Codex reports the shell tool as `Bash` with `tool_input.command`, and its
 * PostToolUse `tool_response` is the model-facing output: either the raw
 * output or a header (`Script completed`, `Exit code: N`, `Wall time`,
 * `Output:`) followed by it. No exit status is guaranteed, which is why the
 * rewrite matters more here than anywhere else. A rewrite is only accepted
 * together with an allow decision, so it is offered for the verification
 * command itself and for nothing else. A block at Stop is
 * `{"decision":"block","reason":...}`, which Codex turns into a continuation
 * prompt.
 */

import { editFromTool, type EditCandidate } from "../../core/edits.js";
import { obj, runHook, str, type DeferredOutput, type HarnessAdapter, type HookOutcome, type Input, type ShellRun } from "../hooks.js";
import { applyPatchEdits, parseCodexExecOutput } from "./output.js";

export type { HookOutcome } from "../hooks.js";

/** The model-facing text of a tool response, whatever shape Codex sent it in. */
export function responseText(response: unknown): string {
  if (typeof response === "string") return response;
  const r = obj(response);
  const direct = str(r.output) ?? str(r.stdout);
  if (direct !== null) return `${direct}${str(r.stderr) ? `\n${str(r.stderr)}` : ""}`;
  if (Array.isArray(response)) return response.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("");
  return "";
}

export const codexAdapter: HarnessAdapter = {
  harness: "codex",
  rewriteNeedsAllow: true,
  turnId: (input) => str(input.turn_id),
  allowDecision(input, config, { command, targets }) {
    if (config.permission === "ask") return { allow: false, reason: "" };
    if ((str(input.permission_mode) ?? "default") === "plan") return { allow: false, reason: "" };
    const head = targets[0]?.detection.segment.head ?? command;
    return { allow: true, reason: `stalegreen: \`${head}\` is a verification run; wrapped so its result is recorded` };
  },
  shellRun(input: Input): ShellRun | null {
    if (str(input.tool_name) !== "Bash") return null;
    const toolInput = obj(input.tool_input);
    const command = str(toolInput.command);
    if (!command) return null;
    const response = input.tool_response;
    const r = obj(response);
    const parsed = parseCodexExecOutput(responseText(response));
    const exit = typeof r.exit_code === "number" ? r.exit_code : typeof r.exitCode === "number" ? r.exitCode : parsed.exit;
    return {
      command,
      stdout: parsed.output,
      stderr: "",
      exit,
      exitFailed: exit === null && parsed.exitFailed,
      interrupted: parsed.state === "aborted" || r.interrupted === true,
      background: parsed.state === "running",
      cellId: parsed.cellId,
    };
  },
  deferredOutput(input: Input): DeferredOutput | null {
    const toolName = str(input.tool_name);
    if (toolName !== "wait" && toolName !== "TaskOutput" && toolName !== "BashOutput") return null;
    const toolInput = obj(input.tool_input);
    const parsed = parseCodexExecOutput(responseText(input.tool_response));
    const cellId = parsed.cellId ?? (typeof toolInput.cell_id === "number" || typeof toolInput.cell_id === "string" ? String(toolInput.cell_id) : null);
    const state = parsed.state === "completed" ? "completed" : parsed.state === "failed" ? "failed" : null;
    if (parsed.state === "running") return { text: "", state: null, exit: null, cellId };
    return { text: parsed.output, state, exit: parsed.exit, cellId };
  },
  editsFromTool(toolName: string, toolInput: unknown): EditCandidate[] {
    const input = obj(toolInput);
    if (toolName === "apply_patch" || (typeof input.command === "string" && /^\*\*\* Begin Patch/.test(input.command))) {
      return applyPatchEdits(str(input.command) ?? "");
    }
    const e = editFromTool(toolName, toolInput);
    return e ? [e] : [];
  },
  block(message: string): HookOutcome {
    return { exit: 0, stdout: JSON.stringify({ decision: "block", reason: message }) };
  },
};

/** Handles one Codex hook event. Throws only on programming errors; the entry point catches those. */
export function runCodexHook(event: string, raw: unknown): HookOutcome {
  return runHook(codexAdapter, event, raw);
}
