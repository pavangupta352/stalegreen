import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_STATS, dedupeStatusLines, emptyReport, finishReport, foldSession, formatStats, runStats, sessionKind, type StatsReport } from "../src/cli/stats.js";
import type { Claim, Verdict } from "../src/core/grammar.js";
import type { ReplayVerdict, SessionReplay } from "../src/harness/replay.js";
import { readFixture } from "./helpers.js";

function claim(category: Claim["category"], sentence: string): Claim {
  return { category, text: sentence.toLowerCase().replace(/\.$/, ""), sentence, scope: "all", qualified: false };
}

function verdict(kind: Verdict["verdict"], c: Claim): Verdict {
  return { claim: { category: c.category, text: c.text, scope: c.scope, qualified: c.qualified }, evidence: null, freshness: { fingerprintMatch: null, editsAfter: [] }, verdict: kind, action: kind === "STALE" || kind === "FAILED" || kind === "MASKED" ? "blocked" : "allowed" };
}

function rv(session: string, kind: Verdict["verdict"], category: Claim["category"], sentence: string, model: string | null = "model-a"): ReplayVerdict {
  const c = claim(category, sentence);
  return { file: `/x/${session}.jsonl`, session, harness: "claude", ts: "2026-09-02T14:00:00.000Z", model, claim: c, verdict: verdict(kind, c), distance: 0 };
}

function replay(session: string, over: Partial<SessionReplay> = {}): SessionReplay {
  return {
    file: `/x/${session}.jsonl`,
    session,
    harness: "claude",
    entrypoint: "cli",
    models: { "model-a": 3 },
    assistantMessages: 3,
    toolCalls: 2,
    subagentFiles: 0,
    receipts: [],
    edits: [],
    verdicts: [],
    claims: 0,
    runs: { total: 0, masked: 0, maskedWithFailMarkers: 0, maskedInconclusive: 0, failed: 0, passed: 0, inconclusive: 0, background: 0, byCategory: { test: 0, typecheck: 0, lint: 0, build: 0 }, byModel: {} },
    badLines: 0,
    firstTs: null,
    lastTs: null,
    ...over,
  };
}

describe("stats", () => {
  it("counts a status line repeated word for word once per verdict, and again when the verdict changes", () => {
    const vs = [
      rv("s", "FRESH", "test", "All 41 tests pass."),
      rv("s", "FRESH", "test", "All 41 tests   pass."),
      rv("s", "STALE", "test", "All 41 tests pass."),
      rv("s", "FRESH", "typecheck", "All 41 tests pass."),
      rv("s", "FRESH", "test", "all 41 TESTS pass."),
    ];
    const { counted, repeated } = dedupeStatusLines(vs);
    expect(counted.map((v) => `${v.claim.category}:${v.verdict.verdict}`)).toEqual(["test:FRESH", "test:STALE", "typecheck:FRESH"]);
    expect(repeated).toBe(2);
  });

  it("classifies session kinds from the entrypoint", () => {
    expect(sessionKind("cli")).toBe("interactive");
    expect(sessionKind("sdk-py")).toBe("automated");
    expect(sessionKind("sdk-ts")).toBe("automated");
    expect(sessionKind("exec")).toBe("automated");
    expect(sessionKind(null)).toBe("unknown");
    expect(sessionKind("desktop")).toBe("unknown");
  });

  it("folds sessions into totals, per model and per session kind, skipping sessions without tool calls", () => {
    const report = emptyReport("90d", "claude");
    foldSession(
      report,
      replay("a", {
        verdicts: [rv("a", "FRESH", "test", "All tests pass."), rv("a", "STALE", "test", "Tests pass."), rv("a", "STALE", "test", "Tests pass."), rv("a", "FAILED", "build", "Build is green.", "model-b"), rv("a", "NONE", "lint", "Lint is clean.")],
        runs: { total: 10, masked: 8, maskedWithFailMarkers: 2, maskedInconclusive: 3, failed: 1, passed: 6, inconclusive: 3, background: 0, byCategory: { test: 7, typecheck: 1, lint: 1, build: 1 }, byModel: { "model-a": { total: 9, masked: 7, maskedWithFailMarkers: 2, maskedInconclusive: 3 }, "model-b": { total: 1, masked: 1, maskedWithFailMarkers: 0, maskedInconclusive: 0 }, "<synthetic>": { total: 0, masked: 0, maskedWithFailMarkers: 0, maskedInconclusive: 0 } } },
      }),
    );
    foldSession(report, replay("b", { entrypoint: "sdk-py", verdicts: [rv("b", "MASKED", "test", "Tests pass.", "model-a")] }));
    foldSession(report, replay("c", { toolCalls: 0, verdicts: [rv("c", "FRESH", "test", "Tests pass.")] }));
    foldSession(report, replay("d", { entrypoint: null, runs: { total: 2, masked: 0, maskedWithFailMarkers: 0, maskedInconclusive: 0, failed: 0, passed: 2, inconclusive: 0, background: 0, byCategory: { test: 2, typecheck: 0, lint: 0, build: 0 }, byModel: { "model-a": { total: 2, masked: 0, maskedWithFailMarkers: 0, maskedInconclusive: 0 } } } }));
    finishReport(report);

    expect(report.sessions).toBe(3);
    expect(report.sessionsWithClaims).toBe(2);
    expect(report.claims).toEqual({ counted: 5, repeated: 1, fresh: 1, stale: 1, failed: 1, masked: 1, none: 1, deferred: 0 });
    expect(report.runs).toEqual({ total: 12, hidden: 8, hidFailure: 2, noResult: 3 });
    expect(report.rates.stale).toBeCloseTo(0.2);
    expect(report.rates.hiddenExit).toBeCloseTo(8 / 12);
    expect(Object.keys(report.byModel).sort()).toEqual(["model-a", "model-b"]);
    expect(report.byModel["model-a"]).toMatchObject({ sessions: 3, sessionsWithClaims: 2, claims: { counted: 4, stale: 1, masked: 1 }, runs: { total: 11, hidden: 7 } });
    expect(report.byModel["model-b"]).toMatchObject({ sessions: 1, claims: { counted: 1, failed: 1 }, runs: { total: 1, hidden: 1 } });
    expect(report.bySessionKind["interactive"]).toMatchObject({ sessions: 1, claims: { counted: 4 }, runs: { total: 10 } });
    expect(report.bySessionKind["automated"]).toMatchObject({ sessions: 1, claims: { counted: 1 } });
    expect(report.byHarness["claude"]).toMatchObject({ sessions: 3, claims: { counted: 5 }, runs: { total: 12 } });
    expect(report.bySessionKind["unknown"]).toMatchObject({ sessions: 1, runs: { total: 2 } });

    const text = formatStats(report).join("\n");
    expect(text).toContain("3 sessions with tool calls");
    expect(text).toContain("1 repeated status lines counted once");
    expect(text).toContain("20% of green claims were stale (1 of 5); 67% of verification runs hid their exit status (8 of 12).");
    expect(text).toContain("model-a");
    expect(text).not.toContain("<synthetic>");
    expect(text).toContain("By session kind");
  });

  it("reports an empty window without dividing by zero", () => {
    const report = finishReport(emptyReport("7d", "claude"));
    expect(report.rates).toEqual({ stale: null, failed: null, masked: null, none: null, hiddenExit: null, hidFailure: null });
    const text = formatStats(report).join("\n");
    expect(text).toContain("No green claims and no verification runs in this window.");
  });
});

describe("runStats over a transcript directory", () => {
  let configDir: string;
  let saved: string | undefined;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "stalegreen-claude-"));
    saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(configDir, { recursive: true, force: true });
  });

  function record(type: string, extra: Record<string, unknown>, ts: string): string {
    return JSON.stringify({ type, timestamp: ts, entrypoint: "cli", cwd: "/home/dev/app", sessionId: "s", ...extra });
  }

  it("reads synthetic sessions from CLAUDE_CONFIG_DIR and prints text and JSON", async () => {
    const slug = join(configDir, "projects", "-home-dev-app");
    mkdirSync(slug, { recursive: true });
    const pass = readFixture("runner-output", "vitest-pass.txt");
    const lines = [
      record("user", { message: { role: "user", content: "run tests" } }, "2026-09-02T14:00:00.000Z"),
      record("assistant", { message: { id: "m1", model: "model-a", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npx vitest run" } }] } }, "2026-09-02T14:00:05.000Z"),
      record("user", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: pass }] }, toolUseResult: { stdout: pass, stderr: "", interrupted: false } }, "2026-09-02T14:00:10.000Z"),
      record("assistant", { message: { id: "m2", model: "model-a", role: "assistant", content: [{ type: "text", text: "All 41 tests pass." }] } }, "2026-09-02T14:00:15.000Z"),
      record("assistant", { message: { id: "m3", model: "model-a", role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/home/dev/app/src/a.ts", old_string: "1", new_string: "2" } }] } }, "2026-09-02T14:00:20.000Z"),
      record("user", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] }, toolUseResult: { filePath: "/home/dev/app/src/a.ts" } }, "2026-09-02T14:00:25.000Z"),
      record("assistant", { message: { id: "m4", model: "model-a", role: "assistant", content: [{ type: "text", text: "Done. All 41 tests pass." }] } }, "2026-09-02T14:00:30.000Z"),
    ];
    const file = join(slug, "11111111-2222-4333-8444-555555555555.jsonl");
    writeFileSync(file, lines.join("\n") + "\n");
    // A session with no tool calls is excluded.
    writeFileSync(join(slug, "22222222-2222-4333-8444-555555555555.jsonl"), record("assistant", { message: { id: "m9", model: "model-a", role: "assistant", content: [{ type: "text", text: "All tests pass." }] } }, "2026-09-02T14:00:30.000Z") + "\n");

    const out: string[] = [];
    expect(await runStats({ ...DEFAULT_STATS, harness: "claude", since: "36500d" }, (l) => out.push(l))).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("1 sessions with tool calls");
    expect(text).toContain("50% of green claims were stale (1 of 2); 0% of verification runs hid their exit status (0 of 1).");

    const json: string[] = [];
    expect(await runStats({ ...DEFAULT_STATS, harness: "claude", since: "36500d", json: true }, (l) => json.push(l))).toBe(0);
    const report = JSON.parse(json.join("\n")) as StatsReport;
    expect(report.sessions).toBe(1);
    expect(report.claims).toMatchObject({ counted: 2, fresh: 1, stale: 1 });
    expect(report.runs).toEqual({ total: 1, hidden: 0, hidFailure: 0, noResult: 0 });
    expect(report.byModel["model-a"]).toMatchObject({ claims: { counted: 2 }, runs: { total: 1 } });
    expect(report.bySessionKind["interactive"]?.sessions).toBe(1);

    expect(await runStats({ ...DEFAULT_STATS, harness: "claude", since: "soon" }, (l) => out.push(l))).toBe(2);
  });
});
