import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply, blocksToText, type ContextLike } from "../dsh-plugin-stalegreen/src/index.js";
import { readEdits, readPending, readReceipts, readVerdicts } from "../src/core/receipts.js";
import { runDshHook, splitDshOutput } from "../src/harness/dsh/hooks.js";
import { makeHome, makeRepo, readFixture, type TempRepo } from "./helpers.js";

let repo: TempRepo;
let home: { home: string; cleanup: () => void };
const SESSION = "dsh-session-1";

beforeEach(() => {
  home = makeHome();
  process.env.STALEGREEN_HOME = home.home;
  repo = makeRepo();
});
afterEach(() => {
  delete process.env.STALEGREEN_HOME;
  home.cleanup();
  repo.cleanup();
});

const vitestPass = readFixture("runner-output", "vitest-pass.txt");
const vitestFail = readFixture("runner-output", "vitest-fail.txt");

describe("DeepSeek Harness adapter", () => {
  it("reads the bash tool's exit marker and saved-output note", () => {
    expect(splitDshOutput(`${vitestFail}\n[exit code: 1]\n`)).toMatchObject({ exit: 1 });
    expect(splitDshOutput(`${vitestFail}\n[exit code: 1]\n`).output).toBe(vitestFail.replace(/\s+$/, ""));
    expect(splitDshOutput("hello\n")).toEqual({ output: "hello\n", exit: null, savedTo: null });
    expect(splitDshOutput("tail...\nfull output saved to /tmp/out.txt\n[exit code: 2]").savedTo).toBe("/tmp/out.txt");
  });

  it("records a pass without a marker, a failure from the marker, and edits from the file tools", () => {
    const base = { session_id: SESSION, cwd: repo.dir };
    runDshHook("PostToolUse", { ...base, hook_event_name: "PostToolUse", tool_name: "bash", tool_input: { command: "npx vitest run", description: "tests" }, tool_use_id: "c1", tool_response: vitestPass, is_error: false });
    runDshHook("PostToolUse", { ...base, hook_event_name: "PostToolUse", tool_name: "bash", tool_input: { command: "npx vitest run", description: "tests" }, tool_use_id: "c2", tool_response: `${vitestFail}\n[exit code: 1]`, is_error: false });
    runDshHook("PostToolUse", { ...base, hook_event_name: "PostToolUse", tool_name: "edit", tool_input: { path: join(repo.dir, "src/a.ts"), old: "1", new: "2" }, tool_use_id: "c3", tool_response: "ok", is_error: false });
    runDshHook("PostToolUse", { ...base, hook_event_name: "PostToolUse", tool_name: "str_replace_editor", tool_input: { command: "view", path: join(repo.dir, "src/b.ts") }, tool_use_id: "c4", tool_response: "...", is_error: false });
    runDshHook("PostToolUse", { ...base, hook_event_name: "PostToolUse", tool_name: "str_replace_editor", tool_input: { command: "create", path: join(repo.dir, "src/c.ts"), file_text: "x" }, tool_use_id: "c5", tool_response: "ok", is_error: false });
    const receipts = readReceipts(SESSION);
    expect(receipts.map((r) => `${r.harness}:${r.verdict}:${r.exit}:${r.signal}`)).toEqual(["dsh:pass:0:vitest-passed", "dsh:fail:1:vitest-failed"]);
    expect(readEdits(SESSION).map((e) => `${e.kind}:${basename(e.path ?? "")}`)).toEqual(["edit:a.ts", "str_replace_editor:c.ts"]);
  });

  it("denies a masked verification command only in strict mode and never rewrites", () => {
    const pre = { session_id: SESSION, cwd: repo.dir, hook_event_name: "PreToolUse", tool_name: "bash", tool_input: { command: "pnpm test | tail -5", description: "t" }, tool_use_id: "p1" };
    expect(runDshHook("PreToolUse", pre).stdout).toBeUndefined();
    expect(readPending(SESSION)[0]?.unwrapped).toBe("no-allow");
    writeFileSync(join(repo.dir, ".stalegreen.json"), JSON.stringify({ mode: "strict", fingerprintBudgetMs: 5000 }));
    const out = runDshHook("PreToolUse", { ...pre, tool_use_id: "p2" });
    expect(JSON.parse(out.stdout ?? "{}")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
});

/** A fake Cordis context that keeps the listeners so a test can fire events. */
function fakeContext() {
  const listeners = new Map<string, Function[]>();
  const warnings: string[] = [];
  const ctx: ContextLike = {
    on(event: string, listener: Function) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return () => {};
    },
    logger: { warn: (m: string) => warnings.push(m) },
  } as unknown as ContextLike;
  const fire = (event: string, ...args: unknown[]) => Promise.all((listeners.get(event) ?? []).map((l) => l(...args)));
  return { ctx, fire, warnings, listeners };
}

describe("dsh-plugin-stalegreen", () => {
  it("registers the three listeners and the session feed", () => {
    const { ctx, listeners } = fakeContext();
    apply(ctx);
    expect([...listeners.keys()].sort()).toEqual(["agent/turn-stopping", "session/event", "tools/post-execute", "tools/pre-execute"]);
    expect(blocksToText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("ab");
  });

  it("turns a stale claim into a steered correction step, once per turn", async () => {
    const { ctx, fire } = fakeContext();
    apply(ctx);
    const steered: unknown[] = [];
    const agent = { session: { header: { id: SESSION, cwd: repo.dir } }, steer: (m: unknown) => steered.push(m) };
    const exec = (name: string, args: Record<string, unknown>, callId: string) => ({ name, arguments: args, callId, agent });
    const next = async () => ({ kind: "allow" as const });
    const accept = async () => ({ kind: "accept" as const });

    expect(await fire("tools/pre-execute", exec("bash", { command: "npx vitest run", description: "t" }, "c1"), next)).toEqual([{ kind: "allow" }]);
    await fire("tools/post-execute", exec("bash", { command: "npx vitest run", description: "t" }, "c1"), { content: [{ type: "text", text: vitestPass }], isError: false }, accept);
    await fire("session/event", agent.session, { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "All 41 tests pass." }] } } });
    await fire("agent/turn-stopping", { agent, turn: 1 });
    expect(steered).toHaveLength(0);

    writeFileSync(repo.file, "export const remaining = 0;\n");
    await fire("tools/post-execute", exec("edit", { path: repo.file, old: "1", new: "0" }, "c2"), { content: [{ type: "text", text: "ok" }], isError: false }, accept);
    await fire("session/event", agent.session, { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: "Done. All 41 tests pass." }] } } });
    await fire("agent/turn-stopping", { agent, turn: 2 });
    expect(steered).toHaveLength(1);
    const message = steered[0] as { role: string; content: { type: string; text: string }[]; source: { kind: string; plugin: string } };
    expect(message.role).toBe("user");
    expect(message.source).toEqual({ kind: "plugin", plugin: "stalegreen" });
    expect(message.content[0]?.text).toContain("is stale");
    expect(message.content[0]?.text).toContain("r-0001");
    expect(message.content[0]?.text).toContain("hold.ts");

    // The same turn is not steered twice.
    await fire("session/event", agent.session, { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: "All 41 tests pass." }] } } });
    await fire("agent/turn-stopping", { agent, turn: 2 });
    expect(steered).toHaveLength(1);
    const verdicts = readVerdicts(SESSION);
    expect(verdicts.map((v) => v.blocked)).toEqual([false, true, false]);
    expect(verdicts[1]?.verdicts[0]?.verdict).toBe("STALE");
  });

  it("denies a masked run in strict mode and ignores tools it does not know", async () => {
    const { ctx, fire } = fakeContext();
    apply(ctx, { mode: "strict" });
    writeFileSync(join(repo.dir, ".stalegreen.json"), JSON.stringify({ mode: "strict", fingerprintBudgetMs: 5000 }));
    const agent = { session: { header: { id: SESSION, cwd: repo.dir } }, steer: () => {} };
    const next = async () => ({ kind: "allow" as const });
    const [decision] = await fire("tools/pre-execute", { name: "bash", arguments: { command: "pnpm test | tail -3", description: "t" }, callId: "x", agent }, next);
    expect(decision).toMatchObject({ kind: "deny" });
    expect((decision as { reason: string }).reason).toContain("piped");
    expect(await fire("tools/pre-execute", { name: "web_search", arguments: { query: "x" }, callId: "y", agent }, next)).toEqual([{ kind: "allow" }]);
  });

  it("stays quiet when no assistant message was seen or the turn made no claim", async () => {
    const { ctx, fire, warnings } = fakeContext();
    apply(ctx);
    const steered: unknown[] = [];
    const agent = { session: { header: { id: SESSION, cwd: repo.dir } }, steer: (m: unknown) => steered.push(m) };
    await fire("agent/turn-stopping", { agent, turn: 1 });
    await fire("session/event", agent.session, { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "Looking into it." }] } } });
    await fire("agent/turn-stopping", { agent, turn: 1 });
    expect(steered).toHaveLength(0);
    expect(warnings).toEqual([]);
  });
});
