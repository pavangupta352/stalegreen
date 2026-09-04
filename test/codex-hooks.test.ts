import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDeferred, readEdits, readPending, readReceipts, readVerdicts } from "../src/core/receipts.js";
import { deriveSession, readJsonl, sessionDir } from "../src/core/store.js";
import { runCodexHook, responseText } from "../src/harness/codex/hooks.js";
import { applyPatchEdits, parseCodexExecOutput } from "../src/harness/codex/output.js";
import { loadHookFixture, makeHome, makeRepo, nextMillisecond, readFixture, type TempRepo } from "./helpers.js";

let repo: TempRepo;
let home: { home: string; cleanup: () => void };

function payload(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...loadHookFixture(name, "codex"), cwd: repo.dir, ...overrides };
}

function bashDone(command: string, response: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return payload("PostToolUse-bash.json", { tool_input: { command }, tool_response: response, ...extra });
}

function stopWith(message: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return payload("Stop.json", { last_assistant_message: message, ...overrides });
}

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
const ROOT = () => deriveSession(loadHookFixture("Stop.json", "codex")).root;

describe("Codex output formats", () => {
  it("reads the script header and leaves the command's output", () => {
    const completed = parseCodexExecOutput(`Script completed\nWall time 1.2 seconds\nOutput:\n${vitestPass}`);
    expect(completed).toMatchObject({ state: "completed", exit: 0, exitFailed: false, wallSeconds: 1.2, cellId: null });
    expect(completed.output).toBe(vitestPass);
    const failed = parseCodexExecOutput("Script failed\nWall time 0.3 seconds\nOutput:\nboom\n");
    expect(failed).toMatchObject({ state: "failed", exit: null, exitFailed: true, output: "boom\n" });
    const running = parseCodexExecOutput("Script running with cell ID 7\nWall time 10.0 seconds\nOutput:\npartial\n");
    expect(running).toMatchObject({ state: "running", cellId: "7", exit: null, output: "partial\n" });
    const numbered = parseCodexExecOutput("Exit code: 2\nWall time: 0.1 seconds\nOutput:\nnope\n");
    expect(numbered).toMatchObject({ state: "unknown", exit: null });
    const raw = parseCodexExecOutput("hello\n");
    expect(raw).toMatchObject({ state: "unknown", exit: null, exitFailed: false, output: "hello\n" });
    expect(parseCodexExecOutput("aborted by user\n").state).toBe("aborted");
  });

  it("lists the files an apply_patch call touches, once each", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-1\n+2\n*** Add File: src/b.ts\n+x\n*** Delete File: old.ts\n*** Update File: src/a.ts\n*** End Patch";
    expect(applyPatchEdits(patch).map((e) => `${e.kind}:${e.path}`)).toEqual(["apply_patch:src/a.ts", "apply_patch:src/b.ts", "apply_patch:old.ts"]);
    expect(applyPatchEdits("nothing here")).toEqual([]);
  });

  it("takes a tool response as a string, an object or content blocks", () => {
    expect(responseText("plain")).toBe("plain");
    expect(responseText({ output: "out", stderr: "err" })).toBe("out\nerr");
    expect(responseText({ stdout: "so" })).toBe("so");
    expect(responseText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("ab");
    expect(responseText(42)).toBe("");
  });
});

describe("Codex PreToolUse", () => {
  it("wraps a verification command and, because Codex needs it, returns allow with the rewrite", () => {
    const out = runCodexHook("PreToolUse", payload("PreToolUse-bash.json"));
    expect(out.exit).toBe(0);
    const body = JSON.parse(out.stdout ?? "{}") as { hookSpecificOutput: { hookEventName: string; permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: { command: string } } };
    expect(body.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(body.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(body.hookSpecificOutput.permissionDecisionReason).toContain("pnpm test");
    expect(body.hookSpecificOutput.updatedInput?.command).toContain("[stalegreen] exit=");
    expect(body.hookSpecificOutput.updatedInput?.command).not.toContain("tail -5");
    const pending = readPending(ROOT());
    expect(pending).toHaveLength(1);
    expect(pending[0]?.wrappedCommand).toBe(body.hookSpecificOutput.updatedInput?.command);
  });

  it("does not rewrite when the config says ask, since Codex rejects a rewrite without allow", () => {
    writeFileSync(join(repo.dir, ".stalegreen.json"), JSON.stringify({ permission: "ask", fingerprintBudgetMs: 5000 }));
    const out = runCodexHook("PreToolUse", payload("PreToolUse-bash.json"));
    expect(out.stdout).toBeUndefined();
    expect(readPending(ROOT())[0]?.unwrapped).toBe("no-allow");
  });

  it("denies an unwrappable masked run in strict mode and leaves plan mode alone", () => {
    writeFileSync(join(repo.dir, ".stalegreen.json"), JSON.stringify({ mode: "strict", permission: "ask", fingerprintBudgetMs: 5000 }));
    const out = runCodexHook("PreToolUse", payload("PreToolUse-bash.json"));
    const body = JSON.parse(out.stdout ?? "{}") as { hookSpecificOutput: { permissionDecision?: string } };
    expect(body.hookSpecificOutput.permissionDecision).toBe("deny");
    writeFileSync(join(repo.dir, ".stalegreen.json"), JSON.stringify({ fingerprintBudgetMs: 5000 }));
    const plan = runCodexHook("PreToolUse", payload("PreToolUse-bash.json", { permission_mode: "plan" }));
    expect(plan.stdout).toBeUndefined();
  });

  it("ignores tools other than Bash and commands that are not verification runs", () => {
    expect(runCodexHook("PreToolUse", payload("PreToolUse-bash.json", { tool_name: "apply_patch" })).stdout).toBeUndefined();
    expect(runCodexHook("PreToolUse", payload("PreToolUse-bash.json", { tool_input: { command: "ls -la" } })).stdout).toBeUndefined();
  });
});

describe("Codex PostToolUse", () => {
  it("records a pass from raw output with an unknown exit when the summary is visible", () => {
    expect(runCodexHook("PostToolUse", bashDone("pnpm test", vitestPass)).exit).toBe(0);
    const [r] = readReceipts(ROOT());
    expect(r).toMatchObject({ harness: "codex", category: "test", verdict: "pass", exit: null, masked: false, counts: { passed: 41 } });
    expect(r?.signal).toContain("summary-only");
  });

  it("records a failure from the Script failed header even without a number", () => {
    const fixture = loadHookFixture("PostToolUse-bash-header.json", "codex");
    expect(runCodexHook("PostToolUse", { ...fixture, cwd: repo.dir }).exit).toBe(0);
    const [r] = readReceipts(ROOT());
    expect(r).toMatchObject({ category: "test", verdict: "fail", exit: null, runner: "vitest" });
    expect(r?.counts).toMatchObject({ failed: 1, passed: 1 });
    const silent = runCodexHook("PostToolUse", bashDone("npx tsc --noEmit", "Script failed\nWall time 2.0 seconds\nOutput:\n"));
    expect(silent.exit).toBe(0);
    const tsc = readReceipts(ROOT())[1];
    expect(tsc).toMatchObject({ category: "typecheck", verdict: "fail", signal: "exit-nonzero", exit: null });
  });

  it("reads the true exit from the marker of a wrapped run", () => {
    const pre = runCodexHook("PreToolUse", payload("PreToolUse-bash.json", { tool_input: { command: "npx vitest run | tail -3" } }));
    const wrapped = (JSON.parse(pre.stdout ?? "{}") as { hookSpecificOutput: { updatedInput: { command: string } } }).hookSpecificOutput.updatedInput.command;
    const id = readPending(ROOT())[0]?.id as string;
    const log = readPending(ROOT())[0]?.log as string;
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, vitestFail);
    writeFileSync(`${log}.exit`, "1\n");
    const response = `Script failed\nWall time 4.0 seconds\nOutput:\n${vitestFail.split("\n").slice(-3).join("\n")}\n[stalegreen] exit=1 receipt=${id} lines=40 log=${log}\n`;
    runCodexHook("PostToolUse", bashDone(wrapped, response));
    const [r] = readReceipts(ROOT());
    expect(r).toMatchObject({ id, verdict: "fail", exit: 1, wrapped: true, masked: false });
  });

  it("dates a background run from its start, so an edit made while it ran makes it stale", () => {
    const pre = runCodexHook("PreToolUse", payload("PreToolUse-bash.json", { tool_input: { command: "npx vitest run" } }));
    const wrapped = (JSON.parse(pre.stdout ?? "{}") as { hookSpecificOutput: { updatedInput: { command: string } } }).hookSpecificOutput.updatedInput.command;
    const pending = readPending(ROOT())[0]!;
    runCodexHook("PostToolUse", bashDone(wrapped, "Script running with cell ID 4\nWall time 10.0 seconds\nOutput:\n RUN  v3.2.7\n"));
    expect(readDeferred(ROOT())).toHaveLength(1);
    expect(JSON.parse(runCodexHook("Stop", stopWith("All 41 tests pass.")).stdout ?? "{}")).toEqual({});

    // An edit lands while the run is still going.
    nextMillisecond();
    writeFileSync(repo.file, "export const remaining = 0;\n");
    runCodexHook("PostToolUse", { ...loadHookFixture("PostToolUse-apply-patch.json", "codex"), cwd: repo.dir, tool_input: { command: `*** Begin Patch\n*** Update File: ${repo.file}\n@@\n-1\n+0\n*** End Patch` } });

    // The wrapper's records, as the shell left them, then the wait tool reports the finished run.
    mkdirSync(dirname(pending.log!), { recursive: true });
    writeFileSync(pending.log!, vitestPass);
    writeFileSync(`${pending.log}.exit`, "0\n");
    const done = payload("PostToolUse-bash.json", { tool_name: "wait", tool_input: { cell_id: 4 }, tool_response: `Script completed\nWall time 12.0 seconds\nOutput:\n${vitestPass}\n[stalegreen] exit=0 receipt=${pending.id} lines=12 log=${pending.log}\n` });
    runCodexHook("PostToolUse", done);
    const [receipt] = readReceipts(ROOT());
    expect(receipt).toMatchObject({ id: pending.id, verdict: "pass", exit: 0, background: true, wrapped: true, ts: pending.ts });
    expect(receipt?.fingerprint).toMatchObject({ available: false, reason: "background" });
    const stop = JSON.parse(runCodexHook("Stop", stopWith("All 41 tests pass.")).stdout ?? "{}") as { decision?: string; reason?: string };
    expect(stop.decision).toBe("block");
    expect(stop.reason).toContain("is stale");
    expect(stop.reason).toContain("hold.ts");
  });

  it("defers a run that is still going and finishes it from the wait tool's output", () => {
    runCodexHook("PostToolUse", bashDone("npx vitest run", "Script running with cell ID 3\nWall time 10.0 seconds\nOutput:\n RUN  v3.2.7\n"));
    expect(readReceipts(ROOT())).toHaveLength(0);
    const deferred = readDeferred(ROOT());
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ category: "test", runner: "vitest", cellId: "3", command: "npx vitest run" });
    const stillRunning = payload("PostToolUse-bash.json", { tool_name: "wait", tool_input: { cell_id: 3, yield_time_ms: 5000 }, tool_response: "Script running with cell ID 3\nWall time 5.0 seconds\nOutput:\n" });
    runCodexHook("PostToolUse", stillRunning);
    expect(readReceipts(ROOT())).toHaveLength(0);
    const done = payload("PostToolUse-bash.json", { tool_name: "wait", tool_input: { cell_id: 3 }, tool_response: `Script completed\nWall time 12.0 seconds\nOutput:\n${vitestPass}` });
    runCodexHook("PostToolUse", done);
    const [r] = readReceipts(ROOT());
    expect(r).toMatchObject({ category: "test", verdict: "pass", exit: 0, background: true, counts: { passed: 41 } });
    expect(readDeferred(ROOT())).toHaveLength(0);
    expect(readJsonl<{ resolved?: boolean }>(join(sessionDir(ROOT()), "deferred.jsonl")).some((d) => d.resolved)).toBe(true);
  });

  it("records apply_patch edits per file and shell edits from the command", () => {
    const patch = loadHookFixture("PostToolUse-apply-patch.json", "codex");
    runCodexHook("PostToolUse", { ...patch, cwd: repo.dir });
    runCodexHook("PostToolUse", bashDone("sed -i 's/a/b/' src/lib/other.ts", ""));
    const edits = readEdits(ROOT());
    expect(edits.map((e) => `${e.kind}:${e.path}`)).toEqual(["apply_patch:src/lib/hold.ts", "apply_patch:src/lib/new.ts", "sed:src/lib/other.ts"]);
  });

  it("ignores read-only commands and records an unreadable response as inconclusive", () => {
    runCodexHook("PostToolUse", bashDone("sed -n '1,40p' README.md", "# hi\n"));
    expect(readReceipts(ROOT())).toHaveLength(0);
    expect(readEdits(ROOT())).toHaveLength(0);
    runCodexHook("PostToolUse", bashDone("pnpm test", 12));
    const [r] = readReceipts(ROOT());
    expect(r).toMatchObject({ category: "test", verdict: "inconclusive", exit: null });
  });
});

describe("Codex Stop", () => {
  it("blocks a stale claim with a decision object, once per turn, and lets the next turn through", () => {
    runCodexHook("PostToolUse", bashDone("npx vitest run", `Script completed\nWall time 1.0 seconds\nOutput:\n${vitestPass}`));
    const fresh = runCodexHook("Stop", stopWith("All 41 tests pass."));
    expect(fresh).toEqual({ exit: 0 });

    writeFileSync(repo.file, "export const remaining = 0;\n");
    runCodexHook("PostToolUse", { ...loadHookFixture("PostToolUse-apply-patch.json", "codex"), cwd: repo.dir, tool_input: { command: `*** Begin Patch\n*** Update File: ${repo.file}\n@@\n-1\n+0\n*** End Patch` } });
    const stale = runCodexHook("Stop", stopWith("All 41 tests pass."));
    expect(stale.exit).toBe(0);
    expect(stale.stderr).toBeUndefined();
    const body = JSON.parse(stale.stdout ?? "{}") as { decision: string; reason: string };
    expect(body.decision).toBe("block");
    expect(body.reason).toContain("stale");
    expect(body.reason).toContain("r-0001");
    expect(body.reason).toContain("hold.ts");

    const again = runCodexHook("Stop", stopWith("All 41 tests pass.", { stop_hook_active: true }));
    expect(again).toEqual({ exit: 0 });
    const verdicts = readVerdicts(ROOT());
    expect(verdicts.map((v) => v.blocked)).toEqual([false, true, false]);
    expect(verdicts[2]?.verdicts[0]?.note).toContain("allowed_after_block");

    const nextTurn = runCodexHook("Stop", stopWith("All 41 tests pass.", { turn_id: "019a0000-0000-7000-8000-00000000cccc" }));
    expect(JSON.parse(nextTurn.stdout ?? "{}")).toMatchObject({ decision: "block" });
  });

  it("handles SubagentStop under the agent's own turn state", () => {
    const sub = runCodexHook("SubagentStop", payload("SubagentStop.json", { last_assistant_message: "All 41 tests pass." }));
    expect(sub).toEqual({ exit: 0 });
    const recs = readVerdicts(ROOT());
    expect(recs).toHaveLength(1);
    expect(recs[0]?.agent).toBe("019a0000-0000-7000-8000-00000000bbbb");
    expect(recs[0]?.verdicts[0]?.verdict).toBe("NONE");
  });

  it("stays quiet without a message or a claim, and fails open on junk", () => {
    expect(runCodexHook("Stop", stopWith(""))).toEqual({ exit: 0 });
    expect(runCodexHook("Stop", stopWith("Working on it."))).toEqual({ exit: 0 });
    expect(runCodexHook("Nope", stopWith("All tests pass."))).toEqual({ exit: 0 });
    expect(runCodexHook("Stop", "garbage")).toEqual({ exit: 0 });
  });
});

describe("Codex session store", () => {
  it("keys the session on session_id when the transcript path is null", () => {
    const s = deriveSession(loadHookFixture("Stop.json", "codex"));
    expect(s).toEqual({ root: "019a0000-0000-7000-8000-000000000001", agent: null });
    runCodexHook("PostToolUse", bashDone("pnpm test", vitestPass));
    expect(readFileSync(join(sessionDir(s.root), "receipts.jsonl"), "utf8")).toContain('"harness":"codex"');
  });
});
