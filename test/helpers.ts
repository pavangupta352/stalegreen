import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const repoRoot = join(__dirname, "..");
export const hookJs = join(repoRoot, "dist", "hook.js");

/** Builds dist/ once when a test needs the compiled hook. */
export function ensureBuilt(): void {
  if (existsSync(hookJs)) return;
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "ignore" });
}

export interface TempRepo {
  dir: string;
  file: string;
  cleanup: () => void;
}

/** A throwaway git repository with one committed file. */
export function makeRepo(prefix = "stalegreen-repo-"): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  const file = join(dir, "hold.ts");
  writeFileSync(file, "export const remaining = 1;\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  // CI runners can take longer than the default 150 ms budget to spawn git four times.
  writeFileSync(join(dir, ".stalegreen.json"), JSON.stringify({ fingerprintBudgetMs: 5000 }));
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function makeHome(prefix = "stalegreen-home-"): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), prefix));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function readFixture(...parts: string[]): string {
  return readFileSync(join(repoRoot, "test", "fixtures", ...parts), "utf8");
}

export function loadHookFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFixture("hook-input", "claude", "2026-09", name)) as Record<string, unknown>;
}

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Runs the compiled hook as a real process with the payload on stdin. */
export function runHook(event: string, payload: unknown, env: Record<string, string>, harness = "claude"): SpawnResult {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const start = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [hookJs, harness, event], { input, env: { ...process.env, ...env }, encoding: "utf8", timeout: 20_000 });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ms };
}
