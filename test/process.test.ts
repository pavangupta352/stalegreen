import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBuilt, hookJs, loadHookFixture, makeHome, makeRepo, readFixture, runHook, type TempRepo } from "./helpers.js";

let repo: TempRepo;
let home: { home: string; cleanup: () => void };
let env: Record<string, string>;

beforeAll(() => {
  ensureBuilt();
  repo = makeRepo();
  home = makeHome();
  env = { STALEGREEN_HOME: home.home };
});
afterAll(() => {
  repo.cleanup();
  home.cleanup();
});

function stop(message: string, extra: Record<string, unknown> = {}) {
  return { ...loadHookFixture("Stop.json"), cwd: repo.dir, last_assistant_message: message, ...extra };
}

describe("dist/hook.js as a process", () => {
  it("runs the week one scenario: pass, edit, claim -> exit 2; no edit -> exit 0", () => {
    const post = { ...loadHookFixture("PostToolUse-bash.json"), cwd: repo.dir, tool_input: { command: "npx vitest run" }, tool_response: { stdout: readFixture("runner-output", "vitest-pass.txt"), stderr: "", interrupted: false, exit_code: 0 } };
    expect(runHook("PostToolUse", post, env).status).toBe(0);
    const ok = runHook("Stop", stop("All 41 tests pass."), env);
    expect(ok.status).toBe(0);
    expect(ok.stderr).toBe("");

    writeFileSync(repo.file, "export const remaining = 0;\n");
    const edit = { ...loadHookFixture("PostToolUse-edit.json"), cwd: repo.dir, tool_input: { file_path: repo.file } };
    expect(runHook("PostToolUse", edit, env).status).toBe(0);

    const blocked = runHook("Stop", stop("All 41 tests pass."), env);
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain("r-0001");
    expect(blocked.stderr).toContain("hold.ts");
    expect(blocked.stdout).toBe("");
  });

  it("exits 0 on malformed stdin, empty stdin and unknown events, and counts the failure", () => {
    const before = countErrors(home.home);
    expect(runHook("Stop", "{not json", env).status).toBe(0);
    expect(runHook("Stop", "", env).status).toBe(0);
    expect(runHook("Whatever", stop("All tests pass."), env).status).toBe(0);
    expect(runHook("Stop", stop("All tests pass."), env, "unknown-harness").status).toBe(0);
    expect(countErrors(home.home)).toBe(before + 1);
  });
});

function countErrors(home: string): number {
  try {
    return readFileSync(join(home, "errors.jsonl"), "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}


export { hookJs };
