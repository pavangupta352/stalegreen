/**
 * `stalegreen install --claude` registers the hooks in Claude Code's settings.
 * The compiled hook is copied to `~/.stalegreen/bin/hook.js` so the entry
 * keeps working however the CLI was launched (npx, global install, clone).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stalegreenHome } from "../core/config.js";
import { VERSION } from "../version.js";

export interface ClaudeHookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

export interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookEntry[]>;
  [key: string]: unknown;
}

export const CLAUDE_EVENTS: { event: string; matcher?: string; timeout: number }[] = [
  { event: "PreToolUse", matcher: "Bash", timeout: 10 },
  { event: "PostToolUse", matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit|TaskOutput|BashOutput", timeout: 10 },
  { event: "Stop", timeout: 15 },
  { event: "SubagentStop", timeout: 15 },
];

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR : join(homedir(), ".claude");
}

export function settingsPath(scope: "user" | "project", cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return scope === "user" ? join(claudeConfigDir(env), "settings.json") : join(cwd, ".claude", "settings.json");
}

/** Where the compiled hook lives once installed. */
export function installedHookPath(): string {
  return join(stalegreenHome(), "bin", "hook.js");
}

/** The hook file shipped next to this CLI (dist/hook.js). */
export function bundledHookPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "hook.js");
}

function readSettings(file: string): ClaudeSettings {
  try {
    if (!existsSync(file)) return {};
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ClaudeSettings) : {};
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writeSettings(file: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

export function hookCommand(hookPath: string, event: string): string {
  const quoted = /[\s"'$`\\]/.test(hookPath) ? `"${hookPath.replace(/(["\\$`])/g, "\\$1")}"` : hookPath;
  return `node ${quoted} claude ${event}`;
}

function isOurs(entry: ClaudeHookEntry): boolean {
  return entry.hooks.some((h) => typeof h.command === "string" && /stalegreen/.test(h.command) && /\bclaude\s+(?:PreToolUse|PostToolUse|Stop|SubagentStop)\b/.test(h.command));
}

/** Removes stalegreen entries from a settings object. Returns how many were removed. */
export function removeHooks(settings: ClaudeSettings): number {
  let removed = 0;
  if (!settings.hooks) return 0;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event] ?? [];
    const kept = entries.filter((e) => {
      const ours = isOurs(e);
      if (ours) removed++;
      return !ours;
    });
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

export interface InstallResult {
  settingsFile: string;
  hookPath: string;
  replaced: number;
}

/** Copies the hook into the store and registers it in the chosen settings file. Idempotent. */
export function installClaude(opts: { scope: "user" | "project"; cwd: string; env?: NodeJS.ProcessEnv; source?: string }): InstallResult {
  const env = opts.env ?? process.env;
  const source = opts.source ?? bundledHookPath();
  if (!existsSync(source)) throw new Error(`Compiled hook not found at ${source}. Run \`npm run build\` first.`);
  const hookPath = installedHookPath();
  mkdirSync(dirname(hookPath), { recursive: true });
  copyFileSync(source, hookPath);
  writeFileSync(join(dirname(hookPath), "VERSION"), `${VERSION}\n`);
  const file = settingsPath(opts.scope, opts.cwd, env);
  const settings = readSettings(file);
  const replaced = removeHooks(settings);
  settings.hooks = settings.hooks ?? {};
  for (const e of CLAUDE_EVENTS) {
    const entry: ClaudeHookEntry = { hooks: [{ type: "command", command: hookCommand(hookPath, e.event), timeout: e.timeout }] };
    if (e.matcher) entry.matcher = e.matcher;
    settings.hooks[e.event] = [...(settings.hooks[e.event] ?? []), entry];
  }
  writeSettings(file, settings);
  return { settingsFile: file, hookPath, replaced };
}

export function uninstallClaude(opts: { scope: "user" | "project"; cwd: string; env?: NodeJS.ProcessEnv }): { settingsFile: string; removed: number } {
  const file = settingsPath(opts.scope, opts.cwd, opts.env ?? process.env);
  const settings = readSettings(file);
  const removed = removeHooks(settings);
  if (removed > 0) writeSettings(file, settings);
  return { settingsFile: file, removed };
}

export interface HookStatus {
  settingsFile: string;
  events: Record<string, boolean>;
  hookPath: string | null;
  hookExists: boolean;
  installedVersion: string | null;
}

/** Which of our events are registered in a settings file, and whether the hook file is in place. */
export function claudeHookStatus(scope: "user" | "project", cwd: string, env: NodeJS.ProcessEnv = process.env): HookStatus {
  const file = settingsPath(scope, cwd, env);
  let settings: ClaudeSettings = {};
  try {
    settings = readSettings(file);
  } catch {
    settings = {};
  }
  const events: Record<string, boolean> = {};
  let hookPath: string | null = null;
  for (const e of CLAUDE_EVENTS) {
    const entries = settings.hooks?.[e.event] ?? [];
    const ours = entries.find(isOurs);
    events[e.event] = !!ours;
    if (ours && !hookPath) {
      const m = /node\s+"?([^"]+?)"?\s+claude\s+/.exec(ours.hooks[0]?.command ?? "");
      hookPath = m?.[1] ?? null;
    }
  }
  const hookExists = hookPath ? existsSync(hookPath) : false;
  let installedVersion: string | null = null;
  if (hookPath) {
    try {
      installedVersion = readFileSync(join(dirname(hookPath), "VERSION"), "utf8").trim();
    } catch {
      installedVersion = null;
    }
  }
  return { settingsFile: file, events, hookPath, hookExists, installedVersion };
}
