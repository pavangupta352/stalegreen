/**
 * Timing budgets for the hook process. This file runs on its own after the
 * rest of the suite (see the `test` script) so the numbers are not skewed by
 * the shells the other files spawn in parallel.
 */

import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBuilt, loadHookFixture, makeHome, makeRepo, runHook, type TempRepo } from "./helpers.js";

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

function nodeBaselineOnce(): number {
  const start = process.hrtime.bigint();
  spawnSync(process.execPath, ["-e", "0"], { encoding: "utf8" });
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] as number;
}

describe("hook timing budgets", () => {
  it("starts fast: cold start p95 under the budget over a bare node process", () => {
    // Node 22.1 and later cache compiled code between runs; Node 20 parses the hook on every start.
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    const budget = Number(process.env.STALEGREEN_PERF_MAX_MS ?? (nodeMajor >= 22 ? "50" : "80"));
    const payload = { ...loadHookFixture("PostToolUse-edit.json"), tool_name: "Read", cwd: repo.dir };
    // Warm the compile cache and the page cache before measuring.
    for (let i = 0; i < 3; i++) runHook("PostToolUse", payload, env);
    const measure = () => {
      // Baseline and hook runs are interleaved so machine load hits both alike.
      const hook: number[] = [];
      const baseline: number[] = [];
      const paired: number[] = [];
      for (let i = 0; i < 30; i++) {
        const b = nodeBaselineOnce();
        const h = runHook("PostToolUse", payload, env).ms;
        baseline.push(b);
        hook.push(h);
        paired.push(h - b);
      }
      hook.sort((a, b) => a - b);
      baseline.sort((a, b) => a - b);
      paired.sort((a, b) => a - b);
      return { hook, baseline, over: percentile(paired, 0.95) };
    };
    // A shared runner can be busy for a few seconds; the better of two samples is the machine's number.
    let m = measure();
    if (m.over >= budget) m = measure();
    // eslint-disable-next-line no-console
    console.log(`hook cold start: median ${percentile(m.hook, 0.5).toFixed(1)} ms, p95 ${percentile(m.hook, 0.95).toFixed(1)} ms; node -e 0 median ${percentile(m.baseline, 0.5).toFixed(1)} ms; p95 over baseline ${m.over.toFixed(1)} ms (budget ${budget} ms)`);
    expect(m.over).toBeLessThan(budget);
  });

  it("keeps the Stop path under the budget including the fingerprint", () => {
    const budget = Number(process.env.STALEGREEN_STOP_MAX_MS ?? "400");
    const stop = (i: number) => ({ ...loadHookFixture("Stop.json"), cwd: repo.dir, last_assistant_message: "All 41 tests pass.", prompt_id: `perf-${i}` });
    runHook("Stop", stop(-1), env);
    const samples: number[] = [];
    for (let i = 0; i < 12; i++) samples.push(runHook("Stop", stop(i), env).ms);
    samples.sort((a, b) => a - b);
    const p95 = percentile(samples, 0.95);
    // eslint-disable-next-line no-console
    console.log(`stop hook: median ${percentile(samples, 0.5).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (budget ${budget} ms)`);
    expect(p95).toBeLessThan(budget);
  });
});
