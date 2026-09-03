import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runClaudeHook } from "../src/harness/claude/hooks.js";
import { readReceipts, readVerdicts, readEdits, readDeferred } from "../src/core/receipts.js";
import { deriveSession, sessionDir } from "../src/core/store.js";
import { loadHookFixture, makeHome, makeRepo, readFixture, type TempRepo } from "./helpers.js";

let repo: TempRepo;
let home: { home: string; cleanup: () => void };
const SESSION = "5f1c9d2e-4a7b-4c1d-9e2f-1a2b3c4d5e6f";

function payload(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const p = loadHookFixture(name);
  p.cwd = repo.dir;
  p.transcript_path = (p.transcript_path as string).replace("/home/dev/.claude/projects/-home-dev-app", join(home.home, "projects"));
  return { ...p, ...overrides };
}

function bashDone(command: string, stdout: string, exit: number | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return payload("PostToolUse-bash.json", {
    tool_input: { command },
    tool_response: { stdout, stderr: "", interrupted: false, ...(exit === null ? {} : { exit_code: exit }) },
    ...extra,
  });
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
const pytestPass = readFixture("runner-output", "pytest-pass.txt");

describe("freshness gate end to end", () => {
  it("allows a fresh pass, blocks after an edit naming the receipt and the file, then applies the loop guard", () => {
    const post = runClaudeHook("PostToolUse", bashDone("npx vitest run", vitestPass, 0));
    expect(post.exit).toBe(0);
    const receipts = readReceipts(SESSION);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ id: "r-0001", category: "test", verdict: "pass", scope: "all", counts: { passed: 41 }, masked: false, exit: 0 });
    expect(receipts[0]!.fingerprint.available).toBe(true);

    const fresh = runClaudeHook("Stop", stopWith("All 41 tests pass."));
    expect(fresh.exit).toBe(0);

    // The agent edits a file: the Edit hook fires and the working tree changes.
    writeFileSync(repo.file, "export const remaining = 0;\n");
    const edit = runClaudeHook("PostToolUse", payload("PostToolUse-edit.json", { tool_input: { file_path: repo.file, old_string: "1", new_string: "0" } }));
    expect(edit.exit).toBe(0);
    expect(readEdits(SESSION)).toHaveLength(1);

    const stale = runClaudeHook("Stop", stopWith("All 41 tests pass."));
    expect(stale.exit).toBe(2);
    expect(stale.stderr).toContain("r-0001");
    expect(stale.stderr).toContain("hold.ts");
    expect(stale.stderr).toContain("npx vitest run");
    expect(stale.stderr).toMatch(/is stale/);
    expect(stale.stderr).toMatch(/Rerun `npx vitest run`/);

    const verdicts = readVerdicts(SESSION);
    expect(verdicts.at(-1)?.blocked).toBe(true);
    expect(verdicts.at(-1)?.verdicts[0]).toMatchObject({ verdict: "STALE", action: "blocked", claim: { category: "test", scope: "all" } });

    // Second stop in the same turn: allowed and recorded.
    const again = runClaudeHook("Stop", stopWith("All 41 tests pass.", { stop_hook_active: true }));
    expect(again.exit).toBe(0);
    expect(readVerdicts(SESSION).at(-1)?.verdicts[0]).toMatchObject({ verdict: "STALE", action: "allowed", note: expect.stringContaining("allowed_after_block") });

    // A new turn blocks again.
    const nextTurn = runClaudeHook("Stop", stopWith("All 41 tests pass.", { prompt_id: "another-prompt" }));
    expect(nextTurn.exit).toBe(2);

    // Rerunning the tests after the edit makes the claim fresh again.
    runClaudeHook("PostToolUse", bashDone("npx vitest run", vitestPass, 0));
    const rerun = runClaudeHook("Stop", stopWith("All 41 tests pass.", { prompt_id: "third-prompt" }));
    expect(rerun.exit).toBe(0);
  });

  it("does not turn evidence stale when the agent only commits", () => {
    runClaudeHook("PostToolUse", bashDone("npx vitest run", vitestPass, 0));
    writeFileSync(repo.file, "export const remaining = 2;\n");
    runClaudeHook("PostToolUse", bashDone("npx vitest run", vitestPass, 0));
    runClaudeHook("PostToolUse", bashDone("git add -A && git commit -q -m wip", "", 0));
    execFileSync("git", ["add", "-A"], { cwd: repo.dir });
    execFileSync("git", ["commit", "-q", "-m", "wip"], { cwd: repo.dir });
    expect(runClaudeHook("Stop", stopWith("All tests pass.")).exit).toBe(0);
  });

  it("ignores documentation edits", () => {
    runClaudeHook("PostToolUse", bashDone("npx vitest run", vitestPass, 0));
    writeFileSync(join(repo.dir, "README.md"), "# demo\n\nMore words.\n");
    runClaudeHook("PostToolUse", payload("PostToolUse-edit.json", { tool_input: { file_path: join(repo.dir, "README.md") } }));
    expect(runClaudeHook("Stop", stopWith("All tests pass.")).exit).toBe(0);
  });

  it("blocks a claim contradicted by a failing run with the counts", () => {
    runClaudeHook("PostToolUse", bashDone("npx vitest run", vitestFail, 1));
    const r = runClaudeHook("Stop", stopWith("Tests pass."));
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("2 failed");
    expect(r.stderr).toContain("39 passed");
    expect(r.stderr).toMatch(/does not match the latest run/);
  });

  it("blocks a masked, unwrapped run with the rerun instruction", () => {
    runClaudeHook("PostToolUse", bashDone("pytest -q 2>&1 | tail -3", "tests/test_holds.py ....\n", 0));
    const receipts = readReceipts(SESSION);
    expect(receipts[0]).toMatchObject({ masked: true, verdict: "inconclusive", exit: null });
    const r = runClaudeHook("Stop", stopWith("All tests pass."));
    expect(r.exit).toBe(2);
    expect(r.stderr).toMatch(/no recorded result/);
    expect(r.stderr).toMatch(/pipe into tail/);
    expect(r.stderr).toMatch(/without the pipe/);
  });

  it("allows a claim with no receipt by default and blocks it in strict mode", () => {
    expect(runClaudeHook("Stop", stopWith("All tests pass.")).exit).toBe(0);
    expect(readVerdicts(SESSION).at(-1)?.verdicts[0]).toMatchObject({ verdict: "NONE", action: "allowed" });
    writeFileSync(join(repo.dir, ".stalegreen.json"), JSON.stringify({ strictNoEvidence: true }));
    const strict = runClaudeHook("Stop", stopWith("All tests pass.", { prompt_id: "p2" }));
    expect(strict.exit).toBe(2);
    expect(strict.stderr).toMatch(/no verification run in this session/);
  });

  it("records advisory verdicts without blocking", () => {
    writeFileSync(join(repo.dir, ".stalegreen.json"), JSON.stringify({ policy: "advisory" }));
    runClaudeHook("PostToolUse", bashDone("npx vitest run", vitestFail, 1));
    const r = runClaudeHook("Stop", stopWith("Tests pass."));
    expect(r.exit).toBe(0);
    expect(readVerdicts(SESSION).at(-1)?.verdicts[0]).toMatchObject({ verdict: "FAILED", action: "advisory" });
  });

  it("never blocks a qualified claim", () => {
    runClaudeHook("PostToolUse", bashDone("npx vitest run", vitestFail, 1));
    const r = runClaudeHook("Stop", stopWith("Apart from the two known snapshot mismatches, tests pass."));
    expect(r.exit).toBe(0);
    expect(readVerdicts(SESSION).at(-1)?.verdicts[0]).toMatchObject({ verdict: "FAILED", action: "allowed", claim: { qualified: true } });
  });

  it("treats a background verification run as deferred", () => {
    runClaudeHook("PostToolUse", bashDone("npx vitest run", "Command running in background with ID: bash_1\n", null, { tool_input: { command: "npx vitest run", run_in_background: true } }));
    expect(readDeferred(SESSION)).toHaveLength(1);
    const r = runClaudeHook("Stop", stopWith("All tests pass."));
    expect(r.exit).toBe(0);
    expect(readVerdicts(SESSION).at(-1)?.verdicts[0]).toMatchObject({ verdict: "DEFERRED", action: "allowed" });
  });

  it("stores subagent receipts under the parent session and uses them for the parent's claim", () => {
    const sub = payload("PostToolUse-subagent-bash.json");
    const r = runClaudeHook("PostToolUse", sub);
    expect(r.exit).toBe(0);
    const ref = deriveSession(sub);
    expect(ref).toEqual({ root: SESSION, agent: "a1b2c3d4" });
    const receipts = readReceipts(SESSION);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ category: "typecheck", verdict: "pass", agent: "a1b2c3d4" });
    expect(runClaudeHook("Stop", stopWith("tsc is clean.")).exit).toBe(0);
    writeFileSync(repo.file, "export const remaining = 3;\n");
    const stale = runClaudeHook("Stop", stopWith("tsc is clean.", { prompt_id: "p2" }));
    expect(stale.exit).toBe(2);
    expect(stale.stderr).toContain("npx tsc --noEmit");
    expect(runClaudeHook("SubagentStop", payload("SubagentStop.json", { last_assistant_message: "tsc is clean.", prompt_id: "p3" })).exit).toBe(2);
  });

  it("does not let a subset run satisfy an all-tests claim, but lets it satisfy a plain claim", () => {
    runClaudeHook("PostToolUse", bashDone("pytest tests/test_holds.py", pytestPass, 0));
    expect(readReceipts(SESSION)[0]).toMatchObject({ scope: "subset" });
    const all = runClaudeHook("Stop", stopWith("All tests pass."));
    expect(all.exit).toBe(0);
    expect(readVerdicts(SESSION).at(-1)?.verdicts[0]).toMatchObject({ verdict: "NONE", note: expect.stringContaining("subset") });
    const some = runClaudeHook("Stop", stopWith("Tests pass.", { prompt_id: "p2" }));
    expect(some.exit).toBe(0);
    expect(readVerdicts(SESSION).at(-1)?.verdicts[0]).toMatchObject({ verdict: "FRESH" });
  });

  it("uses a newer failing subset against an older full pass", () => {
    runClaudeHook("PostToolUse", bashDone("npx vitest run", vitestPass, 0));
    runClaudeHook("PostToolUse", bashDone("npx vitest run src/routes/pay.test.ts", vitestFail, 1));
    const r = runClaudeHook("Stop", stopWith("All tests pass."));
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("r-0002");
  });

  it("records edit events for sed -i, shell redirects and git operations", () => {
    runClaudeHook("PostToolUse", bashDone("sed -i '' 's/1/2/' hold.ts", "", 0));
    runClaudeHook("PostToolUse", bashDone("echo hi > notes.txt", "", 0));
    runClaudeHook("PostToolUse", bashDone("git checkout -- hold.ts", "", 0));
    runClaudeHook("PostToolUse", bashDone("cat hold.ts", "", 0));
    const kinds = readEdits(SESSION).map((e) => `${e.kind}:${e.path ?? ""}`);
    expect(kinds).toEqual(["sed:hold.ts", "redirect:notes.txt", "git checkout:hold.ts"]);
  });

  it("writes a run log next to the receipt", () => {
    runClaudeHook("PostToolUse", bashDone("npx vitest run", vitestPass, 0));
    const r = readReceipts(SESSION)[0]!;
    expect(r.log).toBe(join(sessionDir(SESSION), "runs", "r-0001.log"));
    expect(readFileSync(r.log!, "utf8")).toContain("41 passed");
  });

  it("joins a wrapped run through the marker line to its pending record", () => {
    runClaudeHook("PreToolUse", payload("PreToolUse-bash.json", { tool_input: { command: "pnpm test" } }));
    const logDir = join(sessionDir(SESSION), "runs");
    mkdirSync(logDir, { recursive: true });
    const log = join(logDir, "r-0001.log");
    writeFileSync(log, vitestFail);
    const stdout = `${vitestFail.split("\n").slice(-4).join("\n")}\n[stalegreen] exit=1 receipt=r-0001 lines=14 log=${log}\n`;
    runClaudeHook("PostToolUse", bashDone("wrapped-command-text", stdout, 0));
    const r = readReceipts(SESSION)[0]!;
    expect(r).toMatchObject({ id: "r-0001", wrapped: true, exit: 1, verdict: "fail", runner: "pnpm test", cmd: "pnpm test", counts: { failed: 2, passed: 39 } });
  });

  it("ignores messages without claims and payloads without a message", () => {
    expect(runClaudeHook("Stop", stopWith("I refactored the hold module and added two tests.")).exit).toBe(0);
    expect(runClaudeHook("Stop", payload("Stop.json", { last_assistant_message: undefined })).exit).toBe(0);
    expect(readVerdicts(SESSION)).toHaveLength(0);
  });

  it("survives malformed input shapes", () => {
    expect(runClaudeHook("PostToolUse", { tool_name: "Bash", tool_input: { command: 42 } }).exit).toBe(0);
    expect(runClaudeHook("PostToolUse", { tool_name: "Bash", tool_input: { command: "npx vitest run" }, tool_response: "plain string output" }).exit).toBe(0);
    expect(runClaudeHook("Stop", { last_assistant_message: 12 }).exit).toBe(0);
    expect(runClaudeHook("Nope", {}).exit).toBe(0);
    expect(runClaudeHook("Stop", null).exit).toBe(0);
  });
});

describe("hook contract fixtures", () => {
  const required: Record<string, string[]> = {
    "PreToolUse-bash.json": ["session_id", "transcript_path", "cwd", "hook_event_name", "tool_name", "tool_input.command", "tool_use_id"],
    "PostToolUse-bash.json": ["session_id", "transcript_path", "cwd", "hook_event_name", "tool_name", "tool_input.command", "tool_use_id", "tool_response.stdout", "tool_response.exit_code"],
    "PostToolUse-edit.json": ["tool_name", "tool_input.file_path"],
    "Stop.json": ["session_id", "transcript_path", "cwd", "hook_event_name", "stop_hook_active", "last_assistant_message"],
    "SubagentStop.json": ["agent_id", "transcript_path", "last_assistant_message"],
  };
  for (const [file, fields] of Object.entries(required)) {
    it(`${file} carries the fields the hooks depend on (Claude Code hooks reference, 2026-09)`, () => {
      const p = loadHookFixture(file);
      for (const f of fields) {
        const value = f.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), p);
        expect(value, `${file}: field ${f} missing; the Claude Code hook schema (2026-09) changed`).not.toBeUndefined();
      }
    });
  }
});
