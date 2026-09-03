/**
 * dsh-plugin-stalegreen: the stalegreen freshness gate as a DeepSeek Harness
 * (Cordis) plugin.
 *
 * Three listeners, the same three behaviours as the Claude Code and Codex
 * hooks, on the harness's own extension points:
 *
 * - `tools/pre-execute`: a verification command (`pytest`, `pnpm test`,
 *   `tsc`, `eslint`, `cargo test`, ...) gets a pending receipt; in strict
 *   mode a masked one (`| tail`, `|| true`, `2>/dev/null`) is denied with
 *   the instruction to run it unmasked. The harness's waterfall cannot
 *   rewrite a tool call, so nothing is rewritten here.
 * - `tools/post-execute`: the bash tool's output becomes a receipt (pass,
 *   fail or inconclusive, with counts and the `[exit code: N]` marker), and
 *   the file tools (`edit`, `write`, `str_replace_editor`) become edit
 *   events.
 * - `agent/turn-stopping`: the last assistant message of the turn is read
 *   for green claims; a claim whose evidence is stale, failed or masked
 *   steers one more step with the receipt, the edited files and what to do,
 *   at most once per turn.
 *
 * Everything is deterministic and local: no model call, no network.
 */

import { runDshHook, type HookOutcome } from "stalegreen";

export const name = "stalegreen";

/** Plugin options, all optional; the stalegreen config files still apply. */
export interface Config {
  /** `block` steers a correction step; `advisory` only records verdicts. */
  policy?: "block" | "advisory";
  /** `strict` denies masked verification commands; `off` records nothing about them. */
  mode?: "rewrite" | "strict" | "off";
  /** Store directory, default `~/.stalegreen` (or `$STALEGREEN_HOME`). */
  home?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
}

interface SessionLike {
  header: { id: string; cwd?: string };
}

interface AgentLike {
  session: SessionLike;
  steer(message: unknown): void;
}

interface ToolExecutionLike {
  name: string;
  arguments: unknown;
  callId: string;
  agent?: AgentLike;
}

interface ToolResultLike {
  content: ContentBlock[];
  isError: boolean;
}

type PreToolDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "ask"; reason?: string };
type PostToolDecision = { kind: "accept"; content?: ContentBlock[] } | { kind: "block"; feedback: ContentBlock[] };

interface SessionEventLike {
  type: string;
  data?: { turn?: number; message?: { content?: ContentBlock[] } };
}

interface Logger {
  warn(message: string): void;
}

/** The slice of a Cordis context the plugin uses. */
export interface ContextLike {
  on(event: "session/event", listener: (session: SessionLike, event: SessionEventLike) => void): unknown;
  on(event: "tools/pre-execute", listener: (exec: ToolExecutionLike, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>): unknown;
  on(event: "tools/post-execute", listener: (exec: ToolExecutionLike, result: ToolResultLike, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>): unknown;
  on(event: "agent/turn-stopping", listener: (payload: { agent: AgentLike; turn: number; signal?: AbortSignal }) => Promise<void> | void): unknown;
  logger?: Logger;
}

export function blocksToText(content: ContentBlock[] | undefined): string {
  return (content ?? []).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");
}

const PLUGIN_SOURCE = { kind: "plugin", plugin: "stalegreen" } as const;

type MessageFactory = (input: { content: ContentBlock[]; source: typeof PLUGIN_SOURCE }) => unknown;

/** `createUserMessage` from the harness when it is installed; a plain message otherwise. */
async function messageFactory(): Promise<MessageFactory> {
  try {
    // Resolved at runtime inside the harness; the specifier is kept out of the literal so the plugin builds without it.
    const specifier = "@deepseek-ai/dsh-llm";
    const mod = (await import(specifier)) as { createUserMessage?: MessageFactory };
    if (typeof mod.createUserMessage === "function") return mod.createUserMessage;
  } catch {
    // The harness always ships dsh-llm; the fallback below is for tests and unusual profiles.
  }
  return (input) => ({ role: "user", ...input });
}

function outcomeDecision(outcome: HookOutcome): { decision?: string; reason?: string } {
  if (!outcome.stdout) return {};
  try {
    const body = JSON.parse(outcome.stdout) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    const decision = body.hookSpecificOutput?.permissionDecision;
    const reason = body.hookSpecificOutput?.permissionDecisionReason;
    return { ...(decision ? { decision } : {}), ...(reason ? { reason } : {}) };
  } catch {
    return {};
  }
}

export function apply(ctx: ContextLike, config: Config = {}): void {
  if (config.home) process.env.STALEGREEN_HOME = config.home;
  const lastMessage = new Map<string, { turn: number; text: string }>();
  const warn = (message: string) => ctx.logger?.warn(`stalegreen: ${message}`);
  const base = (agent: AgentLike | undefined) => ({
    session_id: agent?.session.header.id ?? "dsh-unknown",
    cwd: agent?.session.header.cwd ?? process.cwd(),
    ...(config.policy ? { policy: config.policy } : {}),
    ...(config.mode ? { mode: config.mode } : {}),
  });
  const run = (event: string, payload: Record<string, unknown>): HookOutcome => {
    try {
      return runDshHook(event, payload);
    } catch (err) {
      warn(`${event} failed: ${err instanceof Error ? err.message : String(err)}`);
      return { exit: 0 };
    }
  };

  ctx.on("session/event", (session, event) => {
    if (event.type !== "assistant/message") return;
    const text = blocksToText(event.data?.message?.content);
    if (!text.trim()) return;
    lastMessage.set(session.header.id, { turn: event.data?.turn ?? 0, text });
  });

  ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec.name !== "bash") return next();
    const outcome = run("PreToolUse", { ...base(exec.agent), hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: exec.arguments, tool_use_id: exec.callId });
    const { decision, reason } = outcomeDecision(outcome);
    if (decision === "deny") return { kind: "deny", reason: reason ?? "stalegreen: run the verification command without the pipe so its result is recorded." };
    return next();
  });

  ctx.on("tools/post-execute", async (exec, result, next) => {
    run("PostToolUse", {
      ...base(exec.agent),
      hook_event_name: "PostToolUse",
      tool_name: exec.name,
      tool_input: exec.arguments,
      tool_use_id: exec.callId,
      tool_response: blocksToText(result.content),
      is_error: result.isError,
    });
    return next();
  });

  ctx.on("agent/turn-stopping", async ({ agent, turn }) => {
    const id = agent.session.header.id;
    const last = lastMessage.get(id);
    if (!last) return;
    const outcome = run("Stop", { ...base(agent), hook_event_name: "Stop", turn, stop_hook_active: false, last_assistant_message: last.text });
    if (outcome.exit !== 2 || !outcome.stderr) return;
    const create = await messageFactory();
    agent.steer(create({ content: [{ type: "text", text: outcome.stderr }], source: PLUGIN_SOURCE }));
  });
}
