import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeTranscriptFiles, replayClaudeSession, subagentFilesFor } from "../src/harness/claude/transcript.js";
import { formatHistoryVerdict, selectVerdicts, DEFAULT_HISTORY } from "../src/cli/history.js";
import { readFixture } from "./helpers.js";

/** Builds a synthetic Claude Code transcript. Nothing here comes from a real session. */
class SessionBuilder {
  lines: string[] = [];
  private t = Date.parse("2026-09-02T14:00:00.000Z");
  private n = 0;
  constructor(
    readonly sessionId: string,
    readonly cwd: string,
  ) {}
  private ts(): string {
    this.t += 7000;
    return new Date(this.t).toISOString();
  }
  private base(type: string, extra: Record<string, unknown>): Record<string, unknown> {
    this.n++;
    return { parentUuid: this.n > 1 ? `u-${this.n - 1}` : null, isSidechain: false, userType: "external", cwd: this.cwd, sessionId: this.sessionId, version: "2.1.300", gitBranch: "main", entrypoint: "cli", type, uuid: `u-${this.n}`, timestamp: this.ts(), ...extra };
  }
  push(rec: Record<string, unknown>): this {
    this.lines.push(JSON.stringify(rec));
    return this;
  }
  raw(line: string): this {
    this.lines.push(line);
    return this;
  }
  prompt(text: string): this {
    return this.push(this.base("user", { message: { role: "user", content: text } }));
  }
  /** One API response, split into one record per block as Claude Code writes them. */
  assistant(blocks: Record<string, unknown>[], model = "model-a"): this {
    const id = `msg_${this.n + 1}`;
    for (const block of blocks) this.push(this.base("assistant", { message: { id, model, role: "assistant", content: [block], stop_reason: null }, requestId: `req_${id}` }));
    return this;
  }
  text(text: string, model?: string): this {
    return this.assistant([{ type: "text", text }], model);
  }
  toolUse(id: string, name: string, input: Record<string, unknown>, model?: string): this {
    return this.assistant([{ type: "tool_use", id, name, input }], model);
  }
  result(id: string, content: string, extra: { is_error?: boolean; toolUseResult?: unknown } = {}): this {
    return this.push(this.base("user", { message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content, ...(extra.is_error ? { is_error: true } : {}) }] }, toolUseResult: extra.toolUseResult ?? { stdout: content, stderr: "", interrupted: false, isImage: false, noOutputExpected: false }, sourceToolUseID: id }));
  }
  noise(): this {
    this.push({ type: "file-history-snapshot", messageId: "m", snapshot: { trackedFileBackups: {}, timestamp: new Date(this.t).toISOString() }, isSnapshotUpdate: false });
    this.push(this.base("progress", { data: { type: "hook_progress" }, toolUseID: "x", parentToolUseID: null }));
    this.push(this.base("system", { subtype: "hook", content: "hook ran", level: "info" }));
    this.push(this.base("attachment", { attachment: { type: "queued_command" } }));
    this.push({ type: "permission-mode", permissionMode: "auto", sessionId: this.sessionId });
    return this;
  }
  write(file: string): void {
    writeFileSync(file, this.lines.join("\n") + "\n");
  }
}

let root: string;
let slug: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "stalegreen-projects-"));
  slug = join(root, "-home-dev-app");
  mkdirSync(slug);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const vitestPass = readFixture("runner-output", "vitest-pass.txt");
const jestFail = readFixture("runner-output", "jest-fail.txt");

describe("replayClaudeSession", () => {
  it("rebuilds runs, edits and final-message claims and replays the gate", async () => {
    const s = new SessionBuilder("11111111-2222-4333-8444-555555555555", "/home/dev/app");
    const file = join(slug, `${s.sessionId}.jsonl`);
    const persisted = join(root, "persisted.txt");
    writeFileSync(persisted, vitestPass);
    s.prompt("fix the expiry bug")
      .noise()
      .text("I will run the tests first.")
      .toolUse("t1", "Bash", { command: "npx vitest run", description: "Run tests" })
      .result("t1", "<persisted-output>preview only</persisted-output>", { toolUseResult: { stdout: "preview only", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, persistedOutputPath: persisted, persistedOutputSize: vitestPass.length } })
      .text("All 41 tests pass.")
      .prompt("now change the expiry")
      .toolUse("t2", "Edit", { file_path: "/home/dev/app/src/lib/hold.ts", old_string: "1", new_string: "0" })
      .result("t2", "The file has been updated.", { toolUseResult: { filePath: "/home/dev/app/src/lib/hold.ts" } })
      .raw('{"type":"assistant","message":{broken')
      .raw("{not interesting and not json")
      .text("Done. All 41 tests pass.")
      .prompt("run them piped")
      .toolUse("t3", "Bash", { command: "npx vitest run 2>&1 | grep -c passed" })
      .result("t3", "1\n")
      .text("Tests pass.")
      .prompt("try jest")
      .toolUse("t4", "Bash", { command: "npx jest" })
      .result("t4", `Exit code 1\n${jestFail}`, { is_error: true, toolUseResult: { stdout: jestFail, stderr: "", interrupted: false, isImage: false, noOutputExpected: false } })
      .text("The jest suite passes now.")
      .prompt("denied one")
      .toolUse("t5", "Bash", { command: "pytest -q" })
      .result("t5", "Permission to use Bash has been denied.", { is_error: true, toolUseResult: "Permission denied" })
      .toolUse("t6", "Bash", { command: "npx vitest run", run_in_background: true })
      .result("t6", "Command running in background with ID: bash_9", { toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: "bash_9" } })
      .text("tsc is clean.", "model-b")
      .write(file);

    const subDir = join(slug, s.sessionId, "subagents");
    mkdirSync(subDir, { recursive: true });
    const sub = new SessionBuilder(s.sessionId, "/home/dev/app");
    (sub as unknown as { t: number }).t = Date.parse("2026-09-02T14:01:00.000Z");
    sub.toolUse("s1", "Bash", { command: "npx tsc --noEmit" }).result("s1", "").text("Typecheck is clean.").write(join(subDir, "agent-a1b2.jsonl"));
    expect(subagentFilesFor(file)).toEqual([join(subDir, "agent-a1b2.jsonl")]);

    const replay = await replayClaudeSession(file);
    expect(replay.entrypoint).toBe("cli");
    expect(replay.badLines).toBe(1);
    expect(replay.assistantMessages).toBe(12);
    expect(replay.models).toEqual({ "model-a": 11, "model-b": 1 });
    expect(replay.subagentFiles).toBe(1);
    expect(replay.runs).toMatchObject({ total: 4, masked: 1, failed: 1, passed: 2, inconclusive: 1, background: 1, byCategory: { test: 3, typecheck: 1, lint: 0, build: 0 } });
    expect(replay.receipts.map((r) => `${r.id}:${r.category}:${r.verdict}:${r.masked}`)).toEqual(["r-0001:test:pass:false", "r-0002:typecheck:pass:false", "r-0003:test:inconclusive:true", "r-0004:test:fail:false"]);
    expect(replay.receipts[0]?.counts).toEqual({ passed: 41, total: 41 });
    expect(replay.receipts[3]?.exit).toBe(1);
    expect(replay.edits.map((e) => e.kind)).toEqual(["Edit"]);
    const kinds = replay.verdicts.map((v) => `${v.claim.category}:${v.verdict.verdict}`);
    expect(kinds).toEqual(["test:FRESH", "test:STALE", "test:MASKED", "test:FAILED", "typecheck:FRESH"]);
    expect(replay.verdicts[1]?.verdict.freshness.editsAfter).toHaveLength(1);
    expect(replay.verdicts[4]?.model).toBe("model-b");
    expect(replay.verdicts[4]?.verdict.evidence?.receipt).toBe("r-0002");
    expect(replay.claims).toBe(5);

    const selected = selectVerdicts(replay, DEFAULT_HISTORY);
    expect(selected.map((v) => v.verdict.verdict)).toEqual(["STALE", "MASKED", "FAILED"]);
    const line = formatHistoryVerdict(selected[0]!, true);
    expect(line).toContain("STALE");
    expect(line).toContain("hold.ts");
    expect(line).toContain("npx vitest run");
    expect(line).toContain("session 11111111-2222-4333-8444-555555555555");

    const listed = claudeTranscriptFiles(root);
    expect(listed.map((f) => f.file)).toEqual([file]);
    expect(claudeTranscriptFiles(root, new Date(Date.now() + 60_000))).toEqual([]);
  });

  it("evaluates mid-turn text only when asked", async () => {
    const s = new SessionBuilder("22222222-2222-4333-8444-555555555555", "/home/dev/app");
    const file = join(slug, `${s.sessionId}.jsonl`);
    s.prompt("go")
      .toolUse("t1", "Bash", { command: "npx vitest run" })
      .result("t1", vitestPass)
      .assistant([{ type: "text", text: "All 41 tests pass, now editing." }, { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/home/dev/app/a.ts" } }])
      .result("t2", "ok", { toolUseResult: { filePath: "/home/dev/app/a.ts" } })
      .text("Finished.")
      .write(file);
    expect((await replayClaudeSession(file)).verdicts).toHaveLength(0);
    const all = await replayClaudeSession(file, { allMessages: true });
    expect(all.verdicts.map((v) => v.verdict.verdict)).toEqual(["FRESH"]);
  });
});
