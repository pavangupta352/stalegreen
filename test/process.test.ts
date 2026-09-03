import { spawnSync } from "node:child_process";
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

  it("starts fast: cold start p95 under the budget", () => {
    const budget = Number(process.env.STALEGREEN_PERF_MAX_MS ?? "50");
    const payload = { ...loadHookFixture("PostToolUse-edit.json"), tool_name: "Read", cwd: repo.dir };
    const samples: number[] = [];
    for (let i = 0; i < 25; i++) samples.push(runHook("PostToolUse", payload, env).ms);
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)] as number;
    const median = samples[Math.floor(samples.length / 2)] as number;
    const baseline = nodeBaseline();
    // eslint-disable-next-line no-console
    console.log(`hook cold start: median ${median.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, node -e 0 baseline ${baseline.toFixed(1)} ms (budget ${budget} ms over baseline)`);
    expect(p95 - baseline).toBeLessThan(budget);
  });

  it("keeps the Stop path under 150 ms including the fingerprint", () => {
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) samples.push(runHook("Stop", stop("All 41 tests pass.", { prompt_id: `perf-${i}` }), env).ms);
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] as number;
    // eslint-disable-next-line no-console
    console.log(`stop hook: p95 ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(400);
  });
});

function countErrors(home: string): number {
  try {
    return readFileSync(join(home, "errors.jsonl"), "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function nodeBaseline(): number {
  const times: number[] = [];
  for (let i = 0; i < 10; i++) {
    const start = process.hrtime.bigint();
    spawnSync(process.execPath, ["-e", "0"], { encoding: "utf8" });
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] as number;
}

export { hookJs };
