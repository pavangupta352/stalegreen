import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runClaudeHook } from "../src/harness/claude/hooks.js";
import { readReceipts, readVerdicts, readEdits, readDeferred } from "../src/core/receipts.js";
import { deriveSession, readJsonl, sessionDir } from "../src/core/store.js";
import { loadHookFixture, makeHome, makeRepo, nextMillisecond, readFixture, type TempRepo } from "./helpers.js";

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

  it("lets a fully visible summary stand in for a hidden exit status, but not a filtered one", () => {
    runClaudeHook("PostToolUse", bashDone("npx vitest run 2>&1 | tail -20", vitestPass, 0));
    expect(readReceipts(SESSION)[0]).toMatchObject({ masked: true, exit: null, verdict: "pass", signal: "summary-only:vitest-passed" });
    expect(runClaudeHook("Stop", stopWith("All 41 tests pass.")).exit).toBe(0);
    runClaudeHook("PostToolUse", bashDone("npx vitest run 2>&1 | grep -c passed", "1\n", 0));
    expect(readReceipts(SESSION)[1]).toMatchObject({ masked: true, verdict: "inconclusive" });
    expect(runClaudeHook("Stop", stopWith("All 41 tests pass.", { prompt_id: "p2" })).exit).toBe(2);
    runClaudeHook("PostToolUse", bashDone("npx tsc --noEmit 2>&1 | tail -20", "", 0));
    expect(readReceipts(SESSION)[2]).toMatchObject({ category: "typecheck", masked: true, verdict: "pass", signal: "silent-through-pipe" });
    // Through `tail -1`, empty output means nothing was printed at all; a lone blank line could hide a summary.
    runClaudeHook("PostToolUse", bashDone("npx tsc --noEmit 2>&1 | tail -1", "\n", 0));
    expect(readReceipts(SESSION)[3]).toMatchObject({ verdict: "inconclusive" });
    runClaudeHook("PostToolUse", bashDone("npx vitest run 2>&1 | tail -20", vitestFail, 0));
    expect(readReceipts(SESSION)[4]).toMatchObject({ masked: true, exit: null, verdict: "fail" });
    // A head that shows fewer lines than its limit showed everything.
    runClaudeHook("PostToolUse", bashDone("npx tsc --noEmit 2>&1 | head -20", "", 0));
    expect(readReceipts(SESSION)[5]).toMatchObject({ category: "typecheck", verdict: "pass", signal: "silent-through-pipe" });
    runClaudeHook("PostToolUse", bashDone("npx vitest run 2>&1 | head -3", " RUN v3\n\n ✓ a.test.ts (1 test)\n", 0));
    expect(readReceipts(SESSION)[6]).toMatchObject({ verdict: "inconclusive" });
    // One-line summaries are trusted through a filter; silence is not.
    runClaudeHook("PostToolUse", bashDone("pytest -q 2>&1 | grep -E 'passed|failed'", "========= 41 passed in 1.20s =========\n", 0));
    expect(readReceipts(SESSION)[7]).toMatchObject({ verdict: "pass", signal: "summary-line:pytest-passed" });
    runClaudeHook("PostToolUse", bashDone("go test ./... 2>&1 | grep ok", "ok  \texample.com/app/holds\t0.412s\n", 0));
    expect(readReceipts(SESSION)[8]).toMatchObject({ verdict: "inconclusive" });
    // Searching a silent-success tool's output for errors and finding none is a result.
    runClaudeHook("PostToolUse", bashDone("npx eslint . 2>&1 | grep error", "", 0));
    expect(readReceipts(SESSION)[9]).toMatchObject({ verdict: "pass", signal: "grep-empty" });
  });

  it("attributes the output of a compound command to its segments", () => {
    const output = ["=== tsc ===", "", "> app@0.1.0 test", "> vitest run", "", " RUN  v3.2.7 /work/app", "", " Test Files  2 passed (2)", "      Tests  41 passed (41)", "   Duration  412ms", "=== lint ===", ""].join("\n");
    runClaudeHook("PostToolUse", bashDone('echo "=== tsc ==="; npx tsc --noEmit 2>&1 | head -20; npm test 2>&1 | tail -5; echo "=== lint ==="; npx eslint . 2>&1 | head -20', output, 0));
    const receipts = readReceipts(SESSION);
    expect(receipts.map((r) => `${r.category}:${r.verdict}:${r.signal}`)).toEqual(["typecheck:pass:silent-through-pipe", "test:pass:summary-only:vitest-passed", "lint:pass:silent-through-pipe"]);
    expect(receipts[1]?.counts).toEqual({ passed: 41, total: 41 });
    expect(receipts[0]?.counts).toEqual({});
    // Without anchors the tsc segment shares the output; a head of twenty lines would still have shown a tsc error, so it passes.
    runClaudeHook("PostToolUse", bashDone("npx tsc --noEmit 2>&1 | head -20; npx eslint . 2>&1 | tail -20", "src/a.ts:1:1  error  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)\n", 0));
    expect(readReceipts(SESSION).slice(3).map((r) => `${r.category}:${r.verdict}:${r.signal}`)).toEqual(["typecheck:pass:head-no-errors", "lint:fail:eslint-problems"]);
    runClaudeHook("PostToolUse", bashDone("npx tsc --noEmit 2>&1 | head -20; npx eslint . 2>&1 | tail -20", "src/a.ts(1,1): error TS2322: nope\n\n✖ 1 problem (1 error, 0 warnings)\n", 0));
    expect(readReceipts(SESSION).slice(5).map((r) => `${r.category}:${r.verdict}`)).toEqual(["typecheck:fail", "lint:fail"]);
  });

  it("recovers the exit status the agent printed itself", () => {
    runClaudeHook("PostToolUse", bashDone('npx tsc --noEmit; echo "=== tsc exit: $? ==="', "=== tsc exit: 0 ===\n", 0));
    expect(readReceipts(SESSION)[0]).toMatchObject({ category: "typecheck", exit: 0, verdict: "pass", signal: "exit-0+exit-from-echo" });
    runClaudeHook("PostToolUse", bashDone('npx tsc --noEmit; echo "=== tsc exit: $? ==="', "src/a.ts(1,1): error TS2322: nope\n=== tsc exit: 2 ===\n", 0));
    expect(readReceipts(SESSION)[1]).toMatchObject({ exit: 2, verdict: "fail" });
    runClaudeHook("PostToolUse", bashDone('npm run build 2>&1 | tail -15; echo "EXIT:${PIPESTATUS[0]}"', "\n> app@1.0.0 build\n> next build\n\n ✓ Compiled successfully in 3s\nEXIT:0\n", 0));
    expect(readReceipts(SESSION)[2]).toMatchObject({ category: "build", exit: 0, verdict: "pass" });
    // A bare $? after a pipe is the pipe's status, not the runner's.
    runClaudeHook("PostToolUse", bashDone('npx vitest run 2>&1 | tail -5; echo "exit=$?"', " Tests  3 passed (3)\nexit=0\n", 0));
    expect(readReceipts(SESSION)[3]).toMatchObject({ exit: null, verdict: "pass", signal: "summary-only:vitest-passed" });
    runClaudeHook("PostToolUse", bashDone('npx tsc --noEmit; echo "=== tsc exit: $? ==="', "something else entirely\n", 0));
    expect(readReceipts(SESSION)[4]).toMatchObject({ exit: null, verdict: "inconclusive" });
  });

  it("reads error counts and empty error searches as results for silent-success tools", () => {
    runClaudeHook("PostToolUse", bashDone('pnpm lint 2>&1 | grep -cE " error " | xargs echo "lint errors:"', "lint errors: 0\n", 0));
    expect(readReceipts(SESSION)[0]).toMatchObject({ category: "lint", verdict: "pass", signal: "count-zero" });
    runClaudeHook("PostToolUse", bashDone('pnpm lint 2>&1 | grep -cE " error " | xargs echo "lint errors:"', "lint errors: 4\n", 0));
    expect(readReceipts(SESSION)[1]).toMatchObject({ verdict: "fail", signal: "count-nonzero" });
    runClaudeHook("PostToolUse", bashDone('npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "error TS" | grep -v "__tests__"', "", 0));
    expect(readReceipts(SESSION)[2]).toMatchObject({ category: "typecheck", verdict: "pass", signal: "grep-empty", scope: "all" });
    runClaudeHook("PostToolUse", bashDone('npx tsc --noEmit 2>&1 | grep -E "error TS" | head -20', "src/a.ts(1,1): error TS2322: nope\n", 0));
    expect(readReceipts(SESSION)[3]).toMatchObject({ verdict: "fail" });
    // Searching for something other than errors proves nothing when it finds nothing.
    runClaudeHook("PostToolUse", bashDone('npx tsc --noEmit 2>&1 | grep -E "hold.ts"', "", 0));
    expect(readReceipts(SESSION)[4]).toMatchObject({ verdict: "inconclusive" });
    runClaudeHook("PostToolUse", bashDone('npx vitest run 2>&1 | grep -c FAIL', "0\n", 0));
    expect(readReceipts(SESSION)[5]).toMatchObject({ category: "test", verdict: "inconclusive" });
  });

  it("trusts a head or an error search of a typecheck or lint tool when no error line is visible", () => {
    runClaudeHook("PostToolUse", bashDone('echo "=== gates ==="; npx tsc --noEmit 2>&1 | head -5; npx vitest run 2>&1 | tail -3', "=== gates ===\n\n Test Files  2 passed (2)\n      Tests  41 passed (41)\n   Duration  412ms\n", 0));
    const receipts = readReceipts(SESSION);
    expect(receipts[0]).toMatchObject({ category: "typecheck", verdict: "pass", signal: "head-no-errors" });
    expect(receipts[1]).toMatchObject({ category: "test", verdict: "pass" });
    // Without anchors the tsc chunk still holds the test output; a head of five lines would have shown an error.
    runClaudeHook("PostToolUse", bashDone("npx tsc --noEmit 2>&1 | head -5; npx vitest run 2>&1 | tail -3", " Test Files  2 passed (2)\n      Tests  41 passed (41)\n   Duration  412ms\n", 0));
    expect(readReceipts(SESSION)[2]).toMatchObject({ category: "typecheck", verdict: "pass", signal: "head-no-errors" });
    runClaudeHook("PostToolUse", bashDone("npx tsc --noEmit 2>&1 | head -5; npx vitest run 2>&1 | tail -3", "src/a.ts(1,1): error TS2322: nope\n Tests  41 passed (41)\n", 0));
    expect(readReceipts(SESSION)[4]).toMatchObject({ category: "typecheck", verdict: "fail" });
    runClaudeHook("PostToolUse", bashDone('npx eslint src 2>&1 | grep -E "error|warning" | grep -v "generated" | head -20; npx vitest run 2>&1 | tail -3', " Test Files  2 passed (2)\n      Tests  41 passed (41)\n   Duration  412ms\n", 0));
    expect(readReceipts(SESSION)[6]).toMatchObject({ category: "lint", verdict: "pass", signal: "grep-no-errors" });
    expect(readReceipts(SESSION)[7]).toMatchObject({ category: "test", verdict: "pass" });
    runClaudeHook("PostToolUse", bashDone('npx tsc --noEmit 2>&1 | head -1', "", 0));
    expect(readReceipts(SESSION)[8]).toMatchObject({ verdict: "pass", signal: "silent-through-pipe" });
    runClaudeHook("PostToolUse", bashDone('npx tsc --noEmit 2>&1 | head -1; npx vitest run 2>&1 | tail -3', " Tests  41 passed (41)\n Duration 412ms\n", 0));
    expect(readReceipts(SESSION)[9]).toMatchObject({ category: "typecheck", verdict: "inconclusive" });
    // Counts inside a parenthesised group still read.
    runClaudeHook("PostToolUse", bashDone('(cd app && pnpm lint 2>&1 | grep -cE " error " | xargs echo "lint errors:") && echo ok', "lint errors: 0\nok\n", 0));
    expect(readReceipts(SESSION)[11]).toMatchObject({ category: "lint", verdict: "pass", signal: "count-zero" });
  });

  it("prefers the run of the tool a claim names", () => {
    runClaudeHook("PostToolUse", bashDone("ruff check src", "All checks passed!\n", 0));
    runClaudeHook("PostToolUse", bashDone("npm run lint", "\n> app@1.0.0 lint\n> eslint .\n\n", 0));
    writeFileSync(repo.file, "export const remaining = 5;\n");
    runClaudeHook("PostToolUse", bashDone("ruff check src", "All checks passed!\n", 0));
    // The JavaScript lint is stale, the ruff run is fresh.
    expect(runClaudeHook("Stop", stopWith("ruff is clean.")).exit).toBe(0);
    expect(readVerdicts(SESSION).at(-1)?.verdicts[0]?.evidence?.receipt).toBe("r-0003");
    const stale = runClaudeHook("Stop", stopWith("eslint is clean.", { prompt_id: "p2" }));
    expect(stale.exit).toBe(2);
    expect(stale.stderr).toContain("r-0002");
  });

  it("treats a redirect read back in the same command as visible output", () => {
    runClaudeHook("PostToolUse", bashDone('npm test > /tmp/sg-same.out 2>&1; echo "REAL exit: $?"; tail -4 /tmp/sg-same.out', "REAL exit: 0\n\n Test Files  2 passed (2)\n      Tests  41 passed (41)\n   Duration  412ms\n", 0));
    expect(readReceipts(SESSION)[0]).toMatchObject({ category: "test", exit: 0, verdict: "pass", counts: { passed: 41 } });
    runClaudeHook("PostToolUse", bashDone('npm test > /tmp/sg-same2.out 2>&1; tail -4 /tmp/sg-same2.out', "\n Test Files  1 failed | 1 passed (2)\n      Tests  2 failed | 39 passed (41)\n   Duration  455ms\n", 0));
    expect(readReceipts(SESSION)[1]).toMatchObject({ exit: null, verdict: "fail", counts: { failed: 2 } });
  });

  it("uses a later read of a redirected log as the run's output", () => {
    runClaudeHook("PostToolUse", bashDone("npm test > /tmp/sg-test.out 2>&1; echo done", "done\n", 0));
    const first = readReceipts(SESSION)[0]!;
    expect(first).toMatchObject({ verdict: "inconclusive", masked: true, logFile: "/tmp/sg-test.out" });
    expect(runClaudeHook("Stop", stopWith("All 41 tests pass.")).exit).toBe(2);
    runClaudeHook("PostToolUse", bashDone("tail -30 /tmp/sg-test.out", vitestPass, 0));
    const read = readReceipts(SESSION)[1]!;
    expect(read).toMatchObject({ id: "r-0002", verdict: "pass", cmd: "npm test > /tmp/sg-test.out 2>&1", runner: "npm test", category: "test", counts: { passed: 41 }, signal: "log-read:summary-only:vitest-passed", maskReason: "redirect:/tmp/sg-test.out,semicolon,read" });
    expect(runClaudeHook("Stop", stopWith("All 41 tests pass.", { prompt_id: "p2" })).exit).toBe(0);
    runClaudeHook("PostToolUse", bashDone("npm test > /tmp/sg-test.out 2>&1; echo done", "done\n", 0));
    runClaudeHook("PostToolUse", bashDone("grep -c passed /tmp/sg-test.out", "1\n", 0));
    expect(readReceipts(SESSION)).toHaveLength(3);
    runClaudeHook("PostToolUse", bashDone("cat /tmp/sg-test.out", vitestFail, 0));
    expect(readReceipts(SESSION)[3]).toMatchObject({ verdict: "fail", counts: { failed: 2 } });
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
    writeFileSync(`${log}.exit`, "1\n");
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

describe("PreToolUse rewrite", () => {
  function pre(command: string, overrides: Record<string, unknown> = {}) {
    return runClaudeHook("PreToolUse", payload("PreToolUse-bash.json", { tool_input: { command, description: "Run", timeout: 120000 }, ...overrides }));
  }
  function output(r: { stdout?: string }): { hookSpecificOutput: Record<string, unknown> } {
    return JSON.parse(r.stdout ?? "{}") as { hookSpecificOutput: Record<string, unknown> };
  }

  it("returns updatedInput with the wrapped command and keeps the other input fields", () => {
    const r = pre("pnpm test | tail -5");
    expect(r.exit).toBe(0);
    const out = output(r).hookSpecificOutput;
    expect(out.hookEventName).toBe("PreToolUse");
    const updated = out.updatedInput as Record<string, unknown>;
    expect(updated.description).toBe("Run");
    expect(updated.timeout).toBe(120000);
    expect(updated.command).toContain("{ pnpm test ; }");
    expect(updated.command).not.toContain("| tail");
    expect(updated.command).toContain("receipt=r-0001");
    expect(out.permissionDecision).toBeUndefined();
    const pending = readJsonl<{ id: string; wrappedCommand: string | null }>(join(sessionDir(SESSION), "pending.jsonl"));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: "r-0001" });
    expect(pending[0]?.wrappedCommand).toBe(updated.command);
  });

  it("leaves non-runners, watch modes, background runs and mode off alone", () => {
    expect(pre("git status").stdout).toBeUndefined();
    expect(pre("npx vitest --watch").stdout).toBeUndefined();
    expect(pre("pnpm test", { tool_input: { command: "pnpm test", run_in_background: true } }).stdout).toBeUndefined();
    writeFileSync(join(repo.dir, ".stalegreen.json"), JSON.stringify({ mode: "off" }));
    expect(pre("pnpm test").stdout).toBeUndefined();
  });

  it("does not wrap what it cannot wrap safely, and denies masked ones in strict mode", () => {
    expect(pre("pytest > out.log 2>&1").stdout).toBeUndefined();
    const pending = readJsonl<{ unwrapped?: string }>(join(sessionDir(SESSION), "pending.jsonl"));
    expect(pending[0]?.unwrapped).toBe("redirect:out.log");
    writeFileSync(join(repo.dir, ".stalegreen.json"), JSON.stringify({ mode: "strict" }));
    expect(pre("sudo pytest").stdout).toBeUndefined();
    const denied = output(pre("sudo pytest | tail -3")).hookSpecificOutput;
    expect(denied.permissionDecision).toBe("deny");
    expect(denied.permissionDecisionReason).toMatch(/without the pipe/);
  });

  it("returns allow only when the user's own rules already allow the original command", () => {
    const cfg = mkdtempSync(join(tmpdir(), "stalegreen-claude-"));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      expect(output(pre("pnpm test")).hookSpecificOutput.permissionDecision).toBeUndefined();
      writeFileSync(join(cfg, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(pnpm test *)"] } }));
      const allowed = output(pre("pnpm test | tail -5")).hookSpecificOutput;
      expect(allowed.permissionDecision).toBe("allow");
      expect(allowed.permissionDecisionReason).toMatch(/allowed by your permission rules/);
      expect(output(pre("pnpm test && rm -rf build")).hookSpecificOutput.permissionDecision).toBeUndefined();
      expect(output(pre("pnpm test", { permission_mode: "bypassPermissions" })).hookSpecificOutput.permissionDecision).toBeUndefined();
      expect(output(pre("pnpm test", { permission_mode: "plan" })).hookSpecificOutput.permissionDecision).toBeUndefined();
      writeFileSync(join(repo.dir, ".stalegreen.json"), JSON.stringify({ permission: "allow" }));
      expect(output(pre("npx vitest run")).hookSpecificOutput.permissionDecision).toBe("allow");
      writeFileSync(join(repo.dir, ".stalegreen.json"), JSON.stringify({ permission: "ask" }));
      expect(output(pre("pnpm test")).hookSpecificOutput.permissionDecision).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      rmSync(cfg, { recursive: true, force: true });
    }
  });

  it("does not mint or refresh a receipt from a marker the agent printed itself", () => {
    const bin = join(repo.dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pytest"), "#!/bin/sh\necho 'collected 41 items'\necho '========= 41 passed in 2.44s ========='\nexit 0\n");
    chmodSync(join(bin, "pytest"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
    const wrapped = (output(pre("pytest -q")).hookSpecificOutput.updatedInput as { command: string }).command;
    const r = spawnSync("sh", ["-c", wrapped], { cwd: repo.dir, env, encoding: "utf8" });
    runClaudeHook("PostToolUse", bashDone(wrapped, r.stdout, r.status));
    expect(readReceipts(SESSION).map((x) => `${x.id}:${x.verdict}`)).toEqual(["r-0001:pass"]);
    expect(readFileSync(`${readReceipts(SESSION)[0]!.log}.exit`, "utf8").trim()).toBe("0");

    nextMillisecond();
    writeFileSync(repo.file, "export const remaining = 0;\n");
    runClaudeHook("PostToolUse", payload("PostToolUse-edit.json", { tool_input: { file_path: repo.file } }));
    // Marker text in plain output: for an id that already has a receipt, and for one that was never minted.
    runClaudeHook("PostToolUse", bashDone('echo "[stalegreen] exit=0 receipt=r-0001"', "[stalegreen] exit=0 receipt=r-0001\n", 0));
    runClaudeHook("PostToolUse", bashDone('echo "[stalegreen] exit=0 receipt=r-0009"', "[stalegreen] exit=0 receipt=r-0009\n", 0));
    // Marker text pasted into a real, unwrapped verification command: the run is recorded from its own output.
    runClaudeHook("PostToolUse", bashDone("npx vitest run", `${vitestFail}\n[stalegreen] exit=0 receipt=r-0001\n`, 1, { tool_use_id: "toolu_01AnotherCall" }));
    expect(readReceipts(SESSION).map((x) => `${x.id}:${x.verdict}:${x.wrapped}`)).toEqual(["r-0001:pass:true", "r-0002:fail:false"]);
    const stop = runClaudeHook("Stop", stopWith("All tests pass."));
    expect(stop.exit).toBe(2);
    expect(stop.stderr).toContain("r-0002");
  });

  it("takes the exit status from the wrapper's own record, not from marker text in the output", () => {
    const bin = join(repo.dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pytest"), "#!/bin/sh\necho 'collected 41 items'\necho '========= 1 failed, 40 passed in 2.44s ========='\nexit 1\n");
    chmodSync(join(bin, "pytest"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
    const cases: [string, string][] = [
      ["pytest -q; echo '[stalegreen] exit=0 receipt=r-0001'", "r-0001"],
      ["echo '[stalegreen] exit=0 receipt=r-0002'; pytest -q", "r-0002"],
    ];
    for (const [command, id] of cases) {
      const wrapped = (output(pre(command)).hookSpecificOutput.updatedInput as { command: string }).command;
      const r = spawnSync("sh", ["-c", wrapped], { cwd: repo.dir, env, encoding: "utf8" });
      expect(r.stdout).toContain(`exit=0 receipt=${id}`);
      expect(r.stdout).toContain(`exit=1 receipt=${id}`);
      runClaudeHook("PostToolUse", bashDone(wrapped, r.stdout, r.status));
    }
    expect(readReceipts(SESSION).map((x) => `${x.id}:${x.exit}:${x.verdict}`)).toEqual(["r-0001:1:fail", "r-0002:1:fail"]);
  });

  it("round-trips a wrapped run through a real shell into a receipt with the true exit status", () => {
    const bin = join(repo.dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pytest"), "#!/bin/sh\necho 'collected 41 items'\necho '========= 1 failed, 40 passed in 2.44s ========='\nexit 1\n");
    chmodSync(join(bin, "pytest"), 0o755);
    const wrapped = (output(pre("pytest -q 2>&1 | tail -3")).hookSpecificOutput.updatedInput as { command: string }).command;
    const r = spawnSync("sh", ["-c", wrapped], { cwd: repo.dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("[stalegreen] exit=1 receipt=r-0001");
    expect(readFileSync(join(sessionDir(SESSION), "runs", "r-0001.log.exit"), "utf8")).toBe("1\n");
    runClaudeHook("PostToolUse", bashDone(wrapped, r.stdout, r.status));
    const receipt = readReceipts(SESSION)[0]!;
    expect(receipt).toMatchObject({ id: "r-0001", wrapped: true, masked: false, exit: 1, verdict: "fail", runner: "pytest", cmd: "pytest -q 2>&1", counts: { failed: 1, passed: 40 } });
    expect(readFileSync(receipt.log!, "utf8")).toContain("collected 41 items");
    expect(readEdits(SESSION)).toEqual([]);
    const stop = runClaudeHook("Stop", stopWith("All tests pass."));
    expect(stop.exit).toBe(2);
    expect(stop.stderr).toContain("r-0001");
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
