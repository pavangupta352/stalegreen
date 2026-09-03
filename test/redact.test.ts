import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redactPaths, redactSecrets, redactSession } from "../src/cli/redact.js";
import { runLogPath } from "../src/core/receipts.js";
import { deriveSession } from "../src/core/store.js";
import { runClaudeHook } from "../src/harness/claude/hooks.js";
import { loadHookFixture, makeHome, makeRepo, readFixture, type TempRepo } from "./helpers.js";

let repo: TempRepo;
let home: { home: string; cleanup: () => void };

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

describe("redactSecrets", () => {
  it("masks secret-looking environment values, token flags, bearer headers, URL credentials and known token shapes", () => {
    expect(redactSecrets('NEXTAUTH_SECRET="abc def" DATABASE_URL=postgres://u:p@h/db NODE_ENV=test pnpm test')).toBe("NEXTAUTH_SECRET=<redacted> DATABASE_URL=postgres://<redacted>@h/db NODE_ENV=test pnpm test");
    expect(redactSecrets("curl --token abc123 -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x' https://x")).toBe("curl --token <redacted> -H 'Authorization: Bearer <redacted>' https://x");
    expect(redactSecrets("ghp_abcdefghijklmnop1234 and sk-live-abcdefghijk")).toBe("<redacted> and <redacted>");
    expect(redactSecrets("commit 3f2a9c1e4b7d8e6f0a1b2c3d4e5f60718293a4b5 stays")).toBe("commit 3f2a9c1e4b7d8e6f0a1b2c3d4e5f60718293a4b5 stays");
    expect(redactSecrets("Tests  41 passed (41)")).toBe("Tests  41 passed (41)");
  });
});

describe("redactPaths", () => {
  it("shortens repository, home and other absolute paths but keeps system binaries and file names", () => {
    const ctx = { home: "/home/dev", repos: ["/home/dev/app"] };
    expect(redactPaths("cd /home/dev/app/packages/api && /usr/bin/env node /home/dev/.cache/x/y.js /tmp/build6.out", ctx)).toBe("cd <repo>/packages/api && /usr/bin/env node ~/.cache/x/y.js <path>/build6.out");
    expect(redactPaths("src/lib/hold.ts (14:06:02)", ctx)).toBe("src/lib/hold.ts (14:06:02)");
  });
});

describe("redactSession", () => {
  it("keeps what a bug report needs and drops paths, secrets and prose", () => {
    const vitestPass = readFixture("runner-output", "vitest-pass.txt");
    const secretCommand = 'API_TOKEN="supersecretvalue123" npx vitest run';
    const post = { ...loadHookFixture("PostToolUse-bash.json"), cwd: repo.dir, tool_input: { command: secretCommand }, tool_response: { stdout: `${vitestPass}\nAPI_TOKEN=supersecretvalue123 was read from the environment\n`, stderr: "", interrupted: false, exit_code: 0 } };
    runClaudeHook("PostToolUse", post);
    const root = deriveSession(post as Record<string, unknown>).root;
    writeFileSync(repo.file, "export const remaining = 0;\n");
    runClaudeHook("PostToolUse", { ...loadHookFixture("PostToolUse-edit.json"), cwd: repo.dir, tool_input: { file_path: repo.file, old_string: "1", new_string: "0" } });
    runClaudeHook("Stop", { ...loadHookFixture("Stop.json"), cwd: repo.dir, last_assistant_message: "I talked to the customer about the invoice. All 41 tests pass." });

    const out = redactSession(root, { home: process.env.HOME ?? "" });
    const text = JSON.stringify(out);
    expect(text).not.toContain(repo.dir);
    expect(text).not.toContain("supersecretvalue123");
    expect(text).not.toContain("customer");
    expect(out.receipts[0]).toMatchObject({ id: "r-0001", cmd: "API_TOKEN=<redacted> npx vitest run", verdict: "pass", counts: { passed: 41 }, cwd: "<repo>", log: true });
    expect(out.edits[0]?.path).toBe("<repo>/hold.ts");
    expect(out.verdicts[0]).toMatchObject({ blocked: true, verdicts: [{ claim: { text: "All 41 tests pass" }, verdict: "STALE" }] });
    expect(out.verdicts[0]?.message).toContain("hold.ts");
    expect(out.verdicts[0]?.message).not.toContain("/var/");
    expect(out.logs["r-0001"]?.some((l) => l.includes("41 passed"))).toBe(true);
    expect(out.logs["r-0001"]?.some((l) => l.includes("<redacted>"))).toBe(true);
    expect(out.session).toBe("5f1c9d2e...");
    expect(out.note).toContain("Review before sharing");
  });

  it("can leave the logs out", () => {
    const post = { ...loadHookFixture("PostToolUse-bash.json"), cwd: repo.dir, tool_input: { command: "npx vitest run" }, tool_response: { stdout: readFixture("runner-output", "vitest-pass.txt"), stderr: "", interrupted: false, exit_code: 0 } };
    runClaudeHook("PostToolUse", post);
    const root = deriveSession(post as Record<string, unknown>).root;
    mkdirSync(join(home.home, "sessions", root, "runs"), { recursive: true });
    expect(runLogPath(root, "r-0001")).toContain("r-0001.log");
    expect(redactSession(root, { logs: false }).logs).toEqual({});
  });
});
