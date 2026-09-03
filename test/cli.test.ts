import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLAUDE_EVENTS, claudeHookStatus, hookCommand, installClaude, removeHooks, uninstallClaude } from "../src/cli/install.js";
import { ensureBuilt, hookJs, loadHookFixture, makeRepo, readFixture, repoRoot, runHook, type TempRepo } from "./helpers.js";

let home: string;
let cfg: string;
let codexHome: string;
let repo: TempRepo;
const cliJs = join(repoRoot, "dist", "cli.js");

beforeAll(() => ensureBuilt());
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "stalegreen-home-"));
  cfg = mkdtempSync(join(tmpdir(), "stalegreen-cfg-"));
  codexHome = mkdtempSync(join(tmpdir(), "stalegreen-codex-"));
  repo = makeRepo();
  process.env.STALEGREEN_HOME = home;
});
afterEach(() => {
  delete process.env.STALEGREEN_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(cfg, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
  repo.cleanup();
});

function cli(args: string[], extraEnv: Record<string, string> = {}, cwd = repo.dir) {
  return spawnSync(process.execPath, [cliJs, ...args], { cwd, env: { ...process.env, STALEGREEN_HOME: home, CLAUDE_CONFIG_DIR: cfg, CODEX_HOME: codexHome, ...extraEnv }, encoding: "utf8" });
}

describe("install --claude", () => {
  it("copies the hook, registers every event and stays idempotent", () => {
    const env = { CLAUDE_CONFIG_DIR: cfg };
    const first = installClaude({ scope: "user", cwd: repo.dir, env, source: hookJs });
    expect(existsSync(first.hookPath)).toBe(true);
    expect(first.hookPath).toBe(join(home, "bin", "hook.js"));
    const settings = JSON.parse(readFileSync(first.settingsFile, "utf8")) as { hooks: Record<string, { matcher?: string; hooks: { command: string; timeout: number }[] }[]> };
    for (const e of CLAUDE_EVENTS) {
      const entries = settings.hooks[e.event]!;
      expect(entries).toHaveLength(1);
      expect(entries[0]!.hooks[0]!.command).toBe(hookCommand(first.hookPath, e.event));
      expect(entries[0]!.hooks[0]!.timeout).toBe(e.timeout);
      if (e.matcher) expect(entries[0]!.matcher).toBe(e.matcher);
    }
    const second = installClaude({ scope: "user", cwd: repo.dir, env, source: hookJs });
    expect(second.replaced).toBe(4);
    const again = JSON.parse(readFileSync(second.settingsFile, "utf8")) as { hooks: Record<string, unknown[]> };
    expect(again.hooks.Stop).toHaveLength(1);
    const status = claudeHookStatus("user", repo.dir, env);
    expect(Object.values(status.events).every(Boolean)).toBe(true);
    expect(status.hookExists).toBe(true);
    const removed = uninstallClaude({ scope: "user", cwd: repo.dir, env });
    expect(removed.removed).toBe(4);
    expect(JSON.parse(readFileSync(removed.settingsFile, "utf8"))).toEqual({});
  });

  it("keeps other hooks and settings untouched", () => {
    const file = join(cfg, "settings.json");
    writeFileSync(file, JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo other" }] }], PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo w" }] }] } }));
    installClaude({ scope: "user", cwd: repo.dir, env: { CLAUDE_CONFIG_DIR: cfg }, source: hookJs });
    const s = JSON.parse(readFileSync(file, "utf8")) as { model: string; hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(s.model).toBe("x");
    expect(s.hooks.Stop).toHaveLength(2);
    expect(s.hooks.Stop![0]!.hooks[0]!.command).toBe("echo other");
    expect(s.hooks.PreToolUse).toHaveLength(2);
    const settings = { hooks: { Stop: [{ hooks: [{ type: "command", command: "node /x/hook.js claude Stop" }] }, { hooks: [{ type: "command", command: "stalegreen-lookalike" }] }] } };
    expect(removeHooks(settings)).toBe(0);
    expect(removeHooks({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node /x/stalegreen/bin/hook.js claude Stop" }] }] } })).toBe(1);
  });

  it("supports project scope", () => {
    const r = installClaude({ scope: "project", cwd: repo.dir, env: { CLAUDE_CONFIG_DIR: cfg }, source: hookJs });
    expect(r.settingsFile).toBe(join(repo.dir, ".claude", "settings.json"));
    expect(claudeHookStatus("project", repo.dir, { CLAUDE_CONFIG_DIR: cfg }).events.Stop).toBe(true);
    expect(claudeHookStatus("user", repo.dir, { CLAUDE_CONFIG_DIR: cfg }).events.Stop).toBe(false);
  });

  it("quotes hook paths with spaces", () => {
    expect(hookCommand("/Users/a b/.stalegreen/bin/hook.js", "Stop")).toBe('node "/Users/a b/.stalegreen/bin/hook.js" claude Stop');
    expect(hookCommand("/home/dev/.stalegreen/bin/hook.js", "Stop")).toBe("node /home/dev/.stalegreen/bin/hook.js claude Stop");
  });
});

describe("dist/cli.js", () => {
  it("prints help and version", () => {
    expect(cli(["--version"]).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const help = cli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("stalegreen install --claude");
    expect(cli([]).stdout).toContain("Usage:");
    expect(cli(["bogus"]).status).toBe(2);
  });

  it("installs, reports through doctor, and shows receipts through check and receipt", () => {
    const install = cli(["install", "--claude", "--advisory"]);
    expect(install.status, install.stderr).toBe(0);
    expect(install.stdout).toContain("Registered PreToolUse, PostToolUse, Stop and SubagentStop");
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual({ policy: "advisory" });
    const doctor = cli(["doctor"]);
    expect(doctor.status, doctor.stdout).toBe(0);
    expect(doctor.stdout).toContain("claude user hooks: PreToolUse, PostToolUse, Stop, SubagentStop");
    expect(doctor.stdout).toContain("hook errors recorded: 0");

    const installed = join(home, "bin", "hook.js");
    const post = { ...loadHookFixture("PostToolUse-bash.json"), cwd: repo.dir, tool_input: { command: "npx vitest run" }, tool_response: { stdout: readFixture("runner-output", "vitest-pass.txt"), stderr: "", interrupted: false, exit_code: 0 } };
    const r = spawnSync(process.execPath, [installed, "claude", "PostToolUse"], { input: JSON.stringify(post), env: { ...process.env, STALEGREEN_HOME: home }, encoding: "utf8" });
    expect(r.status).toBe(0);
    const check = cli(["check"]);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain("r-0001");
    expect(check.stdout).toContain("41 passed");
    const json = JSON.parse(cli(["check", "--json"]).stdout) as { receipts: { id: string }[] };
    expect(json.receipts[0]!.id).toBe("r-0001");
    const receipt = cli(["receipt", "r-0001"]);
    expect(receipt.status).toBe(0);
    expect(receipt.stdout).toContain('"verdict": "pass"');
    expect(receipt.stdout).toContain("Log tail");
    expect(cli(["receipt", "r-9999"]).status).toBe(1);
    expect(cli(["receipt"]).status).toBe(2);

    const stop = { ...loadHookFixture("Stop.json"), cwd: repo.dir, last_assistant_message: "All 41 tests pass." };
    writeFileSync(repo.file, "changed\n");
    const s = spawnSync(process.execPath, [installed, "claude", "Stop"], { input: JSON.stringify(stop), env: { ...process.env, STALEGREEN_HOME: home }, encoding: "utf8" });
    expect(s.status).toBe(0);
    expect(cli(["check"]).stdout).toContain("advisory");

    const un = cli(["uninstall", "--claude"]);
    expect(un.status).toBe(0);
    expect(un.stdout).toContain("Removed 4");
    expect(cli(["doctor"]).stdout).toContain("claude user hooks: not installed");
  });

  it("installs and removes the Codex hooks in hooks.json and reports them through doctor", () => {
    const install = cli(["install", "--codex"]);
    expect(install.status, install.stderr).toBe(0);
    expect(install.stdout).toContain("run /hooks");
    const hooks = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8")) as { hooks: Record<string, { matcher?: string; hooks: { command: string; timeout: number }[] }[]> };
    expect(Object.keys(hooks.hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "Stop", "SubagentStop"]);
    expect(hooks.hooks.PreToolUse?.[0]?.matcher).toBe("^Bash$");
    expect(hooks.hooks.PreToolUse?.[0]?.hooks[0]?.command).toMatch(/node .*hook\.js codex PreToolUse$/);
    expect(hooks.hooks.PostToolUse?.[0]?.matcher).toContain("apply_patch");
    expect(cli(["doctor"]).stdout).toContain("codex user hooks: PreToolUse, PostToolUse, Stop, SubagentStop");
    const again = cli(["install", "--codex"]);
    expect(again.stdout).toContain("replaced 4 older entries");
    const un = cli(["uninstall", "--codex"]);
    expect(un.stdout).toContain("Removed 4 stalegreen hook entries");
    expect(cli(["doctor"]).stdout).toContain("codex user hooks: not installed");
    expect(cli(["install", "--all"]).stdout).toContain("Codex asks you to review");
    expect(cli(["uninstall", "--all"]).status).toBe(0);
  });

  it("refuses install without a harness flag and reports a missing hook file", () => {
    expect(cli(["install"]).status).toBe(2);
    mkdirSync(join(cfg), { recursive: true });
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node /nowhere/stalegreen/hook.js claude Stop" }] }] } }));
    const doctor = cli(["doctor"]);
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toContain("hook file missing");
    void runHook;
  });
});
