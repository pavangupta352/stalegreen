/**
 * Reads the user's Claude Code permission rules so the PreToolUse hook can
 * tell whether the original command was already allowed. The rewritten
 * command would not match a rule such as `Bash(pnpm test *)`, so the hook
 * returns `permissionDecision: "allow"` only when the original did; it never
 * widens what the user permitted.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parseCommand } from "../../core/shell.js";

export interface PermissionRules {
  allow: string[];
  deny: string[];
  ask: string[];
}

const WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin", "noglob"]);
/** Assignments Claude Code strips before matching allow rules. Kept small on purpose. */
const SAFE_ENV = /^(?:CI|NODE_ENV|FORCE_COLOR|NO_COLOR|TERM|LANG|LC_ALL|TZ|DEBUG|RUST_BACKTRACE|PYTHONPATH|NODE_OPTIONS|PORT|HOME|PATH)=/;

function readRules(file: string): PermissionRules | null {
  try {
    if (!existsSync(file)) return null;
    const json = JSON.parse(readFileSync(file, "utf8")) as { permissions?: Partial<Record<keyof PermissionRules, unknown>> };
    const p = json.permissions ?? {};
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { allow: list(p.allow), deny: list(p.deny), ask: list(p.ask) };
  } catch {
    return null;
  }
}

function gitRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 100, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** Every settings file that can carry permission rules, merged. */
export function loadPermissionRules(cwd: string, env: NodeJS.ProcessEnv = process.env): PermissionRules {
  const configDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR : join(homedir(), ".claude");
  const project = env.CLAUDE_PROJECT_DIR && env.CLAUDE_PROJECT_DIR.trim() ? env.CLAUDE_PROJECT_DIR : cwd;
  const files = [
    platform() === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json",
    join(configDir, "settings.json"),
    join(project, ".claude", "settings.json"),
    join(gitRoot(project) ?? project, ".claude", "settings.local.json"),
  ];
  const merged: PermissionRules = { allow: [], deny: [], ask: [] };
  for (const f of files) {
    const r = readRules(f);
    if (!r) continue;
    merged.allow.push(...r.allow);
    merged.deny.push(...r.deny);
    merged.ask.push(...r.ask);
  }
  return merged;
}

/** Turns a `Bash(...)` rule into a matcher over a single subcommand. Returns null for rules about other tools. */
export function bashRuleMatcher(rule: string): ((cmd: string) => boolean) | null {
  const trimmed = rule.trim();
  if (trimmed === "Bash" || trimmed === "Bash(*)") return () => true;
  const m = /^Bash\((.*)\)$/s.exec(trimmed);
  if (!m) return null;
  let pattern = m[1] as string;
  if (pattern.endsWith(":*")) pattern = `${pattern.slice(0, -2)} *`;
  const stars = (pattern.match(/\*/g) ?? []).length;
  const trailingOnly = stars === 1 && pattern.endsWith(" *");
  const escaped = pattern
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const full = new RegExp(`^${escaped}$`, "s");
  const bare = trailingOnly ? new RegExp(`^${pattern.slice(0, -2).replace(/[.+?^${}()|[\]\\]/g, "\\$&")}$`, "s") : null;
  return (cmd: string) => full.test(cmd) || (bare !== null && bare.test(cmd));
}

/** Strips the wrappers and safe assignments Claude Code strips before matching. */
function normalize(words: string[]): string[] {
  let w = [...words];
  let guard = 0;
  while (w.length > 0 && guard++ < 8) {
    const first = w[0] as string;
    if (SAFE_ENV.test(first)) {
      w = w.slice(1);
      continue;
    }
    if (WRAPPERS.has(first)) {
      if (first === "timeout") {
        let i = 1;
        while (i < w.length && (w[i] as string).startsWith("-")) i += (w[i] === "-s" || w[i] === "-k") ? 2 : 1;
        w = w.slice(i + 1);
      } else w = w.slice(1);
      continue;
    }
    break;
  }
  return w;
}

/** Commands Claude Code runs without a prompt. Kept to plain readers with no write-capable flags. */
const READ_ONLY = new Set(["ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "echo", "printf", "pwd", "which", "type", "true", "false", "sort", "uniq", "cut", "tr", "less", "more", "file", "stat", "du", "df", "env", "printenv", "date", "whoami", "uname", "basename", "dirname", "realpath", "readlink", "test", "[", "column", "nl", "jq"]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "remote", "tag", "describe", "blame", "shortlog", "ls-files"]);

function isReadOnlySegment(words: string[]): boolean {
  const w0 = words[0] ?? "";
  if (w0 === "cd") {
    const target = words[1] ?? "";
    return words.length === 2 && target.length > 0 && !/^(?:\/|\.\.|~|-)/.test(target);
  }
  if (w0 === "git") return words.length >= 2 && READ_ONLY_GIT.has(words[1] as string) && !words.some((w) => w === "-c" || w.startsWith("--output"));
  if (!READ_ONLY.has(w0)) return false;
  return !words.some((w) => w.includes("*") || w.includes("?") || w.startsWith("--exec") || w === "-exec" || w === "-delete");
}

/**
 * True when every subcommand of `command` matches an allow rule and none
 * matches a deny or ask rule, the way Claude Code evaluates compound commands.
 * Built-in read-only commands need no rule.
 */
export function commandAllowedByRules(command: string, rules: PermissionRules): boolean {
  const parsed = parseCommand(command);
  if (!parsed.confident || parsed.segments.length === 0) return false;
  const allow = rules.allow.map(bashRuleMatcher).filter((f): f is (c: string) => boolean => f !== null);
  const denyOrAsk = [...rules.deny, ...rules.ask].map(bashRuleMatcher).filter((f): f is (c: string) => boolean => f !== null);
  if (allow.length === 0) return false;
  for (const seg of parsed.segments) {
    if (seg.env.some((e) => !SAFE_ENV.test(e))) return false;
    const words = normalize(seg.words);
    if (words.length === 0) return false;
    const text = seg.head.trim();
    const candidates = new Set([text, words.join(" ")]);
    const env = seg.env.filter((e) => SAFE_ENV.test(e));
    if (env.length > 0) candidates.add(seg.head.trim().slice(env.join(" ").length).trim());
    for (const c of candidates) if (denyOrAsk.some((f) => f(c))) return false;
    if (isReadOnlySegment(words) && seg.redirects.length === 0) continue;
    if (![...candidates].some((c) => allow.some((f) => f(c)))) return false;
  }
  return true;
}
