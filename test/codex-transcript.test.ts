import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HISTORY, runHistory } from "../src/cli/history.js";
import { listSessionSources } from "../src/cli/sessions.js";
import { DEFAULT_STATS, runStats, type StatsReport } from "../src/cli/stats.js";
import { codexSessionGroups, codexTranscriptFiles, replayCodexSession } from "../src/harness/codex/transcript.js";
import { readFixture } from "./helpers.js";

/** Builds a synthetic Codex rollout. Nothing here comes from a real session. */
class Rollout {
  lines: string[] = [];
  private t: number;
  constructor(
    readonly id: string,
    readonly cwd: string,
    start = "2026-09-02T14:00:00.000Z",
    readonly parent: string | null = null,
  ) {
    this.t = Date.parse(start);
    this.push("session_meta", { id, timestamp: start, cwd, originator: "codex_cli_rs", cli_version: "0.146.0", source: "cli", thread_source: parent ? "subagent" : "user", ...(parent ? { parent_thread_id: parent } : {}) });
  }
  private ts(): string {
    this.t += 5000;
    return new Date(this.t).toISOString();
  }
  push(type: string, payload: Record<string, unknown>): this {
    this.lines.push(JSON.stringify({ timestamp: this.ts(), type, payload }));
    return this;
  }
  raw(line: string): this {
    this.lines.push(line);
    return this;
  }
  turn(model = "model-c"): this {
    return this.push("turn_context", { turn_id: `t-${this.lines.length}`, cwd: this.cwd, model });
  }
  user(text: string): this {
    this.push("event_msg", { type: "user_message", message: text });
    return this.push("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
  }
  say(text: string, phase: string | null = null): this {
    this.push("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }], ...(phase ? { phase } : {}) });
    // Codex duplicates the text as an event; the reader must not count it twice.
    return this.push("event_msg", { type: "agent_message", message: text, phase: phase ?? "commentary" });
  }
  exec(callId: string, script: string, output: string): this {
    this.push("response_item", { type: "custom_tool_call", name: "exec", call_id: callId, input: script });
    return this.push("response_item", { type: "custom_tool_call_output", call_id: callId, output });
  }
  wait(callId: string, cellId: number, output: string): this {
    this.push("response_item", { type: "function_call", name: "wait", call_id: callId, arguments: JSON.stringify({ cell_id: cellId, yield_time_ms: 5000 }) });
    return this.push("response_item", { type: "function_call_output", call_id: callId, output });
  }
  patch(files: string[], success = true): this {
    const changes: Record<string, unknown> = {};
    for (const f of files) changes[f] = { type: "update", unified_diff: "@@ -1 +1 @@" };
    return this.push("event_msg", { type: "patch_apply_end", call_id: `p-${this.lines.length}`, turn_id: "t", stdout: "", stderr: "", success, changes, status: success ? "completed" : "failed" });
  }
  done(): this {
    return this.push("event_msg", { type: "task_complete", turn_id: "t", last_agent_message: "" });
  }
  noise(): this {
    this.push("event_msg", { type: "token_count", info: {} });
    this.push("world_state", { snapshot: {} });
    this.push("response_item", { type: "reasoning", summary: [] });
    return this;
  }
  write(dir: string, name = `rollout-${this.id}.jsonl`): string {
    const file = join(dir, name);
    writeFileSync(file, this.lines.join("\n") + "\n");
    return file;
  }
}

const done = (out: string) => `Script completed\nWall time 1.2 seconds\nOutput:\n${out}`;
const failed = (out: string) => `Script failed\nWall time 1.2 seconds\nOutput:\n${out}`;

let codexHome: string;
let claudeDir: string;
let day: string;
let saved: { codex: string | undefined; claude: string | undefined };
beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), "stalegreen-codex-"));
  claudeDir = mkdtempSync(join(tmpdir(), "stalegreen-claude-"));
  day = join(codexHome, "sessions", "2026", "09", "02");
  mkdirSync(day, { recursive: true });
  saved = { codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});
afterEach(() => {
  if (saved.codex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved.codex;
  if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.claude;
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
});

const vitestPass = readFixture("runner-output", "vitest-pass.txt");
const jestFail = readFixture("runner-output", "jest-fail.txt");

describe("replayCodexSession", () => {
  it("rebuilds runs, edits, waits and final answers, and merges a child thread", async () => {
    const root = new Rollout("019a-root", "/home/dev/app");
    root
      .turn("model-c")
      .user("fix the expiry bug")
      .noise()
      .say("Running the tests first.")
      .exec("c1", "npx vitest run", done(vitestPass))
      .say("All 41 tests pass.", "final_answer")
      .done()
      .turn("model-c")
      .user("now change the expiry")
      .patch(["/home/dev/app/src/lib/hold.ts"])
      .raw('{"timestamp":"2026-09-02T14:01:00.000Z","type":"response_item","payload":{broken')
      .say("Done. All 41 tests pass.")
      .done()
      .turn("model-d")
      .user("run them piped")
      .exec("c2", "npx vitest run 2>&1 | grep -c passed", done("1\n"))
      .say("Tests pass.", "final_answer")
      .done()
      .user("try jest")
      .exec("c3", "npx jest", failed(jestFail))
      .say("The jest suite passes now.", "final_answer")
      .done()
      .user("long one")
      .exec("c4", "npx vitest run --coverage", "Script running with cell ID 5\nWall time 10.0 seconds\nOutput:\n RUN  v3.2.7\n")
      .wait("w1", 5, "Script running with cell ID 5\nWall time 5.0 seconds\nOutput:\n")
      .wait("w2", 5, done(vitestPass))
      .say("Coverage run finished, all 41 tests pass.", "final_answer")
      .done()
      .user("a failing patch")
      .patch(["/home/dev/app/src/lib/broken.ts"], false)
      .say("tsc is clean.", "final_answer")
      .done();
    const rootFile = root.write(day);
    // The child thread ran its typecheck before the root's first test run and before the edit.
    const child = new Rollout("019a-child", "/home/dev/app", "2026-09-02T14:00:01.000Z", "019a-root");
    child.turn("model-c").exec("s1", "npx tsc --noEmit", done("")).say("Typecheck is clean.", "final_answer").done();
    const childFile = child.write(day);

    const files = codexTranscriptFiles(join(codexHome, "sessions"));
    expect(files.map((f) => f.file).sort()).toEqual([childFile, rootFile].sort());
    const groups = await codexSessionGroups(files);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.root.id).toBe("019a-root");
    expect(groups[0]?.children.map((c) => c.id)).toEqual(["019a-child"]);

    const replay = await replayCodexSession(rootFile, { children: [childFile] });
    expect(replay.harness).toBe("codex");
    expect(replay.session).toBe("019a-root");
    expect(replay.entrypoint).toBe("cli");
    expect(replay.badLines).toBe(1);
    expect(replay.models).toEqual({ "model-c": 3, "model-d": 4 });
    expect(replay.subagentFiles).toBe(1);
    expect(replay.runs).toMatchObject({ total: 5, masked: 1, failed: 1, passed: 3, inconclusive: 1, background: 1, byCategory: { test: 4, typecheck: 1, lint: 0, build: 0 } });
    expect(replay.runs.byModel["model-c"]?.total).toBe(2);
    expect(replay.runs.byModel["model-d"]?.total).toBe(3);
    expect(replay.receipts.map((r) => `${r.category}:${r.verdict}:${r.exit}:${r.masked}`)).toEqual(["typecheck:pass:0:false", "test:pass:0:false", "test:inconclusive:null:true", "test:fail:null:false", "test:pass:0:false"]);
    expect(replay.receipts[0]?.agent).toBe("rollout-019a-child");
    expect(replay.receipts[3]?.signal).toBe("jest-failed");
    expect(replay.receipts[4]?.cmd).toBe("npx vitest run --coverage");
    expect(replay.edits.map((e) => `${e.kind}:${e.path}`)).toEqual(["apply_patch:/home/dev/app/src/lib/hold.ts"]);
    const kinds = replay.verdicts.map((v) => `${v.claim.category}:${v.verdict.verdict}`);
    expect(kinds).toEqual(["test:FRESH", "test:STALE", "test:MASKED", "test:FAILED", "test:FRESH", "typecheck:STALE"]);
    expect(replay.verdicts[1]?.verdict.freshness.editsAfter).toHaveLength(1);
    expect(replay.verdicts[2]?.model).toBe("model-d");
    expect(replay.verdicts[5]?.verdict.evidence?.receipt).toBe("r-0001");
    expect(replay.claims).toBe(6);
  });

  it("treats the last assistant message before a turn ends as final when no phase is recorded", async () => {
    const r = new Rollout("019a-nophase", "/home/dev/app");
    r.turn().user("go").exec("c1", "pnpm test", done(vitestPass)).say("Let me look.").say("All 41 tests pass.").done().turn().user("more").say("Still all 41 tests pass.");
    const file = r.write(day);
    const replay = await replayCodexSession(file);
    expect(replay.verdicts.map((v) => `${v.claim.text.toLowerCase()}:${v.verdict.verdict}`)).toEqual(["all 41 tests pass:FRESH", "all 41 tests pass:FRESH"]);
  });
});

describe("JavaScript exec cells", () => {
  it("digs the shell commands out of a cell and leaves the exit unknown unless the cell printed it", async () => {
    const r = new Rollout("019a-cell", "/home/dev/app");
    const cell = (cmd: string, extra = "") => `const r = await tools.exec_command({ cmd: ${JSON.stringify(cmd)}, workdir: "/home/dev/app", yield_time_ms: 10000 });\n${extra}console.log(r.output);`;
    r.turn()
      .user("go")
      .exec("c1", cell("npx vitest run"), done(vitestPass))
      .exec("c2", cell("npx jest", "console.log(JSON.stringify({ exit_code: r.exit_code }));\n"), done(`${jestFail}\n{"exit_code":1}\n`))
      .exec("c3", "const a = await tools.exec_command({ cmd: 'npx tsc --noEmit' });\nconst b = await tools.exec_command({ cmd: `npx eslint .`, workdir: '/home/dev/app' });\nconsole.log(a.output, b.output);", done("\n"))
      .exec("c4", "const p = await tools.apply_patch({ patch: '*** Begin Patch\\n*** End Patch' });", done("Success."))
      .say("All 41 tests pass, tsc and eslint are clean.", "final_answer")
      .done();
    const file = r.write(day);
    const replay = await replayCodexSession(file);
    expect(replay.receipts.map((x) => `${x.cmd}:${x.verdict}:${x.exit}:${x.signal}`)).toEqual(["npx vitest run:pass:null:summary-only:vitest-passed", "npx jest:fail:1:jest-failed", "npx tsc --noEmit:pass:null:silent-through-pipe", "npx eslint .:pass:null:silent-through-pipe"]);
    expect(replay.toolCalls).toBe(4);
  });
});

describe("history and stats over Codex rollouts", () => {
  it("lists Codex sessions next to Claude Code ones and reports per harness", async () => {
    const r = new Rollout("019a-hist", "/home/dev/app");
    r.turn().user("go").exec("c1", "pnpm test", done(vitestPass)).say("All 41 tests pass.", "final_answer").done().turn().user("edit").patch(["/home/dev/app/src/a.ts"]).say("Done, all 41 tests pass.", "final_answer").done();
    r.write(day);
    const sources = await listSessionSources("all", new Date(0));
    expect(sources.map((s) => s.harness)).toEqual(["codex"]);
    expect(await listSessionSources("claude", new Date(0))).toEqual([]);

    const out: string[] = [];
    expect(await runHistory({ ...DEFAULT_HISTORY, harness: "codex", since: "36500d", explain: true }, (l) => out.push(l))).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("1 sessions with tool calls");
    expect(text).toContain("STALE");
    expect(text).toContain("codex session 019a-hist");

    const json: string[] = [];
    expect(await runStats({ ...DEFAULT_STATS, harness: "all", since: "36500d", json: true }, (l) => json.push(l))).toBe(0);
    const report = JSON.parse(json.join("\n")) as StatsReport;
    expect(report.sessions).toBe(1);
    expect(report.byHarness["codex"]).toMatchObject({ sessions: 1, claims: { counted: 2, fresh: 1, stale: 1 }, runs: { total: 1, hidden: 0 } });
    expect(report.bySessionKind["interactive"]?.sessions).toBe(1);
  });
});
