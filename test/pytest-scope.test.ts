import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { extractClaims } from "../src/core/claims.js";
import { evaluate } from "../src/core/freshness.js";
import type { Receipt } from "../src/core/grammar.js";
import { buildReceipts, resolveLogRead, type PendingRun, type ReceiptContext, type RunInput } from "../src/core/receipts.js";
import { parseCounts } from "../src/core/runners.js";
import { makeHome } from "./helpers.js";

const cwd = process.cwd();
const fingerprint = { head: "fixture", tree: "fixture", available: true, ms: 0 };
const ctx: ReceiptContext = { harness: "claude", root: "pytest-scope", agent: null, config: DEFAULT_CONFIG, fingerprintFor: () => fingerprint };
const input = (command: string, stdout: string, exit: number | null = 0): RunInput => ({ command, stdout, stderr: "", exit, interrupted: false, cwd });
const pass = "1 passed, 1 deselected in 0.01s\n";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe("pytest observed deselection", () => {
  it.each([
    "1 passed, 1 deselected in 0.01s\n",
    "================ 1 passed, 1 deselected in 0.01s ================\n",
    "1 passed, 2 skipped, 3 deselected, 4 xfailed in 0.01s\n",
  ])("retains deselection separately from the legacy skipped aggregate: %s", (output) => {
    const counts = parseCounts(output, "test");
    expect(counts.deselected).toBe(output.includes("3 deselected") ? 3 : 1);
    expect(counts.skipped).toBe(output.includes("3 deselected") ? 9 : 1);
  });

  it.each(["pytest -q", "python -m pytest -q", "PYTEST_ADDOPTS='-k good' pytest -q", "npm test"])(
    "narrows %s using the observed summary, including hidden configuration", (command) => {
      const receipt = buildReceipts(input(command, pass), ctx, null)[0]!.receipt;
      expect(receipt).toMatchObject({ verdict: "pass", scope: "subset", counts: { passed: 1, deselected: 1 } });
    },
  );

  it.each(["1 passed in 0.01s\n", "1 passed, 2 skipped in 0.01s\n", "1 passed, 2 xfailed in 0.01s\n", "1 passed, 0 deselected in 0.01s\n"])(
    "does not infer deselection from other outcomes: %s", (output) => {
      expect(buildReceipts(input("pytest -q", output), ctx, null)[0]!.receipt.scope).toBe("all");
    },
  );

  it("never widens an explicitly selected command", () => {
    expect(buildReceipts(input("pytest -k good", "1 passed in 0.01s\n"), ctx, null)[0]!.receipt.scope).toBe("subset");
  });

  it("keeps failure evidence when other tests were deselected", () => {
    expect(buildReceipts(input("pytest", "1 failed, 1 deselected in 0.01s\n", 1), ctx, null)[0]!.receipt).toMatchObject({ verdict: "fail", scope: "subset" });
  });

  it("narrows a wrapped receipt whose pending command appeared unrestricted", () => {
    const home = makeHome(); cleanups.push(home.cleanup);
    const log = join(home.home, "run.log"); writeFileSync(log, pass);
    const pending: PendingRun = { id: "r-0001", ts: new Date().toISOString(), toolUseId: null, command: "pytest -q", wrappedCommand: "wrapper", cwd, runner: "pytest", category: "test", scope: "all", cd: null, background: false, agent: null, log };
    const receipt = buildReceipts(input("wrapper", "[stalegreen] exit=0 receipt=r-0001\n"), ctx, pending)[0]!.receipt;
    expect(receipt).toMatchObject({ wrapped: true, verdict: "pass", scope: "subset", counts: { deselected: 1 } });
  });

  it("narrows redirected evidence when its log is subsequently read", () => {
    const original = buildReceipts(input("pytest -q > results.log", ""), ctx, null)[0]!.receipt;
    expect(original).toMatchObject({ verdict: "inconclusive", scope: "all" });
    const recovered = resolveLogRead(input("cat results.log", pass), ctx, [original]);
    expect(recovered).toMatchObject({ verdict: "pass", scope: "subset", counts: { deselected: 1 } });
  });

  it.each([false, true])("keeps full-suite and selected-test claims distinct (strict=%s)", (strict) => {
    const receipt = buildReceipts(input("pytest -q", pass), ctx, null)[0]!.receipt;
    const gate = (text: string, receipts: Receipt[]) => evaluate({ claims: extractClaims(text), receipts, edits: [], deferred: [], now: new Date().toISOString(), cwd, config: { ...DEFAULT_CONFIG, strictNoEvidence: strict }, fingerprintFor: () => fingerprint, blockedThisTurn: new Set() })[0];
    expect(gate("All tests pass.", [receipt])).toMatchObject({ verdict: "NONE", action: strict ? "blocked" : "allowed", note: expect.stringContaining("subset") });
    expect(gate("Tests pass.", [receipt])).toMatchObject({ verdict: "FRESH", action: "allowed" });
  });
});
