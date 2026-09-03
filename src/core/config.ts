/**
 * Configuration: defaults, `~/.stalegreen/config.json`, then `.stalegreen.json`
 * found in the working directory or one of its parents. Later layers win.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Category } from "./grammar.js";

export interface ExtraRunner {
  /** Regular expression matched against the command segment. */
  match: string;
  category: Category;
  /** Optional regular expressions matched against the output. */
  pass?: string;
  fail?: string;
}

export interface Config {
  policy: "block" | "advisory";
  mode: "rewrite" | "strict" | "off";
  strictNoEvidence: boolean;
  tailLines: number;
  categories: Record<Category, boolean>;
  ignoreCommands: string[];
  extraRunners: ExtraRunner[];
  prune: string;
  /** Paths that never make evidence stale, matched against repo-relative paths. */
  fingerprintIgnore: string[];
  fingerprintBudgetMs: number;
  /** Minutes a background verification run keeps the gate in deferred mode. */
  deferredTtlMinutes: number;
  /** Bytes kept per run log before truncation. */
  maxLogBytes: number;
}

export const DEFAULT_FINGERPRINT_IGNORE = [
  "*.md",
  "*.mdx",
  "*.txt",
  "*.rst",
  "*.adoc",
  "docs/**",
  "doc/**",
  "LICENSE*",
  "CHANGELOG*",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.svg",
  "*.ico",
  "*.webp",
  "*.log",
  ".stalegreen/**",
  ".stalegreen.json",
];

export const DEFAULT_CONFIG: Config = {
  policy: "block",
  mode: "rewrite",
  strictNoEvidence: false,
  tailLines: 40,
  categories: { test: true, typecheck: true, lint: true, build: true },
  ignoreCommands: [],
  extraRunners: [],
  prune: "30d",
  fingerprintIgnore: DEFAULT_FINGERPRINT_IGNORE,
  fingerprintBudgetMs: 150,
  deferredTtlMinutes: 10,
  maxLogBytes: 5 * 1024 * 1024,
};

/** The stalegreen home directory: `$STALEGREEN_HOME` or `~/.stalegreen`. */
export function stalegreenHome(): string {
  const env = process.env.STALEGREEN_HOME;
  if (env && env.trim().length > 0) return resolve(env);
  return join(homedir(), ".stalegreen");
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Finds `.stalegreen.json` in `cwd` or any parent directory. */
export function findRepoConfig(cwd: string): string | null {
  let dir = resolve(cwd);
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, ".stalegreen.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function merge(base: Config, layer: Record<string, unknown> | null): Config {
  if (!layer) return base;
  const out: Config = { ...base, categories: { ...base.categories } };
  const str = (k: string, allowed?: string[]): string | undefined => {
    const v = layer[k];
    if (typeof v !== "string") return undefined;
    if (allowed && !allowed.includes(v)) return undefined;
    return v;
  };
  const policy = str("policy", ["block", "advisory"]);
  if (policy) out.policy = policy as Config["policy"];
  const mode = str("mode", ["rewrite", "strict", "off"]);
  if (mode) out.mode = mode as Config["mode"];
  if (typeof layer.strictNoEvidence === "boolean") out.strictNoEvidence = layer.strictNoEvidence;
  if (typeof layer.tailLines === "number" && layer.tailLines >= 1 && layer.tailLines <= 5000) out.tailLines = Math.floor(layer.tailLines);
  if (layer.categories && typeof layer.categories === "object") {
    for (const c of ["test", "typecheck", "lint", "build"] as const) {
      const v = (layer.categories as Record<string, unknown>)[c];
      if (typeof v === "boolean") out.categories[c] = v;
    }
  }
  if (Array.isArray(layer.ignoreCommands)) out.ignoreCommands = layer.ignoreCommands.filter((x): x is string => typeof x === "string");
  if (Array.isArray(layer.extraRunners)) {
    out.extraRunners = layer.extraRunners.filter(
      (x): x is ExtraRunner => !!x && typeof x === "object" && typeof (x as ExtraRunner).match === "string" && ["test", "typecheck", "lint", "build"].includes((x as ExtraRunner).category),
    );
  }
  const prune = str("prune");
  if (prune && /^\d+d$/.test(prune)) out.prune = prune;
  if (Array.isArray(layer.fingerprintIgnore)) out.fingerprintIgnore = layer.fingerprintIgnore.filter((x): x is string => typeof x === "string");
  if (typeof layer.fingerprintBudgetMs === "number" && layer.fingerprintBudgetMs >= 10) out.fingerprintBudgetMs = Math.floor(layer.fingerprintBudgetMs);
  if (typeof layer.deferredTtlMinutes === "number" && layer.deferredTtlMinutes >= 0) out.deferredTtlMinutes = layer.deferredTtlMinutes;
  if (typeof layer.maxLogBytes === "number" && layer.maxLogBytes >= 1024) out.maxLogBytes = Math.floor(layer.maxLogBytes);
  return out;
}

/** Loads the effective configuration for a working directory. Never throws. */
export function loadConfig(cwd: string): Config {
  let config = DEFAULT_CONFIG;
  config = merge(config, readJson(join(stalegreenHome(), "config.json")));
  const repo = findRepoConfig(cwd);
  if (repo) config = merge(config, readJson(repo));
  return config;
}

/** Parses a duration such as `30d`, `12h` or `45m` into milliseconds. */
export function parseDuration(s: string): number | null {
  const m = /^(\d+)\s*([dhm])$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === "d") return n * 86_400_000;
  if (unit === "h") return n * 3_600_000;
  return n * 60_000;
}
