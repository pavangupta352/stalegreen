/**
 * Claude Code hook adapter: PreToolUse, PostToolUse, Stop and SubagentStop.
 * Input arrives as JSON on stdin; a block is exit code 2 with the message on
 * stderr. The shared handlers live in ../hooks.ts.
 */

import { editFromTool, type EditCandidate } from "../../core/edits.js";
import { unfilteredCommand } from "../../core/rewrite.js";
import { obj, runHook, str, type DeferredOutput, type HarnessAdapter, type HookOutcome, type Input, type ShellRun } from "../hooks.js";
import { commandAllowedByRules, loadPermissionRules } from "./permissions.js";

export type { HookOutcome } from "../hooks.js";

export const claudeAdapter: HarnessAdapter = {
  harness: "claude",
  rewriteNeedsAllow: false,
  turnId: (input) => str(input.prompt_id),
  allowDecision(input, config, { command, targets, parsed, cwd }) {
    const mode = str(input.permission_mode) ?? "default";
    if (mode === "bypassPermissions" || mode === "auto" || mode === "plan") return { allow: false, reason: "" };
    const head = targets[0]?.detection.segment.head ?? command;
    if (config.permission === "allow") return { allow: true, reason: `stalegreen: \`${head}\` is a verification run; wrapped so its result is recorded` };
    if (config.permission === "inherit" && commandAllowedByRules(unfilteredCommand(command, targets, parsed), loadPermissionRules(cwd))) {
      return { allow: true, reason: `stalegreen: \`${head}\` is allowed by your permission rules; wrapped so its result is recorded` };
    }
    return { allow: false, reason: "" };
  },
  shellRun(input: Input): ShellRun | null {
    if (str(input.tool_name) !== "Bash") return null;
    const toolInput = obj(input.tool_input);
    const command = str(toolInput.command);
    if (!command) return null;
    const response = input.tool_response;
    const r = obj(response);
    const stdout = str(r.stdout) ?? (typeof response === "string" ? response : "");
    const stderr = str(r.stderr) ?? "";
    const exit = typeof r.exit_code === "number" ? r.exit_code : typeof r.exitCode === "number" ? r.exitCode : null;
    return { command, stdout, stderr, exit, exitFailed: false, interrupted: r.interrupted === true, background: toolInput.run_in_background === true, cellId: typeof r.backgroundTaskId === "string" ? r.backgroundTaskId : null };
  },
  deferredOutput(input: Input): DeferredOutput | null {
    const toolName = str(input.tool_name);
    if (toolName !== "TaskOutput" && toolName !== "BashOutput") return null;
    const r = obj(input.tool_response);
    const text = [str(r.stdout), str(r.output), str(r.stderr), typeof input.tool_response === "string" ? input.tool_response : null].filter((s): s is string => !!s).join("\n");
    return { text, state: null, exit: null, cellId: null };
  },
  editsFromTool(toolName: string, toolInput: unknown): EditCandidate[] {
    const e = editFromTool(toolName, toolInput);
    return e ? [e] : [];
  },
  block(message: string): HookOutcome {
    return { exit: 2, stderr: message };
  },
};

/** Handles one Claude Code hook event. Throws only on programming errors; the entry point catches those. */
export function runClaudeHook(event: string, raw: unknown): HookOutcome {
  return runHook(claudeAdapter, event, raw);
}
