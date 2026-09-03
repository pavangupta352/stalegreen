import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bashRuleMatcher, commandAllowedByRules, loadPermissionRules } from "../src/harness/claude/permissions.js";

describe("bashRuleMatcher", () => {
  const table: [string, string[], string[]][] = [
    ["Bash(npm run build)", ["npm run build"], ["npm run build --watch"]],
    ["Bash(npm run *)", ["npm run build", "npm run test --watch", "npm run"], ["npm install"]],
    ["Bash(npm run:*)", ["npm run build", "npm run"], ["npm install"]],
    ["Bash(git log * main)", ["git log --oneline main", "git log -5 main"], ["git log main", "git push origin main"]],
    ["Bash(git * main)", ["git merge main", "git push origin main"], ["git log"]],
    ["Bash(* --version)", ["node --version"], ["node -v"]],
    ["Bash(ls *)", ["ls -la", "ls"], ["lsof"]],
    ["Bash(ls*)", ["ls -la", "lsof"], []],
    ["Bash(* --help *)", ["npm --help x"], ["npm --help"]],
    ["Bash", ["anything at all"], []],
    ["Bash(*)", ["anything at all"], []],
  ];
  for (const [rule, yes, no] of table) {
    it(rule, () => {
      const m = bashRuleMatcher(rule)!;
      expect(m).not.toBeNull();
      for (const c of yes) expect(m(c), `${rule} should match ${c}`).toBe(true);
      for (const c of no) expect(m(c), `${rule} should not match ${c}`).toBe(false);
    });
  }
  it("ignores rules for other tools", () => {
    expect(bashRuleMatcher("Edit(src/**)")).toBeNull();
    expect(bashRuleMatcher("WebFetch(domain:example.com)")).toBeNull();
  });
});

describe("commandAllowedByRules", () => {
  const rules = { allow: ["Bash(npm test *)", "Bash(pnpm *)", "Bash(cd *)", "Bash(git status)"], deny: ["Bash(git push *)"], ask: ["Bash(npm test --coverage)"] };
  it("requires every subcommand to match an allow rule", () => {
    expect(commandAllowedByRules("npm test", rules)).toBe(true);
    expect(commandAllowedByRules("npm test -- --run", rules)).toBe(true);
    expect(commandAllowedByRules("cd packages/api && pnpm test", rules)).toBe(true);
    expect(commandAllowedByRules("npm test && rm -rf /", rules)).toBe(false);
    expect(commandAllowedByRules("npm install", rules)).toBe(false);
  });
  it("treats built-in read-only commands as allowed without a rule", () => {
    const only = { allow: ["Bash(npm test *)"], deny: [], ask: [] };
    expect(commandAllowedByRules("pnpm test | tail -5", only)).toBe(false);
    expect(commandAllowedByRules("npm test | tail -5", only)).toBe(true);
    expect(commandAllowedByRules("cd packages/api && npm test", only)).toBe(true);
    expect(commandAllowedByRules("cd /etc && npm test", only)).toBe(false);
    expect(commandAllowedByRules("cd .. && npm test", only)).toBe(false);
    expect(commandAllowedByRules("git status && npm test", only)).toBe(true);
    expect(commandAllowedByRules("git push && npm test", only)).toBe(false);
    expect(commandAllowedByRules("ls *.ts && npm test", only)).toBe(false);
    expect(commandAllowedByRules("npm test > out.txt", only)).toBe(true);
    expect(commandAllowedByRules("cat x > y && npm test", only)).toBe(false);
  });
  it("lets deny and ask rules win and strips known wrappers and safe assignments", () => {
    expect(commandAllowedByRules("git push origin main", { ...rules, allow: ["Bash(git *)"] })).toBe(false);
    expect(commandAllowedByRules("npm test --coverage", rules)).toBe(false);
    expect(commandAllowedByRules("timeout 30 npm test", rules)).toBe(true);
    expect(commandAllowedByRules("CI=true npm test", rules)).toBe(true);
    expect(commandAllowedByRules("SECRET=1 npm test", rules)).toBe(false);
    expect(commandAllowedByRules("", rules)).toBe(false);
    expect(commandAllowedByRules("npm test", { allow: [], deny: [], ask: [] })).toBe(false);
  });
});

describe("loadPermissionRules", () => {
  it("merges the user, project and local settings files", () => {
    const home = mkdtempSync(join(tmpdir(), "stalegreen-cfg-"));
    const project = mkdtempSync(join(tmpdir(), "stalegreen-proj-"));
    try {
      mkdirSync(join(project, ".claude"));
      writeFileSync(join(home, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test *)"], deny: ["Bash(rm *)"] } }));
      writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(pnpm *)"] } }));
      writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ permissions: { ask: ["Bash(git push *)"] }, other: 1 }));
      const rules = loadPermissionRules(project, { CLAUDE_CONFIG_DIR: home, CLAUDE_PROJECT_DIR: project });
      expect(rules.allow).toEqual(["Bash(npm test *)", "Bash(pnpm *)"]);
      expect(rules.deny).toEqual(["Bash(rm *)"]);
      expect(rules.ask).toEqual(["Bash(git push *)"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});
