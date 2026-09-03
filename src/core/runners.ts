/**
 * Runner catalog: recognises verification commands (test, typecheck, lint,
 * build) inside a shell command line and reads the runner's own summary
 * output into a verdict with counts.
 *
 * Detection is conservative: unrecognised commands return null, help, list,
 * collect-only and watch invocations are reported as not-a-run, and a verdict
 * is `pass` only with a positive signal and a known exit status of 0.
 */

import { parseCommand, stripGroupingWords, type ParsedCommand, type Segment } from "./shell.js";
import type { Category, Counts, RunScope, RunVerdict } from "./grammar.js";

export interface Detection {
  runner: string;
  category: Category;
  scope: RunScope;
  segmentIndex: number;
  segment: Segment;
  /** Runner words after wrappers, env prefixes and grouping punctuation are removed. */
  words: string[];
  /** Directory the segment runs in, from a leading `cd <dir> &&`, `-C` or `--prefix`. */
  cd: string | null;
  quiet: boolean;
  /** Set when the invocation is not a verification run: help, list, collect-only, watch, dry-run, format. */
  notRun: string | null;
  sudo: boolean;
  /** The runner sits inside `sh -c "..."`. */
  nested: boolean;
  /** For nested runners: the inner command line and the runner's segment index inside it. */
  inner?: { command: string; index: number };
}

export interface Classification {
  runner: string;
  category: Category;
  scope: RunScope;
  quiet: boolean;
  notRun: string | null;
}

export interface ParseResult {
  verdict: RunVerdict;
  counts: Counts;
  /** Signal that decided the verdict. */
  signal: string | null;
  passSignals: string[];
  failSignals: string[];
}

export interface ParseOptions {
  exit: number | null;
  /** The exit status is known to be non-zero but the number is not (Codex reports "Script failed"). */
  failed?: boolean;
  interrupted?: boolean;
  /**
   * When the exit status is unknown but the end of the output is fully
   * visible (a `tail`, `cat`, `tee`, `|| true` or `;` chain), the runner's own
   * summary decides. Filters and redirects leave this false.
   */
  outputVisible?: boolean;
  /**
   * The output went through a filter such as `grep`: only self-contained
   * one-line summaries are trusted, and silence proves nothing.
   */
  filtered?: boolean;
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

const TEST_SCRIPT = /^(test|tests|t|spec|specs|unit|e2e|integration|coverage)([:._-].*)?$/i;
const BUILD_SCRIPT = /^(build|compile|bundle|dist|prod|production)([:._-].*)?$/i;
const LINT_SCRIPT = /^(lint|eslint|biome|stylelint|oxlint|prettier:check|format:check|fmt:check|check-format|check:format|fmt-check|lint:fix|lint-fix)([:._-].*)?$/i;
const TYPECHECK_SCRIPT = /^(typecheck|type-check|types|check-types|check:types|tsc|lint:types|typecheck:.*|type-check:.*|tsc:.*)$/i;
const WATCH_SCRIPT = /(^|[:._-])(watch|dev|serve|start|ui)([:._-]|$)/i;
const WATCH_FLAGS = new Set(["--watch", "--watchAll", "--watch-all", "-w", "--ui", "--open", "--watch=true", "--watchAll=true"]);
const HELP_FLAGS = new Set(["--help", "-h", "-help", "--version", "-V", "help"]);
const LIST_FLAGS = new Set(["--collect-only", "--co", "--collectonly", "--list", "--listTests", "--list-tests", "-list", "--dry-run", "--dryrun", "--show-config", "--showConfig", "--print-config", "--debug-config"]);

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function hasAny(words: string[], flags: Set<string>): boolean {
  return words.some((w) => flags.has(w));
}

function watchIn(words: string[]): boolean {
  return words.some((w) => WATCH_FLAGS.has(w) || /^--watch(All)?=/.test(w));
}

/** Flags whose next word is a value, not a positional argument. */
const VALUE_FLAGS = new Set(["-p", "--project", "-c", "--config", "--configPath", "--config-path", "-f", "--file", "-o", "--out", "--outDir", "--outFile", "--out-dir", "-r", "--require", "--reporter", "--setupFile", "--setupFiles", "--dir", "--root", "--rootDir", "--tsconfig", "--env-file", "--env", "--ignore-path", "--ignore-pattern", "--rulesdir", "--resolve-plugins-relative-to", "--parser", "--ext", "--format", "--output-file", "--cache-location", "--max-warnings", "-C", "--directory", "--manifest-path", "--target-dir", "--features", "--package", "-p", "--bin", "--example", "--bench", "--lib", "--workspace", "--exclude", "--filter", "--target", "-t", "--testNamePattern", "--testPathPattern", "--testPathPatterns", "-k", "-m", "--maxfail", "--timeout", "--project", "--pool", "--poolOptions", "--coverage.provider", "--shard", "--concurrency", "--threads", "-j", "--jobs", "--retries", "--repeat", "--run-in-band", "-n", "--name", "--plain-name", "--tags", "-l", "--log-level", "--verbosity", "-v"]);

/** Positional arguments from index `from`, flags and their values removed. */
function positionals(words: string[], from: number): string[] {
  const out: string[] = [];
  for (let i = from; i < words.length; i++) {
    const w = words[i] as string;
    if (w === "--") continue;
    if (w.startsWith("-")) {
      if (VALUE_FLAGS.has(w) && !["-v", "--lib", "--workspace", "--run-in-band"].includes(w)) i++;
      continue;
    }
    out.push(w);
  }
  return out;
}

/** Source files whose presence on the command line narrows a run to a subset. Config files do not count. */
const FILE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs|mts|cts|go|rs|rb|php|ex|exs|swift|kt|java|cs|vue|svelte|sh|c|cc|cpp|h|hpp|scala|dart|elm|hs)$/i;

function hasFileArgs(words: string[], from: number): boolean {
  return positionals(words, from).some((p) => FILE_EXT.test(p) || p.includes("::"));
}

function flagValuePresent(words: string[], ...flags: string[]): boolean {
  return words.some((w) => flags.some((f) => w === f || w.startsWith(f + "=")));
}

function quietIn(words: string[], extra: string[] = []): boolean {
  return (
    words.some((w) => w === "-q" || w === "-qq" || w === "--quiet" || w === "--silent" || w === "--reporter=dot" || w === "--reporter=silent" || extra.includes(w)) ||
    words.some((w, i) => (w === "--reporter" || w === "-R") && (words[i + 1] === "dot" || words[i + 1] === "silent"))
  );
}

/** Category for a package script or make target name. */
export function scriptCategory(name: string): { category: Category; watch: boolean } | null {
  const n = name.trim();
  if (!n) return null;
  const watch = WATCH_SCRIPT.test(n);
  if (TYPECHECK_SCRIPT.test(n)) return { category: "typecheck", watch };
  if (TEST_SCRIPT.test(n)) return { category: "test", watch };
  if (BUILD_SCRIPT.test(n)) return { category: "build", watch };
  if (LINT_SCRIPT.test(n)) return { category: "lint", watch };
  return null;
}

const NPM_RUN_FLAGS = new Set(["-s", "--silent", "-q", "--quiet", "--if-present", "--workspaces", "-ws", "--include-workspace-root", "--no-workspaces", "-r", "--recursive", "--parallel", "--stream", "--sequential", "--no-bail", "--bail", "--verbose", "--no-progress"]);

/** Reads `<tool> [flags] [run] <script> [args]` for npm, pnpm, yarn, bun, deno task, turbo, lerna. */
function scriptRunner(tool: string, words: string[]): Classification | null {
  let i = 1;
  let keyword: string | null = null;
  const takesValue = new Set(["--filter", "-F", "--workspace", "-w", "-C", "--dir", "--prefix", "--scope", "--project", "-p", "--concurrency", "workspace"]);
  while (i < words.length) {
    const w = words[i] as string;
    if (w === "run" || w === "run-script" || w === "task" || w === "exec") {
      keyword = w;
      i++;
      break;
    }
    if (takesValue.has(w)) {
      i += 2;
      continue;
    }
    if (w.startsWith("-") || NPM_RUN_FLAGS.has(w)) {
      i++;
      continue;
    }
    break;
  }
  const script = words[i];
  if (!script) return null;
  const cat = scriptCategory(script);
  if (!cat) return null;
  const rest = words.slice(i + 1);
  const notRun = cat.watch || watchIn(rest) ? "watch" : hasAny(rest, HELP_FLAGS) ? "help" : hasAny(rest, LIST_FLAGS) ? "list" : null;
  const scope: RunScope = cat.category === "test" && (hasFileArgs(rest, 0) || flagValuePresent(rest, "-t", "--testNamePattern", "--testPathPattern", "-k", "--grep", "-g")) ? "subset" : "all";
  const runner = keyword ? `${tool} ${keyword} ${script}` : `${tool} ${script}`;
  return { runner, category: cat.category, scope, quiet: quietIn(words, ["-s"]), notRun };
}

function makeRunner(words: string[]): Classification | null {
  let target: string | null = null;
  let dryRun = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as string;
    if (w === "-n" || w === "--dry-run" || w === "--just-print") dryRun = true;
    if (w === "-C" || w === "-f" || w === "-j" || w === "--directory" || w === "--file" || w === "--jobs") {
      i++;
      continue;
    }
    if (w.startsWith("-")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
    target = w;
    break;
  }
  let category: Category | null = null;
  const t = (target ?? "").toLowerCase();
  if (!target || /^(all|build|compile|dist|release|default)$/.test(t)) category = "build";
  else if (/^(test|tests|check-tests?|unittests?|unit|integration|e2e|spec|specs|test-.*|test_.*)$/.test(t)) category = "test";
  else if (/^(lint|check-lint|lint-check|fmt-check|format-check|clippy|vet|eslint|ruff|flake8|style)$/.test(t)) category = "lint";
  else if (/^(typecheck|type-check|types|mypy|tsc|pyright|check-types)$/.test(t)) category = "typecheck";
  if (!category) return null;
  return { runner: target ? `make ${target}` : "make", category, scope: "all", quiet: words.includes("-s") || words.includes("--silent"), notRun: dryRun ? "dry-run" : null };
}

const PYTEST_SUBSET = ["-k", "-m", "--lf", "--last-failed", "--deselect", "--ignore", "--ignore-glob"];

/** Classifies a stripped word list. Returns null when the command is not a verification runner. */
export function classify(input: string[]): Classification | null {
  const words = input;
  if (words.length === 0) return null;
  const w0 = basename(words[0] as string);
  const rest = words.slice(1);
  const help = hasAny(rest, HELP_FLAGS) ? "help" : null;
  const list = hasAny(rest, LIST_FLAGS) ? "list" : null;
  const watch = watchIn(rest) ? "watch" : null;
  const notRun = help ?? list ?? watch;
  const sub1 = words[1] ?? "";

  // --- package managers and task runners
  if (w0 === "npm" || w0 === "pnpm" || w0 === "yarn" || w0 === "bun" || w0 === "deno" || w0 === "turbo" || w0 === "lerna" || w0 === "nx") {
    if (w0 === "bun" && sub1 === "test") {
      return { runner: "bun test", category: "test", scope: hasFileArgs(words, 2) || flagValuePresent(rest, "-t", "--test-name-pattern") ? "subset" : "all", quiet: quietIn(rest), notRun };
    }
    if (w0 === "deno" && (sub1 === "test" || sub1 === "check" || sub1 === "lint")) {
      const category: Category = sub1 === "test" ? "test" : sub1 === "check" ? "typecheck" : "lint";
      return { runner: `deno ${sub1}`, category, scope: category === "test" && (hasFileArgs(words, 2) || flagValuePresent(rest, "--filter")) ? "subset" : "all", quiet: quietIn(rest), notRun };
    }
    if (w0 === "npm" && (sub1 === "t" || sub1 === "test" || sub1 === "tst")) {
      const r = words.slice(2);
      return { runner: "npm test", category: "test", scope: hasFileArgs(r, 0) || flagValuePresent(r, "-t", "--testNamePattern") ? "subset" : "all", quiet: quietIn(words, ["-s"]), notRun: watchIn(r) ? "watch" : notRun };
    }
    if (w0 === "nx") {
      let target: string | null = null;
      if (sub1 === "run" && words[2]) target = (words[2] as string).split(":")[1] ?? null;
      else if (sub1 === "run-many" || sub1 === "affected") {
        const i = words.findIndex((w) => w === "-t" || w === "--target" || w === "--targets");
        target = i >= 0 ? (words[i + 1] ?? null) : null;
        const eq = words.find((w) => w.startsWith("--target=") || w.startsWith("--targets="));
        if (eq) target = eq.split("=")[1] ?? null;
      } else target = sub1 || null;
      if (!target) return null;
      const cat = scriptCategory(target.split(",")[0] as string);
      if (!cat) return null;
      return { runner: `nx ${target}`, category: cat.category, scope: "all", quiet: quietIn(rest), notRun: cat.watch ? "watch" : notRun };
    }
    return scriptRunner(w0, words);
  }
  if (w0 === "make" || w0 === "gmake") return makeRunner(words);

  // --- python
  if (w0 === "pytest" || w0 === "py.test" || w0 === "pytest-3") {
    const scope: RunScope = flagValuePresent(rest, ...PYTEST_SUBSET) || hasFileArgs(words, 1) ? "subset" : "all";
    return { runner: "pytest", category: "test", scope, quiet: quietIn(rest), notRun };
  }
  if (w0 === "unittest") {
    return { runner: "unittest", category: "test", scope: positionals(words, 1).length > 0 && !rest.includes("discover") ? "subset" : "all", quiet: quietIn(rest), notRun };
  }
  if (w0 === "manage.py" && sub1 === "test") {
    return { runner: "manage.py test", category: "test", scope: positionals(words, 2).length > 0 ? "subset" : "all", quiet: false, notRun };
  }
  if (w0 === "django-admin" && sub1 === "test") return { runner: "django-admin test", category: "test", scope: positionals(words, 2).length > 0 ? "subset" : "all", quiet: false, notRun };
  if (w0 === "nose2" || w0 === "ward") return { runner: w0, category: "test", scope: positionals(words, 1).length > 0 ? "subset" : "all", quiet: false, notRun };
  if (w0 === "mypy") return { runner: "mypy", category: "typecheck", scope: hasFileArgs(words, 1) ? "subset" : "all", quiet: false, notRun };
  if (w0 === "pyright" || w0 === "basedpyright") return { runner: w0, category: "typecheck", scope: hasFileArgs(words, 1) ? "subset" : "all", quiet: false, notRun: notRun ?? (rest.includes("--watch") ? "watch" : null) };
  if (w0 === "pyre") return { runner: "pyre", category: "typecheck", scope: "all", quiet: false, notRun };
  if (w0 === "ruff") {
    if (words.length === 1) return { runner: "ruff", category: "lint", scope: "all", quiet: false, notRun: "help" };
    if (sub1 === "format") {
      return { runner: "ruff format", category: "lint", scope: hasFileArgs(words, 2) ? "subset" : "all", quiet: quietIn(rest), notRun: rest.includes("--check") || rest.includes("--diff") ? notRun : "format" };
    }
    if (sub1 === "rule" || sub1 === "config" || sub1 === "version" || sub1 === "clean" || sub1 === "server" || sub1 === "analyze") return null;
    const from = sub1 === "check" ? 2 : 1;
    return { runner: "ruff check", category: "lint", scope: hasFileArgs(words, from) ? "subset" : "all", quiet: quietIn(rest), notRun };
  }
  if (w0 === "flake8" || w0 === "pylint" || w0 === "pyflakes" || w0 === "pycodestyle" || w0 === "bandit") return { runner: w0, category: "lint", scope: hasFileArgs(words, 1) ? "subset" : "all", quiet: quietIn(rest), notRun };
  if (w0 === "black" || w0 === "isort") {
    const check = rest.includes("--check") || rest.includes("--check-only") || rest.includes("--diff");
    return { runner: w0, category: "lint", scope: hasFileArgs(words, 1) ? "subset" : "all", quiet: quietIn(rest), notRun: check ? notRun : "format" };
  }
  if (w0 === "build" && words.length === 1) return { runner: "python -m build", category: "build", scope: "all", quiet: false, notRun };

  // --- javascript and typescript
  if (w0 === "jest") {
    const subset = hasFileArgs(words, 1) || positionals(words, 1).length > 0 || flagValuePresent(rest, "-t", "--testNamePattern", "--testPathPattern", "--testPathPatterns", "--findRelatedTests", "--onlyChanged", "-o", "--changedSince", "--lastCommit");
    return { runner: "jest", category: "test", scope: subset ? "subset" : "all", quiet: quietIn(rest), notRun };
  }
  if (w0 === "vitest") {
    const mode = sub1;
    if (mode === "watch" || mode === "dev") return { runner: "vitest", category: "test", scope: "all", quiet: false, notRun: "watch" };
    if (mode === "bench") return { runner: "vitest", category: "test", scope: "all", quiet: false, notRun: "bench" };
    if (mode === "init") return { runner: "vitest", category: "test", scope: "all", quiet: false, notRun: "help" };
    if (mode === "list") return { runner: "vitest", category: "test", scope: "all", quiet: false, notRun: "list" };
    const from = mode === "run" ? 2 : 1;
    const subset = hasFileArgs(words, from) || positionals(words, from).length > 0 || flagValuePresent(rest, "-t", "--testNamePattern", "--project", "--changed", "--related", "--dir");
    return { runner: "vitest", category: "test", scope: subset ? "subset" : "all", quiet: quietIn(rest), notRun };
  }
  if (w0 === "mocha") return { runner: "mocha", category: "test", scope: hasFileArgs(words, 1) || flagValuePresent(rest, "-g", "--grep", "-f", "--fgrep") ? "subset" : "all", quiet: quietIn(rest), notRun };
  if (w0 === "ava") return { runner: "ava", category: "test", scope: hasFileArgs(words, 1) || flagValuePresent(rest, "-m", "--match") ? "subset" : "all", quiet: quietIn(rest), notRun };
  if (w0 === "tap" || w0 === "tape" || w0 === "jasmine" || w0 === "uvu" || w0 === "qunit") return { runner: w0, category: "test", scope: hasFileArgs(words, 1) ? "subset" : "all", quiet: quietIn(rest), notRun };
  if (w0 === "node" && (sub1 === "--test" || rest.includes("--test"))) return { runner: "node --test", category: "test", scope: hasFileArgs(words, 1) || flagValuePresent(rest, "--test-name-pattern") ? "subset" : "all", quiet: false, notRun: rest.includes("--watch") ? "watch" : notRun };
  if (w0 === "node" && sub1 === "--run" && words[2]) {
    const cat = scriptCategory(words[2] as string);
    if (!cat) return null;
    return { runner: `node --run ${words[2]}`, category: cat.category, scope: "all", quiet: false, notRun: cat.watch ? "watch" : notRun };
  }
  if (w0 === "playwright" && sub1 === "test") {
    const subset = hasFileArgs(words, 2) || positionals(words, 2).length > 0 || flagValuePresent(rest, "-g", "--grep", "--project", "--last-failed");
    return { runner: "playwright test", category: "test", scope: subset ? "subset" : "all", quiet: quietIn(rest), notRun: notRun ?? (rest.includes("--ui") ? "watch" : null) };
  }
  if (w0 === "cypress" && sub1 === "run") return { runner: "cypress run", category: "test", scope: flagValuePresent(rest, "--spec", "-s") ? "subset" : "all", quiet: quietIn(rest), notRun };
  if (w0 === "react-scripts" && (sub1 === "test" || sub1 === "build")) return { runner: `react-scripts ${sub1}`, category: sub1 === "test" ? "test" : "build", scope: "all", quiet: false, notRun };
  if (w0 === "ng" && (sub1 === "test" || sub1 === "build" || sub1 === "lint")) {
    const category: Category = sub1 === "test" ? "test" : sub1 === "build" ? "build" : "lint";
    return { runner: `ng ${sub1}`, category, scope: "all", quiet: false, notRun: sub1 === "test" && !rest.includes("--watch=false") && !rest.includes("--no-watch") ? "watch" : notRun };
  }
  if (w0 === "tsc" || w0 === "vue-tsc" || w0 === "tsgo") return { runner: w0, category: "typecheck", scope: hasFileArgs(words, 1) ? "subset" : "all", quiet: false, notRun: notRun ?? (rest.includes("--watch") || rest.includes("-w") ? "watch" : rest.includes("--listFiles") ? "list" : null) };
  if (w0 === "svelte-check") return { runner: "svelte-check", category: "typecheck", scope: "all", quiet: false, notRun };
  if (w0 === "astro" && sub1 === "check") return { runner: "astro check", category: "typecheck", scope: "all", quiet: false, notRun };
  if (w0 === "flow") return { runner: "flow", category: "typecheck", scope: "all", quiet: false, notRun: sub1 === "check" || sub1 === "status" || sub1 === "" ? notRun : "other" };
  if (w0 === "eslint") return { runner: "eslint", category: "lint", scope: hasFileArgs(words, 1) ? "subset" : "all", quiet: rest.includes("--quiet"), notRun: notRun ?? (rest.includes("--print-config") ? "list" : null) };
  if (w0 === "biome") {
    if (sub1 === "check" || sub1 === "lint" || sub1 === "ci") return { runner: `biome ${sub1}`, category: "lint", scope: hasFileArgs(words, 2) ? "subset" : "all", quiet: false, notRun };
    if (sub1 === "format") return { runner: "biome format", category: "lint", scope: hasFileArgs(words, 2) ? "subset" : "all", quiet: false, notRun: rest.includes("--write") ? "format" : notRun };
    return null;
  }
  if (w0 === "oxlint" || w0 === "stylelint" || w0 === "standard" || w0 === "xo" || w0 === "tslint") return { runner: w0, category: "lint", scope: hasFileArgs(words, 1) ? "subset" : "all", quiet: rest.includes("--quiet"), notRun };
  if (w0 === "prettier") {
    const check = rest.includes("--check") || rest.includes("-c") || rest.includes("--list-different") || rest.includes("-l");
    return { runner: "prettier", category: "lint", scope: hasFileArgs(words, 1) ? "subset" : "all", quiet: false, notRun: check ? notRun : "format" };
  }
  if (w0 === "next") {
    if (sub1 === "build") return { runner: "next build", category: "build", scope: "all", quiet: false, notRun };
    if (sub1 === "lint") return { runner: "next lint", category: "lint", scope: "all", quiet: false, notRun };
    if (sub1 === "typegen") return { runner: "next typegen", category: "typecheck", scope: "all", quiet: false, notRun };
    return null;
  }
  if (w0 === "vite") {
    if (sub1 === "build") return { runner: "vite build", category: "build", scope: "all", quiet: false, notRun: rest.includes("--watch") || rest.includes("-w") ? "watch" : notRun };
    return null;
  }
  if (w0 === "nuxt" || w0 === "nuxi") {
    if (sub1 === "build" || sub1 === "generate") return { runner: `nuxt ${sub1}`, category: "build", scope: "all", quiet: false, notRun };
    if (sub1 === "typecheck") return { runner: "nuxt typecheck", category: "typecheck", scope: "all", quiet: false, notRun };
    return null;
  }
  if (
    (w0 === "astro" || w0 === "remix" || w0 === "parcel" || w0 === "expo" || w0 === "docusaurus" || w0 === "gatsby" || w0 === "eleventy" || w0 === "hugo" || w0 === "svelte-kit" || w0 === "rspack" || w0 === "rsbuild" || w0 === "ember") &&
    (sub1 === "build" || sub1 === "export")
  ) {
    return { runner: `${w0} ${sub1}`, category: "build", scope: "all", quiet: false, notRun: rest.includes("--watch") ? "watch" : notRun };
  }
  if (w0 === "webpack" || w0 === "webpack-cli") return { runner: "webpack", category: "build", scope: "all", quiet: false, notRun: sub1 === "serve" || sub1 === "watch" || rest.includes("--watch") || rest.includes("-w") ? "watch" : notRun };
  if (w0 === "webpack-dev-server") return { runner: "webpack", category: "build", scope: "all", quiet: false, notRun: "watch" };
  if (w0 === "rollup") return { runner: "rollup", category: "build", scope: "all", quiet: false, notRun: rest.includes("--watch") || rest.includes("-w") ? "watch" : notRun };
  if (w0 === "esbuild") return { runner: "esbuild", category: "build", scope: "all", quiet: false, notRun: rest.includes("--watch") || rest.some((w) => w.startsWith("--serve")) ? "watch" : notRun };
  if (w0 === "tsup" || w0 === "tsdown" || w0 === "unbuild" || w0 === "microbundle" || w0 === "pkgroll" || w0 === "bunchee") return { runner: w0, category: "build", scope: "all", quiet: false, notRun: rest.includes("--watch") || rest.includes("-w") ? "watch" : notRun };

  // --- go
  if (w0 === "go") {
    if (sub1 === "test") {
      const subset = flagValuePresent(rest, "-run", "-bench") || positionals(words, 2).some((p) => p !== "./..." && p !== "..." && p !== ".");
      return { runner: "go test", category: "test", scope: subset ? "subset" : "all", quiet: false, notRun: notRun ?? (rest.includes("-list") ? "list" : null) };
    }
    if (sub1 === "build" || sub1 === "install") return { runner: `go ${sub1}`, category: "build", scope: "all", quiet: false, notRun: notRun ?? (rest.includes("-n") ? "dry-run" : null) };
    if (sub1 === "vet") return { runner: "go vet", category: "lint", scope: "all", quiet: false, notRun };
    return null;
  }
  if (w0 === "golangci-lint") return { runner: "golangci-lint", category: "lint", scope: "all", quiet: false, notRun: sub1 === "run" ? notRun : "other" };
  if (w0 === "staticcheck" || w0 === "revive" || w0 === "gofmt") return { runner: w0, category: "lint", scope: "all", quiet: false, notRun: w0 === "gofmt" && !rest.includes("-l") ? "format" : notRun };

  // --- rust
  if (w0 === "cargo") {
    if (sub1 === "test" || sub1 === "t") {
      const subset = flagValuePresent(rest, "-p", "--package", "--lib", "--doc", "--test", "--bin", "--example", "--bench") || positionals(words, 2).length > 0;
      return { runner: "cargo test", category: "test", scope: subset ? "subset" : "all", quiet: quietIn(rest), notRun: notRun ?? (rest.includes("--list") || rest.includes("--no-run") ? "list" : null) };
    }
    if (sub1 === "nextest") {
      const subset = flagValuePresent(rest, "-p", "--package", "-E", "--filter-expr") || positionals(words, 3).length > 0;
      return { runner: "cargo nextest", category: "test", scope: subset ? "subset" : "all", quiet: quietIn(rest), notRun: words[2] === "run" ? notRun : "other" };
    }
    if (sub1 === "build" || sub1 === "b") return { runner: "cargo build", category: "build", scope: "all", quiet: quietIn(rest), notRun };
    if (sub1 === "check" || sub1 === "c") return { runner: "cargo check", category: "typecheck", scope: "all", quiet: quietIn(rest), notRun };
    if (sub1 === "clippy") return { runner: "cargo clippy", category: "lint", scope: "all", quiet: quietIn(rest), notRun };
    if (sub1 === "fmt") return { runner: "cargo fmt", category: "lint", scope: "all", quiet: false, notRun: rest.includes("--check") ? notRun : "format" };
    if (sub1 === "watch") return { runner: "cargo watch", category: "test", scope: "all", quiet: false, notRun: "watch" };
    return null;
  }

  // --- dotnet, jvm, swift, others
  if (w0 === "dotnet") {
    if (sub1 === "test") return { runner: "dotnet test", category: "test", scope: flagValuePresent(rest, "--filter") ? "subset" : "all", quiet: false, notRun: notRun ?? (rest.includes("--list-tests") || rest.includes("-t") ? "list" : null) };
    if (sub1 === "build") return { runner: "dotnet build", category: "build", scope: "all", quiet: false, notRun };
    if (sub1 === "format") return { runner: "dotnet format", category: "lint", scope: "all", quiet: false, notRun: rest.includes("--verify-no-changes") ? notRun : "format" };
    return null;
  }
  if (w0 === "mvn" || w0 === "mvnw") {
    const goals = positionals(words, 1);
    if (goals.some((g) => g === "test" || g === "verify" || g === "integration-test")) return { runner: `${w0} test`, category: "test", scope: rest.some((w) => w.startsWith("-Dtest=")) ? "subset" : "all", quiet: quietIn(rest), notRun };
    if (goals.some((g) => g === "package" || g === "compile" || g === "install" || g === "deploy")) return { runner: `${w0} ${goals[0]}`, category: "build", scope: "all", quiet: quietIn(rest), notRun };
    return null;
  }
  if (w0 === "gradle" || w0 === "gradlew") {
    const tasks = positionals(words, 1);
    if (tasks.some((t) => /^(:?[\w-]+:)*(test|check|connectedAndroidTest|jvmTest|allTests)$/.test(t))) return { runner: `${w0} test`, category: "test", scope: rest.includes("--tests") ? "subset" : "all", quiet: quietIn(rest), notRun: notRun ?? (rest.includes("--continuous") || rest.includes("-t") ? "watch" : null) };
    if (tasks.some((t) => /^(:?[\w-]+:)*(build|assemble\w*|compile\w*|jar|bundle\w*)$/.test(t))) return { runner: `${w0} build`, category: "build", scope: "all", quiet: quietIn(rest), notRun };
    if (tasks.some((t) => /^(:?[\w-]+:)*(ktlintCheck|detekt|lint\w*|spotlessCheck|checkstyle\w*)$/.test(t))) return { runner: `${w0} lint`, category: "lint", scope: "all", quiet: quietIn(rest), notRun };
    return null;
  }
  if (w0 === "sbt") {
    if (rest.includes("test") || rest.includes("testOnly")) return { runner: "sbt test", category: "test", scope: rest.includes("testOnly") ? "subset" : "all", quiet: false, notRun };
    if (rest.includes("compile")) return { runner: "sbt compile", category: "build", scope: "all", quiet: false, notRun };
    return null;
  }
  if (w0 === "swift") {
    if (sub1 === "test") return { runner: "swift test", category: "test", scope: flagValuePresent(rest, "--filter") ? "subset" : "all", quiet: false, notRun: notRun ?? (rest.includes("--list-tests") || rest.includes("-l") ? "list" : null) };
    if (sub1 === "build") return { runner: "swift build", category: "build", scope: "all", quiet: false, notRun };
    return null;
  }
  if (w0 === "xcodebuild") {
    if (rest.includes("test") || rest.includes("test-without-building")) return { runner: "xcodebuild test", category: "test", scope: rest.some((w) => w.startsWith("-only-testing")) ? "subset" : "all", quiet: false, notRun };
    return { runner: "xcodebuild", category: "build", scope: "all", quiet: false, notRun };
  }
  if (w0 === "swiftlint") return { runner: "swiftlint", category: "lint", scope: "all", quiet: false, notRun: sub1 === "--fix" || sub1 === "autocorrect" ? "format" : notRun };
  if (w0 === "flutter" || w0 === "dart") {
    if (sub1 === "test") return { runner: `${w0} test`, category: "test", scope: hasFileArgs(words, 2) || flagValuePresent(rest, "--name", "-n", "--plain-name") ? "subset" : "all", quiet: false, notRun };
    if (sub1 === "build") return { runner: `${w0} build`, category: "build", scope: "all", quiet: false, notRun };
    if (sub1 === "analyze") return { runner: `${w0} analyze`, category: "lint", scope: "all", quiet: false, notRun };
    return null;
  }
  if (w0 === "mix") {
    if (sub1 === "test") return { runner: "mix test", category: "test", scope: hasFileArgs(words, 2) || flagValuePresent(rest, "--only", "--failed") ? "subset" : "all", quiet: false, notRun };
    if (sub1 === "compile") return { runner: "mix compile", category: "build", scope: "all", quiet: false, notRun };
    if (sub1 === "credo") return { runner: "mix credo", category: "lint", scope: "all", quiet: false, notRun };
    if (sub1 === "dialyzer") return { runner: "mix dialyzer", category: "typecheck", scope: "all", quiet: false, notRun };
    if (sub1 === "format") return { runner: "mix format", category: "lint", scope: "all", quiet: false, notRun: rest.includes("--check-formatted") ? notRun : "format" };
    return null;
  }
  if (w0 === "rspec") {
    const subset = hasFileArgs(words, 1) || positionals(words, 1).some((p) => /:\d+$/.test(p)) || flagValuePresent(rest, "-e", "--example", "-t", "--tag", "--only-failures", "-n", "--next-failure");
    return { runner: "rspec", category: "test", scope: subset ? "subset" : "all", quiet: false, notRun: notRun ?? (rest.includes("--dry-run") ? "dry-run" : null) };
  }
  if (w0 === "rake" && (sub1 === "test" || sub1 === "spec" || sub1 === "")) return { runner: `rake ${sub1 || "default"}`, category: "test", scope: "all", quiet: false, notRun };
  if (w0 === "rails" && sub1 === "test") return { runner: "rails test", category: "test", scope: hasFileArgs(words, 2) ? "subset" : "all", quiet: false, notRun };
  if (w0 === "rubocop") return { runner: "rubocop", category: "lint", scope: hasFileArgs(words, 1) ? "subset" : "all", quiet: false, notRun };
  if (w0 === "srb" && sub1 === "tc") return { runner: "srb tc", category: "typecheck", scope: "all", quiet: false, notRun };
  if (w0 === "phpunit" || w0 === "pest" || w0 === "paratest") return { runner: w0, category: "test", scope: hasFileArgs(words, 1) || flagValuePresent(rest, "--filter", "--group") ? "subset" : "all", quiet: false, notRun };
  if (w0 === "php" && basename(sub1) === "artisan" && words[2] === "test") return { runner: "artisan test", category: "test", scope: flagValuePresent(rest, "--filter") ? "subset" : "all", quiet: false, notRun };
  if (w0 === "artisan" && sub1 === "test") return { runner: "artisan test", category: "test", scope: flagValuePresent(rest, "--filter") ? "subset" : "all", quiet: false, notRun };
  if (w0 === "composer" && (sub1 === "test" || sub1 === "lint")) return { runner: `composer ${sub1}`, category: sub1 === "test" ? "test" : "lint", scope: "all", quiet: false, notRun };
  if (w0 === "phpstan" || w0 === "psalm") return { runner: w0, category: "typecheck", scope: hasFileArgs(words, 1) ? "subset" : "all", quiet: false, notRun: w0 === "phpstan" && sub1 !== "analyse" && sub1 !== "analyze" && sub1 !== "" && !sub1.startsWith("-") ? "other" : notRun };
  if (w0 === "phpcs" || w0 === "pint" || w0 === "php-cs-fixer") {
    const check = w0 === "phpcs" || rest.includes("--test") || rest.includes("--dry-run");
    return { runner: w0, category: "lint", scope: hasFileArgs(words, 1) ? "subset" : "all", quiet: false, notRun: check ? notRun : "format" };
  }
  if (w0 === "ctest") return { runner: "ctest", category: "test", scope: flagValuePresent(rest, "-R", "-L", "-E") ? "subset" : "all", quiet: false, notRun: notRun ?? (rest.includes("-N") || rest.includes("--show-only") ? "list" : null) };
  if (w0 === "cmake" && sub1 === "--build") return { runner: "cmake --build", category: "build", scope: "all", quiet: false, notRun };
  if (w0 === "ninja" || w0 === "meson") return { runner: w0, category: w0 === "meson" && sub1 === "test" ? "test" : "build", scope: "all", quiet: false, notRun };
  if (w0 === "bazel" || w0 === "bazelisk" || w0 === "buck2") {
    if (sub1 === "test") return { runner: `${w0} test`, category: "test", scope: positionals(words, 2).some((p) => !p.endsWith("...")) ? "subset" : "all", quiet: false, notRun };
    if (sub1 === "build") return { runner: `${w0} build`, category: "build", scope: "all", quiet: false, notRun };
    return null;
  }
  if (w0 === "zig" && sub1 === "build") return { runner: rest.includes("test") ? "zig build test" : "zig build", category: rest.includes("test") ? "test" : "build", scope: "all", quiet: false, notRun };
  if (w0 === "stack" || w0 === "cabal") {
    if (sub1 === "test") return { runner: `${w0} test`, category: "test", scope: "all", quiet: false, notRun };
    if (sub1 === "build") return { runner: `${w0} build`, category: "build", scope: "all", quiet: false, notRun };
    return null;
  }
  if (w0 === "lein" && sub1 === "test") return { runner: "lein test", category: "test", scope: "all", quiet: false, notRun };
  if (w0 === "elm" && sub1 === "make") return { runner: "elm make", category: "build", scope: "all", quiet: false, notRun };
  if (w0 === "elm-test") return { runner: "elm-test", category: "test", scope: "all", quiet: false, notRun };
  if (w0 === "docker" && sub1 === "build") return { runner: "docker build", category: "build", scope: "all", quiet: quietIn(rest), notRun };
  if (w0 === "docker" && sub1 === "compose" && words[2] === "build") return { runner: "docker compose build", category: "build", scope: "all", quiet: quietIn(rest), notRun };
  if (w0 === "docker-compose" && sub1 === "build") return { runner: "docker compose build", category: "build", scope: "all", quiet: quietIn(rest), notRun };
  if (w0 === "shellcheck" || w0 === "hadolint" || w0 === "yamllint" || w0 === "actionlint" || w0 === "ktlint" || w0 === "detekt" || w0 === "clang-tidy" || w0 === "cppcheck") {
    return { runner: w0, category: "lint", scope: hasFileArgs(words, 1) ? "subset" : "all", quiet: false, notRun: w0 === "ktlint" && (rest.includes("-F") || rest.includes("--format")) ? "format" : notRun };
  }
  if (w0 === "clang-format" || w0 === "swift-format") return { runner: w0, category: "lint", scope: hasFileArgs(words, 1) ? "subset" : "all", quiet: false, notRun: rest.includes("--dry-run") || rest.includes("-n") || rest.includes("lint") ? notRun : "format" };
  return null;
}

// ---------------------------------------------------------------------------
// Wrapper stripping and command-line detection
// ---------------------------------------------------------------------------

const SIMPLE_WRAPPERS = new Set(["time", "nice", "command", "exec", "nohup", "caffeinate", "xvfb-run", "stdbuf", "unbuffer", "script", "chronic", "ionice", "hyperfine"]);
const CROSS_ENV = new Set(["cross-env", "dotenv", "dotenvx", "direnv"]);

export interface Stripped {
  words: string[];
  sudo: boolean;
  cd: string | null;
  nested: string | null;
}

/** Removes environment and wrapper prefixes so that words[0] is the runner. */
export function stripWrappers(input: string[]): Stripped {
  let w = stripGroupingWords(input);
  let sudo = false;
  let cd: string | null = null;
  let nested: string | null = null;
  let guard = 0;
  while (w.length > 0 && guard++ < 12) {
    const first = basename(w[0] as string);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      w = w.slice(1);
      continue;
    }
    if (first === "sudo" || first === "doas") {
      sudo = true;
      let i = 1;
      while (i < w.length && (w[i] as string).startsWith("-")) {
        const f = w[i] as string;
        if (f === "-u" || f === "-g" || f === "--user" || f === "--group") i++;
        i++;
      }
      w = w.slice(i);
      continue;
    }
    if (first === "env") {
      let i = 1;
      while (i < w.length && ((w[i] as string).startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i] as string))) i++;
      w = w.slice(i);
      continue;
    }
    if (CROSS_ENV.has(first)) {
      let i = 1;
      if (first === "dotenv" || first === "dotenvx") {
        while (i < w.length && (w[i] as string).startsWith("-")) {
          const f = w[i] as string;
          if (f === "-e" || f === "-f" || f === "--env-file") i++;
          i++;
        }
        if (w[i] === "run") i++;
        if (w[i] === "--") i++;
      } else if (first === "direnv") {
        if (w[i] === "exec") i += 2;
      } else {
        while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i] as string)) i++;
      }
      w = w.slice(i);
      continue;
    }
    if (first === "timeout" || first === "gtimeout") {
      let i = 1;
      while (i < w.length && (w[i] as string).startsWith("-")) {
        const f = w[i] as string;
        if (f === "-s" || f === "--signal" || f === "-k" || f === "--kill-after") i++;
        i++;
      }
      i++;
      w = w.slice(i);
      continue;
    }
    if (SIMPLE_WRAPPERS.has(first)) {
      let i = 1;
      while (i < w.length && (w[i] as string).startsWith("-")) {
        const f = w[i] as string;
        if (f === "-n" || f === "-o" || f === "-e" || f === "-s" || f === "--server-args" || f === "-a" || f === "-c") i++;
        i++;
      }
      w = w.slice(i);
      continue;
    }
    if (first === "npx" || first === "bunx" || first === "pnpx" || first === "uvx" || first === "pipx") {
      let i = 1;
      while (i < w.length && (w[i] as string).startsWith("-")) {
        const f = w[i] as string;
        if (f === "-p" || f === "--package" || f === "-c" || f === "--call" || f === "--spec") i++;
        i++;
      }
      if (w[i] === "run" && first === "pipx") i++;
      w = w.slice(i);
      continue;
    }
    if ((first === "pnpm" || first === "yarn" || first === "npm" || first === "bun") && (w[1] === "exec" || w[1] === "dlx" || w[1] === "x") && w[2]) {
      let i = 2;
      while (i < w.length && (w[i] as string).startsWith("-")) i++;
      if (w[i] === "--") i++;
      w = w.slice(i);
      continue;
    }
    if (first === "bundle" && w[1] === "exec" && w[2]) {
      w = w.slice(2);
      continue;
    }
    if ((first === "uv" || first === "poetry" || first === "pipenv" || first === "hatch" || first === "pdm" || first === "rye" || first === "conda" || first === "micromamba") && w[1] === "run") {
      let i = 2;
      while (i < w.length && (w[i] as string).startsWith("-")) {
        const f = w[i] as string;
        if (f === "-n" || f === "--name" || f === "-p" || f === "--python" || f === "--with" || f === "--env" || f === "--prefix") i++;
        i++;
      }
      if (w[i] === "--") i++;
      w = w.slice(i);
      continue;
    }
    if (first === "uv" && w[1] === "build") {
      w = ["build"];
      continue;
    }
    if (/^python[0-9.]*$/.test(first) || first === "py" || first === "pypy3") {
      if (w[1] === "-m" && w[2]) {
        w = w.slice(2);
        continue;
      }
      if (w[1] && basename(w[1] as string) === "manage.py") {
        w = w.slice(1);
        continue;
      }
      if (w[1] === "-W" || w[1] === "-X") {
        w = [w[0] as string, ...w.slice(3)];
        continue;
      }
      return { words: w, sudo, cd, nested };
    }
    if (first === "node" && w[1] && !(w[1] as string).startsWith("-")) {
      const target = basename(w[1] as string);
      if (/^(jest|vitest|mocha|tsc|eslint|ava)(\.js|\.cjs|\.mjs)?$/.test(target)) {
        w = [target.replace(/\.(c|m)?js$/, ""), ...w.slice(2)];
        continue;
      }
      return { words: w, sudo, cd, nested };
    }
    if (first === "c8" || first === "nyc" || first === "coverage") {
      let i = 1;
      if (first === "coverage" && w[1] === "run") {
        i = 2;
        while (i < w.length && (w[i] as string).startsWith("-")) {
          if (w[i] === "--source" || w[i] === "--include" || w[i] === "--omit" || w[i] === "--data-file" || w[i] === "--context") i++;
          i++;
        }
        if (w[i] === "-m") i++;
      } else {
        while (i < w.length && (w[i] as string).startsWith("-")) {
          const f = w[i] as string;
          if (f === "-r" || f === "--reporter" || f === "-o" || f === "--reports-dir" || f === "-x" || f === "--exclude" || f === "--include" || f === "-n") i++;
          i++;
        }
      }
      if (w[i] === "--") i++;
      w = w.slice(i);
      continue;
    }
    if ((first === "bash" || first === "sh" || first === "zsh" || first === "dash" || first === "ksh") && w[1] && /^-[a-zA-Z]*c$/.test(w[1] as string) && w[2] !== undefined) {
      nested = w[2] as string;
      break;
    }
    if ((first === "cd" || first === "pushd") && w[1]) {
      cd = w[1] as string;
      w = w.slice(2);
      continue;
    }
    if (first === "pnpm" || first === "npm" || first === "make") {
      const i = w.findIndex((x) => x === "-C" || x === "--dir" || x === "--prefix" || x === "--directory");
      if (i > 0 && w[i + 1]) {
        cd = w[i + 1] as string;
        w = [...w.slice(0, i), ...w.slice(i + 2)];
        continue;
      }
    }
    break;
  }
  return { words: w, sudo, cd, nested };
}

/** Resolves the runner segment's directory relative to the session cwd. */
function joinCd(base: string | null, next: string | null): string | null {
  if (!next) return base;
  if (next === "-" || next === "~" || next.startsWith("~/")) return next;
  if (next.startsWith("/")) return next;
  if (!base) return next;
  return base.replace(/\/+$/, "") + "/" + next;
}

/** Finds every verification runner in a command line. */
export function detectAll(command: string, parsed?: ParsedCommand): Detection[] {
  const p = parsed ?? parseCommand(command);
  const out: Detection[] = [];
  let cd: string | null = null;
  for (let i = 0; i < p.segments.length; i++) {
    const seg = p.segments[i] as Segment;
    const words = stripGroupingWords(seg.words);
    if (words.length === 0) continue;
    if ((words[0] === "cd" || words[0] === "pushd") && words.length === 2) {
      cd = joinCd(cd, words[1] as string);
      continue;
    }
    if (words[0] === "export" || words[0] === "set" || words[0] === "source" || words[0] === ".") continue;
    const stripped = stripWrappers(words);
    if (stripped.nested) {
      const inner = detectAll(stripped.nested);
      for (const d of inner) {
        out.push({ ...d, segmentIndex: i, segment: seg, cd: joinCd(joinCd(cd, stripped.cd), d.cd), sudo: stripped.sudo || d.sudo, nested: true, inner: d.inner ?? { command: stripped.nested, index: d.segmentIndex } });
      }
      continue;
    }
    const cls = classify(stripped.words);
    if (!cls) continue;
    out.push({ ...cls, segmentIndex: i, segment: seg, words: stripped.words, cd: joinCd(cd, stripped.cd), sudo: stripped.sudo, nested: false });
  }
  return out;
}

/** The first verification runner in a command line that is an actual run, or null. */
export function detect(command: string): Detection | null {
  const all = detectAll(command);
  return all.find((d) => d.notRun === null) ?? null;
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

interface Signal {
  id: string;
  category: Category | "*";
  kind: "pass" | "fail" | "notrun";
  re: RegExp;
}

// Fail signals name a concrete failure. Pass signals are the runner's own positive summary.
const SIGNALS: Signal[] = [
  // --- test: pytest and unittest
  { id: "pytest-failed-summary", category: "test", kind: "fail", re: /^=+ .*\b[1-9]\d* (?:failed|errors?)\b.* =+\s*$/m },
  { id: "pytest-failed-line", category: "test", kind: "fail", re: /^(?:FAILED|ERROR) [^\n]*::/m },
  { id: "pytest-short-failed", category: "test", kind: "fail", re: /^\s*[1-9]\d* failed(?:, \d+ passed)?(?:, \d+ \w+)* in [\d.]+s/m },
  { id: "pytest-passed", category: "test", kind: "pass", re: /^=+ (\d+) passed(?:, \d+ (?:skipped|deselected|xfailed|xpassed|warnings?|subtests? passed|rerun)|, 0 (?:failed|errors?))* in [\d.]+s(?: \([^)]*\))? =+\s*$/m },
  { id: "pytest-short-passed", category: "test", kind: "pass", re: /^\s*(\d+) passed(?:, \d+ (?:skipped|deselected|xfailed|xpassed|warnings?)|, 0 (?:failed|errors?))* in [\d.]+s\s*$/m },
  { id: "pytest-no-tests", category: "test", kind: "notrun", re: /^=+ no tests ran in [\d.]+s =+|collected 0 items|^=+ \d+ deselected in [\d.]+s =+/m },
  { id: "unittest-failed", category: "test", kind: "fail", re: /^FAILED \((?:failures|errors|unexpected successes)=\d+/m },
  { id: "unittest-ok", category: "test", kind: "pass", re: /^Ran (\d+) tests? in [\d.]+s\s*\n\s*\nOK(?: \((?:skipped|expected failures)=\d+(?:, (?:skipped|expected failures)=\d+)?\))?\s*$/m },
  { id: "unittest-no-tests", category: "test", kind: "notrun", re: /^Ran 0 tests in [\d.]+s/m },
  // --- test: jest and vitest
  { id: "jest-failed", category: "test", kind: "fail", re: /^\s*(?:Tests|Test Suites):\s+(?:[^\n]*, )?[1-9]\d* failed/m },
  { id: "jest-passed", category: "test", kind: "pass", re: /^\s*Tests:\s+(?:(?:\d+ (?:skipped|todo)|0 failed), )*(\d+) passed, (\d+) total\s*$/m },
  { id: "jest-no-tests", category: "test", kind: "notrun", re: /^No tests found, exiting with code (?:0|1)|^\s*Tests:\s+0 total/m },
  { id: "vitest-failed", category: "test", kind: "fail", re: /^\s*(?:Tests|Test Files)\s+(?:[^\n|]*\| )?[1-9]\d* failed/m },
  { id: "vitest-error", category: "test", kind: "fail", re: /^\s*Errors\s+[1-9]\d* errors?\b/m },
  { id: "vitest-passed", category: "test", kind: "pass", re: /^\s*Tests\s+(?:0 failed \| )?(\d+) passed(?: \| \d+ (?:skipped|todo))* \((\d+)\)\s*$/m },
  { id: "vitest-no-tests", category: "test", kind: "notrun", re: /^No test files found, exiting with code|^\s*Test Files\s+no tests/m },
  // --- test: mocha, ava, node, bun, deno, playwright, cypress, jasmine, tap
  { id: "mocha-failing", category: "test", kind: "fail", re: /^\s*[1-9]\d* failing\s*$/m },
  { id: "mocha-passing", category: "test", kind: "pass", re: /^\s*(\d+) passing\b/m },
  { id: "ava-failed", category: "test", kind: "fail", re: /^\s*(?:[1-9]\d* tests? failed|[1-9]\d* uncaught exceptions?|[1-9]\d* unhandled rejections?)/m },
  { id: "ava-passed", category: "test", kind: "pass", re: /^\s*(\d+) tests? passed\s*$/m },
  { id: "node-test-fail", category: "test", kind: "fail", re: /^# fail [1-9]\d*/m },
  { id: "node-test-pass", category: "test", kind: "pass", re: /^# pass (\d+)\s*$/m },
  { id: "bun-fail", category: "test", kind: "fail", re: /^\s*[1-9]\d* fail\s*$/m },
  { id: "bun-pass", category: "test", kind: "pass", re: /^\s*(\d+) pass\s*$/m },
  { id: "deno-fail", category: "test", kind: "fail", re: /^(?:FAILED|error:) \| \d+ passed \| [1-9]\d* failed|^FAILED \|/m },
  { id: "deno-pass", category: "test", kind: "pass", re: /^ok \| (\d+) passed(?: \([^)]*\))? \| 0 failed/m },
  { id: "playwright-failed", category: "test", kind: "fail", re: /^\s*[1-9]\d* failed\s*$|^\s*[1-9]\d* (?:flaky|did not run)\s*$/m },
  { id: "playwright-passed", category: "test", kind: "pass", re: /^\s*(\d+) passed \([\d.]+m?s\)\s*$/m },
  { id: "cypress-failed", category: "test", kind: "fail", re: /✖ +[1-9]\d* of \d+ failed/m },
  { id: "cypress-passed", category: "test", kind: "pass", re: /✔ +All specs passed!/m },
  { id: "jasmine-failed", category: "test", kind: "fail", re: /^\d+ specs?, [1-9]\d* failures?/m },
  { id: "jasmine-passed", category: "test", kind: "pass", re: /^(\d+) specs?, 0 failures/m },
  { id: "tap-fail", category: "test", kind: "fail", re: /^# fail\s+[1-9]\d*|^not ok /m },
  { id: "tap-pass", category: "test", kind: "pass", re: /^# pass\s+(\d+)\s*$/m },
  // --- test: go, cargo, dotnet, jvm, ruby, php, elixir, swift, dart, others
  { id: "go-fail", category: "test", kind: "fail", re: /^(?:FAIL|--- FAIL)\b|^FAIL\t/m },
  { id: "go-build-failed", category: "test", kind: "fail", re: /^\[build failed\]|\[setup failed\]/m },
  { id: "go-ok", category: "test", kind: "pass", re: /^(?:ok\s|PASS\s*$)/m },
  { id: "go-no-tests", category: "test", kind: "notrun", re: /^\?\s+\S+\s+\[no test files\]\s*$(?![\s\S]*^ok\s)/m },
  { id: "cargo-test-failed", category: "test", kind: "fail", re: /^test result: FAILED|^error: test failed|^error\[E\d+\]|^error: could not compile/m },
  { id: "cargo-test-ok", category: "test", kind: "pass", re: /^test result: ok\. (\d+) passed; (\d+) failed/m },
  { id: "nextest-failed", category: "test", kind: "fail", re: /^\s*Summary \[[^\]]*\]\s+\d+ tests? run: \d+ passed, [1-9]\d* failed/m },
  { id: "nextest-passed", category: "test", kind: "pass", re: /^\s*Summary \[[^\]]*\]\s+(\d+) tests? run: (\d+) passed(?: \(\d+ slow\))?(?:, \d+ skipped)?\s*$/m },
  { id: "dotnet-failed", category: "test", kind: "fail", re: /^Failed!\s+- Failed:\s+[1-9]|^Total tests: \d+\. Passed: \d+\. Failed: [1-9]|^\s*Failed \S+ \[|^\s*failed: [1-9]\d*/m },
  { id: "dotnet-passed", category: "test", kind: "pass", re: /^Passed!\s+- Failed:\s+0, Passed:\s+(\d+)|^Total tests: (\d+)\. Passed: \d+\. Failed: 0|^Test summary: total: \d+, failed: 0, succeeded: (\d+)/m },
  { id: "maven-failed", category: "test", kind: "fail", re: /Tests run: \d+, Failures: [1-9]\d*|Tests run: \d+, Failures: \d+, Errors: [1-9]\d*|^\[(?:ERROR|INFO)\] BUILD FAILURE|There are test failures/m },
  { id: "maven-passed", category: "test", kind: "pass", re: /^\[INFO\] Tests run: (\d+), Failures: 0, Errors: 0(?:, Skipped: \d+)?\s*$[\s\S]*^\[INFO\] BUILD SUCCESS/m },
  { id: "gradle-test-failed", category: "test", kind: "fail", re: /^\d+ tests completed, [1-9]\d* failed|^BUILD FAILED|FAILED\s*$/m },
  { id: "gradle-test-passed", category: "test", kind: "pass", re: /^BUILD SUCCESSFUL/m },
  { id: "rspec-failed", category: "test", kind: "fail", re: /^\d+ examples?, [1-9]\d* failures?|[1-9]\d* errors? occurred outside of examples/m },
  { id: "rspec-passed", category: "test", kind: "pass", re: /^(\d+) examples?, 0 failures(?:, \d+ pending)?\s*$/m },
  { id: "minitest-failed", category: "test", kind: "fail", re: /^\d+ runs, \d+ assertions, [1-9]\d* failures|^\d+ runs, \d+ assertions, \d+ failures, [1-9]\d* errors/m },
  { id: "minitest-passed", category: "test", kind: "pass", re: /^(\d+) runs, \d+ assertions, 0 failures, 0 errors/m },
  { id: "phpunit-failed", category: "test", kind: "fail", re: /^(?:FAILURES|ERRORS)!|Tests: \d+, Assertions: \d+, (?:Failures|Errors): [1-9]/m },
  { id: "phpunit-passed", category: "test", kind: "pass", re: /^OK \((\d+) tests?, \d+ assertions?\)|^Tests:\s+(\d+) passed \(\d+ assertions?\)\s*$/m },
  { id: "mix-failed", category: "test", kind: "fail", re: /^\d+ (?:tests?|doctests?|properties)(?:, \d+ (?:doctests?|properties|tests?))*, [1-9]\d* failures?/m },
  { id: "mix-passed", category: "test", kind: "pass", re: /^(\d+) (?:tests?|doctests?|properties)(?:, \d+ (?:doctests?|properties|tests?))*, 0 failures(?:, \d+ (?:excluded|skipped))*\s*$/m },
  { id: "swift-test-failed", category: "test", kind: "fail", re: /Executed \d+ tests?, with [1-9]\d* failures?|Test Suite '[^']+' failed|✘ Test run with \d+ tests? failed/m },
  { id: "swift-test-passed", category: "test", kind: "pass", re: /Executed (\d+) tests?, with 0 failures|Test Suite 'All tests' passed|✔ Test run with (\d+) tests? passed/m },
  { id: "dart-test-failed", category: "test", kind: "fail", re: /Some tests failed\./m },
  { id: "dart-test-passed", category: "test", kind: "pass", re: /\+(\d+)(?: ~\d+)?: All tests passed!/m },
  { id: "ctest-failed", category: "test", kind: "fail", re: /^\d+% tests passed, [1-9]\d* tests? failed out of \d+/m },
  { id: "ctest-passed", category: "test", kind: "pass", re: /^100% tests passed, 0 tests failed out of (\d+)/m },
  { id: "bazel-failed", category: "test", kind: "fail", re: /^Executed \d+ out of \d+ tests?: \d+ tests? pass(?:es)? and [1-9]\d* fail|FAILED: Build did NOT complete successfully/m },
  { id: "bazel-passed", category: "test", kind: "pass", re: /^Executed (\d+) out of \d+ tests?: (\d+) tests? pass(?:es)?\.|^INFO: Build completed successfully, \d+ total actions/m },
  { id: "elm-test-failed", category: "test", kind: "fail", re: /^TEST RUN FAILED/m },
  { id: "elm-test-passed", category: "test", kind: "pass", re: /^TEST RUN PASSED/m },
  { id: "sbt-test-failed", category: "test", kind: "fail", re: /^\[error\] Failed: Total \d+, Failed [1-9]|^\[error\] Failed tests:/m },
  { id: "sbt-test-passed", category: "test", kind: "pass", re: /^\[info\] Passed: Total (\d+), Failed 0/m },
  { id: "generic-test-no-tests", category: "test", kind: "notrun", re: /^No tests found\b|^No test files found\b|^0 tests? (?:ran|run|executed)\b/m },
  // Home-grown runners tend to print one of these.
  { id: "generic-test-failed", category: "test", kind: "fail", re: /^\s*\d+ passed, [1-9]\d* failed\b|^\s*[1-9]\d* (?:tests? )?failed, \d+ passed\b|^\s*(?:Tests|Results?): \d+ passed, [1-9]\d* failed/m },
  { id: "generic-test-passed", category: "test", kind: "pass", re: /^\s*(\d+) passed, 0 failed\b|^\s*0 failed, (\d+) passed\b|^\s*(?:Tests|Results?): (\d+) passed, 0 failed\b|^\s*All (\d+) tests? passed\b/m },
  // --- typecheck
  { id: "tsc-error", category: "typecheck", kind: "fail", re: /error TS\d{3,5}:|^Found [1-9]\d* errors?(?: in| \.)/m },
  { id: "tsc-found-zero", category: "typecheck", kind: "pass", re: /^Found 0 errors\./m },
  { id: "svelte-check-errors", category: "typecheck", kind: "fail", re: /svelte-check found [1-9]\d* errors?/m },
  { id: "svelte-check-ok", category: "typecheck", kind: "pass", re: /svelte-check found 0 errors and (\d+) warnings?/m },
  { id: "mypy-found", category: "typecheck", kind: "fail", re: /^Found [1-9]\d* errors? in \d+ files?/m },
  { id: "mypy-ok", category: "typecheck", kind: "pass", re: /^Success: no issues found in \d+ source files?/m },
  { id: "pyright-errors", category: "typecheck", kind: "fail", re: /^[1-9]\d* errors?, \d+ warnings?/m },
  { id: "pyright-ok", category: "typecheck", kind: "pass", re: /^0 errors, \d+ warnings?/m },
  { id: "flow-errors", category: "typecheck", kind: "fail", re: /^Found [1-9]\d* errors?\s*$/m },
  { id: "flow-ok", category: "typecheck", kind: "pass", re: /^No errors!\s*$/m },
  { id: "cargo-check-error", category: "typecheck", kind: "fail", re: /^error(?:\[E\d+\])?: |^error: could not compile/m },
  { id: "cargo-check-ok", category: "typecheck", kind: "pass", re: /^\s*Finished `?(?:dev|release|test)/m },
  { id: "deno-check-error", category: "typecheck", kind: "fail", re: /^error: TS\d+/m },
  { id: "phpstan-errors", category: "typecheck", kind: "fail", re: /\[ERROR\] Found [1-9]\d* errors?/m },
  { id: "phpstan-ok", category: "typecheck", kind: "pass", re: /\[OK\] No errors/m },
  { id: "sorbet-errors", category: "typecheck", kind: "fail", re: /^Errors: [1-9]\d*/m },
  { id: "sorbet-ok", category: "typecheck", kind: "pass", re: /^No errors! Great job\./m },
  { id: "dialyzer-errors", category: "typecheck", kind: "fail", re: /^Total errors: [1-9]\d*/m },
  { id: "dialyzer-ok", category: "typecheck", kind: "pass", re: /^done \(passed successfully\)/m },
  // --- lint
  { id: "eslint-problems", category: "lint", kind: "fail", re: /✖ [1-9]\d* problems? \([1-9]\d* errors?/m },
  { id: "eslint-config-error", category: "lint", kind: "fail", re: /^Oops! Something went wrong!|ESLint couldn't find|Error: Cannot find module/m },
  { id: "eslint-no-files", category: "lint", kind: "notrun", re: /^No files matching the pattern|Please check for typing mistakes in the pattern\./m },
  { id: "biome-errors", category: "lint", kind: "fail", re: /^Found [1-9]\d* errors?\.\s*$|^Checked \d+ files? in [^\n]*\. Found [1-9]\d* errors?/m },
  { id: "biome-ok", category: "lint", kind: "pass", re: /^Checked (\d+) files? in [^\n]*\. No fixes (?:needed|applied)\.|^Checked (\d+) files? in [^\n]*\. Fixed \d+ files?\./m },
  { id: "ruff-found", category: "lint", kind: "fail", re: /^Found [1-9]\d* errors?\.?\s*(?:\(\d+ fixable[^)]*\))?\s*$|^Found [1-9]\d* errors? \(\d+ fixed, [1-9]\d* remaining\)/m },
  { id: "ruff-ok", category: "lint", kind: "pass", re: /^All checks passed!|^Found \d+ errors? \(\d+ fixed, 0 remaining\)/m },
  { id: "ruff-format-would", category: "lint", kind: "fail", re: /^[1-9]\d* files? would be reformatted/m },
  { id: "ruff-format-ok", category: "lint", kind: "pass", re: /^(\d+) files? already formatted\s*$/m },
  { id: "black-would", category: "lint", kind: "fail", re: /^would reformat |^[1-9]\d* files? would be reformatted/m },
  { id: "black-ok", category: "lint", kind: "pass", re: /^All done! .*\n(\d+) files? would be left unchanged\./m },
  { id: "isort-error", category: "lint", kind: "fail", re: /^ERROR: .* Imports are incorrectly sorted/m },
  { id: "flake8-violation", category: "lint", kind: "fail", re: /^[^\s:]+:\d+:\d+: [A-Z]+\d{1,4} /m },
  { id: "pylint-message", category: "lint", kind: "fail", re: /^[^\s:]+:\d+:\d+: [CEFRW]\d{4}:/m },
  { id: "pylint-ok", category: "lint", kind: "pass", re: /Your code has been rated at 10\.00\/10/m },
  { id: "golangci-issues", category: "lint", kind: "fail", re: /^[1-9]\d* issues:|^[^\s:]+\.go:\d+:\d+: /m },
  { id: "golangci-ok", category: "lint", kind: "pass", re: /^0 issues\.\s*$/m },
  { id: "govet-error", category: "lint", kind: "fail", re: /^(?:vet: )?[^\s:]+\.go:\d+:\d+: /m },
  { id: "clippy-error", category: "lint", kind: "fail", re: /^error(?:\[E\d+\])?: |^error: could not compile/m },
  { id: "clippy-ok", category: "lint", kind: "pass", re: /^\s*Finished `?(?:dev|release|test)/m },
  { id: "rustfmt-diff", category: "lint", kind: "fail", re: /^Diff in /m },
  { id: "rubocop-offenses", category: "lint", kind: "fail", re: /[1-9]\d* offenses? detected/m },
  { id: "rubocop-ok", category: "lint", kind: "pass", re: /^(\d+) files? inspected, no offenses detected/m },
  { id: "oxlint-errors", category: "lint", kind: "fail", re: /Found \d+ warnings? and [1-9]\d* errors?/m },
  { id: "oxlint-ok", category: "lint", kind: "pass", re: /Found \d+ warnings? and 0 errors/m },
  { id: "prettier-issues", category: "lint", kind: "fail", re: /\[warn\] Code style issues found in|^Code style issues found/m },
  { id: "prettier-ok", category: "lint", kind: "pass", re: /All matched files use Prettier code style!/m },
  { id: "shellcheck-issue", category: "lint", kind: "fail", re: /^In [^\n]+ line \d+:/m },
  { id: "phpcs-errors", category: "lint", kind: "fail", re: /FOUND [1-9]\d* ERRORS?/m },
  { id: "credo-issues", category: "lint", kind: "fail", re: /^Analysis took [\d.]+ seconds .*\n.*[1-9]\d* (?:code readability issues?|refactoring opportunit|warnings?|software design suggestions?|consistency issues?)/m },
  { id: "credo-ok", category: "lint", kind: "pass", re: /found no issues\./m },
  { id: "swiftlint-violations", category: "lint", kind: "fail", re: /Found [1-9]\d* violations?, [1-9]\d* serious/m },
  { id: "swiftlint-ok", category: "lint", kind: "pass", re: /Done linting! Found (\d+) violations?, 0 serious/m },
  { id: "dart-analyze-issues", category: "lint", kind: "fail", re: /^[1-9]\d* issues? found\./m },
  { id: "dart-analyze-ok", category: "lint", kind: "pass", re: /^No issues found!/m },
  { id: "ktlint-violation", category: "lint", kind: "fail", re: /^[^\s:]+\.kts?:\d+:\d+: /m },
  { id: "detekt-issues", category: "lint", kind: "fail", re: /Build failed with [1-9]\d* weighted issues/m },
  { id: "hadolint-issue", category: "lint", kind: "fail", re: /^[^\s:]+:\d+ (?:DL|SC)\d{4} /m },
  { id: "yamllint-issue", category: "lint", kind: "fail", re: /^\s+\d+:\d+\s+error\s+/m },
  { id: "checkstyle-errors", category: "lint", kind: "fail", re: /^Checkstyle ends with [1-9]\d* errors?\./m },
  { id: "dotnet-format-diff", category: "lint", kind: "fail", re: /^\s*error WHITESPACE|^\s*error IMPORTS|Formatted code file/m },
  // --- build
  { id: "next-failed", category: "build", kind: "fail", re: /^Failed to compile\.|^> Build failed|Build error occurred|^Type error: |^⨯ Next\.js build worker exited with code: [1-9]|^Export encountered an error|exiting the build\.|^⨯ Failed to/m },
  { id: "next-ok", category: "build", kind: "pass", re: /^\s*(?:✓|√) Compiled successfully|^Compiled successfully|^[○ƒ●λ◐]\s+\((?:Static|Dynamic|SSG|ISR|Partial Prerender)\)\s+(?:prerendered|server-rendered|revalidated)/m },
  { id: "cra-ok", category: "build", kind: "pass", re: /^The build folder is ready to be deployed\./m },
  { id: "astro-failed", category: "build", kind: "fail", re: /^(?:\d{2}:\d{2}:\d{2} )?\s*\[build\] .*(?:error|failed)|^(?:\d{2}:\d{2}:\d{2} )?\[ERROR\] |^\s*\[(?:vite|astro)\] Build failed/m },
  { id: "astro-ok", category: "build", kind: "pass", re: /^(?:\d{2}:\d{2}:\d{2} )?\s*(?:✓|√)\s+Completed in [\d.]+ ?m?s\.|^(?:\d{2}:\d{2}:\d{2} )?\s*\[build\] Complete!|^(?:\d{2}:\d{2}:\d{2} )?\s*\[build\] Server built in/m },
  { id: "angular-failed", category: "build", kind: "fail", re: /^(?:✘|X) \[ERROR\]/m },
  { id: "angular-ok", category: "build", kind: "pass", re: /^Application bundle generation complete\./m },
  { id: "docusaurus-ok", category: "build", kind: "pass", re: /^\[SUCCESS\] Generated static files in/m },
  { id: "gatsby-ok", category: "build", kind: "pass", re: /^Done building in [\d.]+ sec/m },
  { id: "hugo-ok", category: "build", kind: "pass", re: /^Total in \d+ ms/m },
  { id: "eleventy-ok", category: "build", kind: "pass", re: /^\[11ty\] Wrote \d+ files? in/m },
  { id: "nuxt-ok", category: "build", kind: "pass", re: /^\s*(?:✔|✓) (?:Nuxt Nitro server built|Client built|Server built|Generated public)/m },
  { id: "expo-ok", category: "build", kind: "pass", re: /^Exported: \S+/m },
  { id: "vite-failed", category: "build", kind: "fail", re: /^error during build:|^\[vite\]: Rollup failed|^x Build failed/m },
  { id: "vite-ok", category: "build", kind: "pass", re: /(?:✓|√) built in [\d.]+ ?m?s/m },
  { id: "webpack-failed", category: "build", kind: "fail", re: /compiled with [1-9]\d* errors?|^ERROR in /m },
  { id: "webpack-ok", category: "build", kind: "pass", re: /compiled successfully in \d+ ?ms|webpack [\d.]+ compiled successfully/m },
  { id: "esbuild-failed", category: "build", kind: "fail", re: /✘ \[ERROR\]|^[1-9]\d* errors?\s*$/m },
  { id: "esbuild-ok", category: "build", kind: "pass", re: /^\s*Done in [\d.]+ ?m?s|⚡ Done in/m },
  { id: "tsup-failed", category: "build", kind: "fail", re: /Build failed|^error TS\d+|Error: Build failed with/m },
  { id: "tsup-ok", category: "build", kind: "pass", re: /(?:ESM|CJS|DTS) (?:⚡️ )?Build success|Build complete in|^\s*Done in/m },
  { id: "rollup-failed", category: "build", kind: "fail", re: /^\[!\] (?:Error|RollupError)/m },
  { id: "rollup-ok", category: "build", kind: "pass", re: /created \S+ in [\d.]+ ?m?s/m },
  { id: "cargo-build-error", category: "build", kind: "fail", re: /^error(?:\[E\d+\])?: |^error: could not compile|^error: linking with/m },
  { id: "cargo-build-ok", category: "build", kind: "pass", re: /^\s*Finished `?(?:dev|release|test)/m },
  { id: "go-build-error", category: "build", kind: "fail", re: /^[^\s:]+\.go:\d+:\d+: |^# \S+\n[^\n]*\.go:\d+/m },
  { id: "make-error", category: "*", kind: "fail", re: /^make(?:\[\d+\])?: \*\*\* .* Error \d+/m },
  { id: "npm-err", category: "*", kind: "fail", re: /^npm ERR!|^npm error |ELIFECYCLE|^\s*ERR_PNPM_|^error Command failed with exit code [1-9]|^Error: (?:script|Process) "[^"]+" exited with code [1-9]/m },
  { id: "turbo-failed", category: "*", kind: "fail", re: /^\s*Failed:\s+[^\s\d]|ERROR\s+run failed:/m },
  { id: "turbo-ok", category: "build", kind: "pass", re: /^\s*Tasks:\s+(\d+) successful, (\d+) total/m },
  { id: "gradle-build-failed", category: "build", kind: "fail", re: /^BUILD FAILED|^FAILURE: Build failed/m },
  { id: "gradle-build-ok", category: "build", kind: "pass", re: /^BUILD SUCCESSFUL/m },
  { id: "maven-build-failed", category: "build", kind: "fail", re: /^\[(?:ERROR|INFO)\] BUILD FAILURE/m },
  { id: "maven-build-ok", category: "build", kind: "pass", re: /^\[INFO\] BUILD SUCCESS/m },
  { id: "dotnet-build-failed", category: "build", kind: "fail", re: /^Build FAILED\.|: error [A-Z]+\d+:/m },
  { id: "dotnet-build-ok", category: "build", kind: "pass", re: /^Build succeeded\.|Build succeeded with \d+ warning/m },
  { id: "xcodebuild-failed", category: "build", kind: "fail", re: /\*\* BUILD FAILED \*\*|\*\* TEST FAILED \*\*/m },
  { id: "xcodebuild-ok", category: "build", kind: "pass", re: /\*\* BUILD SUCCEEDED \*\*/m },
  { id: "swift-build-error", category: "build", kind: "fail", re: /^[^\s:]+\.swift:\d+:\d+: error:|^error: /m },
  { id: "swift-build-ok", category: "build", kind: "pass", re: /^Build complete!/m },
  { id: "docker-failed", category: "build", kind: "fail", re: /^ERROR: failed to solve:|^ERROR: failed to build/m },
  { id: "docker-ok", category: "build", kind: "pass", re: /^Successfully built [0-9a-f]+|=> => (?:exporting|naming) to |^\s*=> exporting to image/m },
  { id: "cmake-error", category: "build", kind: "fail", re: /^CMake Error|^ninja: build stopped:|^ninja: error:/m },
  { id: "ninja-ok", category: "build", kind: "pass", re: /^ninja: no work to do\./m },
  { id: "mix-compile-error", category: "build", kind: "fail", re: /^\*\* \(CompileError\)|^== Compilation error/m },
  { id: "python-build-ok", category: "build", kind: "pass", re: /^Successfully built \S+(?:\.tar\.gz|\.whl)/m },
  { id: "elm-make-error", category: "build", kind: "fail", re: /^-- [A-Z ]+ -+ /m },
  { id: "elm-make-ok", category: "build", kind: "pass", re: /^Success! Compiled \d+ modules?\./m },
  { id: "parcel-ok", category: "build", kind: "pass", re: /(?:✨|Built) [Bb]uilt in [\d.]+ ?m?s/m },
  // A traceback is a failure for tools that should never print one; test runners print them for failing tests and summarise anyway.
  { id: "traceback", category: "typecheck", kind: "fail", re: /^Traceback \(most recent call last\):/m },
  { id: "traceback-lint", category: "lint", kind: "fail", re: /^Traceback \(most recent call last\):/m },
  { id: "traceback-build", category: "build", kind: "fail", re: /^Traceback \(most recent call last\):/m },
  { id: "node-uncaught", category: "*", kind: "fail", re: /^node:internal\/modules\/cjs\/loader:\d+\n\s+throw err;/m },
  { id: "command-not-found", category: "*", kind: "fail", re: /^(?:[^\n:]{0,60}: )?(?:line \d+: )?[^\n:]{1,80}: command not found\s*$|^(?:sh|bash|zsh|dash|\/bin\/sh): \d+: [^\n]+: not found\s*$|^(?:sh|bash|zsh|dash|\/bin\/sh): (?:line \d+: )?[^\n]+: No such file or directory\s*$|^'[^\n']+' is not recognized as an internal or external command/m },
];

/** Pass signals that are one self-contained summary line, trustworthy even when a filter pipe hid the rest of the output. */
const SINGLE_LINE_SUMMARY = new Set([
  "pytest-passed", "pytest-short-passed", "jest-passed", "vitest-passed", "rspec-passed", "phpunit-passed", "mix-passed", "dotnet-passed", "nextest-passed", "playwright-passed", "ctest-passed", "jasmine-passed", "minitest-passed", "deno-pass", "dart-test-passed", "elm-test-passed", "sbt-test-passed", "cypress-passed", "gradle-test-passed", "maven-passed",
  "tsc-found-zero", "svelte-check-ok", "mypy-ok", "pyright-ok", "flow-ok", "phpstan-ok", "sorbet-ok", "dialyzer-ok",
  "ruff-ok", "ruff-format-ok", "black-ok", "biome-ok", "rubocop-ok", "oxlint-ok", "prettier-ok", "golangci-ok", "credo-ok", "swiftlint-ok", "dart-analyze-ok", "pylint-ok",
  "next-ok", "vite-ok", "webpack-ok", "tsup-ok", "rollup-ok", "turbo-ok", "gradle-build-ok", "maven-build-ok", "dotnet-build-ok", "xcodebuild-ok", "swift-build-ok", "docker-ok", "elm-make-ok", "parcel-ok", "python-build-ok", "esbuild-ok", "ninja-ok",
  "cra-ok", "astro-ok", "angular-ok", "docusaurus-ok", "gatsby-ok", "hugo-ok", "eleventy-ok", "nuxt-ok", "expo-ok", "generic-test-passed",
]);

/** True when the output holds a fail signal for the category. */
export function hasFailSignal(category: Category, rawOutput: string): boolean {
  const { fail } = matchingSignals(category, cleanOutput(rawOutput ?? ""));
  return fail.length > 0;
}

const COUNT_PATTERNS: { re: RegExp; last?: boolean; only?: Category[]; map: (m: RegExpMatchArray) => Counts }[] = [
  // pytest summary: "= 1 failed, 40 passed, 2 skipped in 3.2s ="
  { re: /=+ ((?:\d+ (?:passed|failed|errors?|skipped|deselected|xfailed|xpassed|warnings?)(?:, )?)+) in [\d.]+s/, map: (m) => tallies(m[1] as string) },
  { re: /^\s*((?:\d+ (?:passed|failed|errors?|skipped|deselected|xfailed|xpassed|warnings?)(?:, )?)+) in [\d.]+s\s*$/m, map: (m) => tallies(m[1] as string) },
  // jest: "Tests:       1 failed, 2 skipped, 40 passed, 43 total"
  { re: /^\s*Tests:\s+((?:\d+ (?:failed|passed|skipped|todo)(?:, )?)+), (\d+) total/m, map: (m) => ({ ...tallies(m[1] as string), total: Number(m[2]) }) },
  // vitest: " Tests  2 failed | 39 passed | 1 skipped (42)"
  { re: /^\s*Tests\s+((?:\d+ (?:failed|passed|skipped|todo)(?: \| )?)+) \((\d+)\)/m, map: (m) => ({ ...tallies((m[1] as string).replace(/ \| /g, ", ")), total: Number(m[2]) }) },
  // mocha
  { re: /^\s*(\d+) passing\b[\s\S]*?^\s*(\d+) failing/m, map: (m) => ({ passed: Number(m[1]), failed: Number(m[2]) }) },
  { re: /^\s*(\d+) passing\b/m, map: (m) => ({ passed: Number(m[1]) }) },
  // cargo
  { re: /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/m, map: (m) => ({ passed: Number(m[1]), failed: Number(m[2]), skipped: Number(m[3]) }) },
  // nextest
  { re: /^\s*Summary \[[^\]]*\]\s+(\d+) tests? run: (\d+) passed(?:[^,\n]*)?(?:, (\d+) failed)?(?:, (\d+) skipped)?/m, map: (m) => ({ total: Number(m[1]), passed: Number(m[2]), ...(m[3] ? { failed: Number(m[3]) } : {}), ...(m[4] ? { skipped: Number(m[4]) } : {}) }) },
  // rspec
  { re: /^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/m, map: (m) => ({ total: Number(m[1]), failed: Number(m[2]), passed: Number(m[1]) - Number(m[2]) - Number(m[3] ?? 0), ...(m[3] ? { skipped: Number(m[3]) } : {}) }) },
  // minitest
  { re: /^(\d+) runs, \d+ assertions, (\d+) failures, (\d+) errors(?:, (\d+) skips)?/m, map: (m) => ({ total: Number(m[1]), failed: Number(m[2]), errors: Number(m[3]), passed: Number(m[1]) - Number(m[2]) - Number(m[3]) - Number(m[4] ?? 0) }) },
  // phpunit
  { re: /^OK \((\d+) tests?, \d+ assertions?\)/m, map: (m) => ({ passed: Number(m[1]), total: Number(m[1]), failed: 0 }) },
  { re: /Tests: (\d+), Assertions: \d+(?:, Failures: (\d+))?(?:, Errors: (\d+))?/m, map: (m) => ({ total: Number(m[1]), failed: Number(m[2] ?? 0), errors: Number(m[3] ?? 0), passed: Number(m[1]) - Number(m[2] ?? 0) - Number(m[3] ?? 0) }) },
  // mix
  { re: /^(\d+) (?:tests?|doctests?)(?:, \d+ (?:doctests?|properties|tests?))*, (\d+) failures?/m, map: (m) => ({ total: Number(m[1]), failed: Number(m[2]), passed: Number(m[1]) - Number(m[2]) }) },
  // unittest
  { re: /^Ran (\d+) tests? in [\d.]+s[\s\S]*?^(?:OK|FAILED \((?:failures=(\d+))?(?:, )?(?:errors=(\d+))?)/m, map: (m) => ({ total: Number(m[1]), failed: Number(m[2] ?? 0), errors: Number(m[3] ?? 0), passed: Number(m[1]) - Number(m[2] ?? 0) - Number(m[3] ?? 0) }) },
  // node --test and tap
  { re: /^# pass (\d+)\s*$[\s\S]*?^# fail (\d+)/m, map: (m) => ({ passed: Number(m[1]), failed: Number(m[2]) }) },
  // bun
  { re: /^\s*(\d+) pass\s*$[\s\S]*?^\s*(\d+) fail\s*$/m, map: (m) => ({ passed: Number(m[1]), failed: Number(m[2]) }) },
  // deno
  { re: /^(?:ok|FAILED) \| (\d+) passed(?: \([^)]*\))? \| (\d+) failed/m, map: (m) => ({ passed: Number(m[1]), failed: Number(m[2]) }) },
  // playwright
  { re: /^\s*(\d+) failed\s*$[\s\S]*?^\s*(\d+) passed/m, map: (m) => ({ failed: Number(m[1]), passed: Number(m[2]) }) },
  { re: /^\s*(\d+) passed \([\d.]+m?s\)\s*$/m, map: (m) => ({ passed: Number(m[1]) }) },
  // dotnet
  { re: /^(?:Passed|Failed)!\s+- Failed:\s+(\d+), Passed:\s+(\d+), Skipped:\s+(\d+), Total:\s+(\d+)/m, map: (m) => ({ failed: Number(m[1]), passed: Number(m[2]), skipped: Number(m[3]), total: Number(m[4]) }) },
  { re: /^Total tests: (\d+)\. Passed: (\d+)\. Failed: (\d+)\./m, map: (m) => ({ total: Number(m[1]), passed: Number(m[2]), failed: Number(m[3]) }) },
  // maven surefire aggregate: the last "Tests run" line is the total
  { re: /^\[(?:INFO|ERROR|WARNING)\] Tests run: (\d+), Failures: (\d+), Errors: (\d+)(?:, Skipped: (\d+))?\s*$/gm, last: true, map: (m) => ({ total: Number(m[1]), failed: Number(m[2]), errors: Number(m[3]), skipped: Number(m[4] ?? 0), passed: Number(m[1]) - Number(m[2]) - Number(m[3]) - Number(m[4] ?? 0) }) },
  // gradle
  { re: /^(\d+) tests completed, (\d+) failed/m, map: (m) => ({ total: Number(m[1]), failed: Number(m[2]), passed: Number(m[1]) - Number(m[2]) }) },
  // swift
  { re: /Executed (\d+) tests?, with (\d+) failures?/m, map: (m) => ({ total: Number(m[1]), failed: Number(m[2]), passed: Number(m[1]) - Number(m[2]) }) },
  // ctest
  { re: /^(\d+)% tests passed, (\d+) tests? failed out of (\d+)/m, map: (m) => ({ failed: Number(m[2]), total: Number(m[3]), passed: Number(m[3]) - Number(m[2]) }) },
  // jasmine
  { re: /^(\d+) specs?, (\d+) failures?/m, map: (m) => ({ total: Number(m[1]), failed: Number(m[2]), passed: Number(m[1]) - Number(m[2]) }) },
  // ava
  { re: /^\s*(\d+) tests? passed(?:\n\s*(\d+) tests? failed)?/m, map: (m) => ({ passed: Number(m[1]), ...(m[2] ? { failed: Number(m[2]) } : {}) }) },
  // typecheck and lint error counts
  { re: /^Found (\d+) errors?(?: in \d+ files?)?/m, only: ["typecheck", "lint", "build"], map: (m) => ({ errors: Number(m[1]) }) },
  { re: /^(\d+) errors?, (\d+) warnings?/m, only: ["typecheck", "lint", "build"], map: (m) => ({ errors: Number(m[1]) }) },
  { re: /✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/m, only: ["lint"], map: (m) => ({ errors: Number(m[2]) }) },
  { re: /(\d+) offenses? detected/m, only: ["lint"], map: (m) => ({ errors: Number(m[1]) }) },
  { re: /svelte-check found (\d+) errors?/m, only: ["typecheck"], map: (m) => ({ errors: Number(m[1]) }) },
  { re: /Found \d+ warnings? and (\d+) errors?/m, only: ["lint"], map: (m) => ({ errors: Number(m[1]) }) },
];
const TEST_ONLY_COUNT = COUNT_PATTERNS.length - 6;

function tallies(s: string): Counts {
  const out: Counts = {};
  for (const m of s.matchAll(/(\d+) (passed|failed|errors?|skipped|deselected|xfailed|xpassed|warnings?|todo)/g)) {
    const n = Number(m[1]);
    const k = m[2] as string;
    if (k === "passed") out.passed = n;
    else if (k === "failed") out.failed = n;
    else if (k.startsWith("error")) out.errors = n;
    else if (k === "skipped" || k === "deselected" || k === "xfailed" || k === "todo") out.skipped = (out.skipped ?? 0) + n;
  }
  return out;
}

/** Reads counts from runner output, first match wins. Test tallies apply to the test category only. */
export function parseCounts(output: string, category?: Category): Counts {
  for (let i = 0; i < COUNT_PATTERNS.length; i++) {
    const p = COUNT_PATTERNS[i]!;
    if (category && i < TEST_ONLY_COUNT && category !== "test") continue;
    if (category && p.only && !p.only.includes(category)) continue;
    if (p.last) {
      const all = [...output.matchAll(p.re)];
      const m = all[all.length - 1];
      if (m) return p.map(m);
      continue;
    }
    const m = output.match(p.re);
    if (m) return p.map(m);
  }
  return {};
}

const NOT_RUN_ANY = /no tests ran|No tests found|No test files found|collected 0 items|Ran 0 tests|^0 tests? (?:ran|run|executed)/im;

function matchingSignals(category: Category, output: string): { pass: string[]; fail: string[]; notrun: string[] } {
  const pass: string[] = [];
  const fail: string[] = [];
  const notrun: string[] = [];
  for (const s of SIGNALS) {
    if (s.category !== category && s.category !== "*") continue;
    if (!s.re.test(output)) continue;
    if (s.kind === "pass") pass.push(s.id);
    else if (s.kind === "fail") fail.push(s.id);
    else notrun.push(s.id);
  }
  return { pass, fail, notrun };
}

/** Lines a package manager prints around a script: the script banner, yarn's chatter, a trailing "Done in". */
const BANNER_LINE = /^(?:>\s.*|\$ .*|yarn run v[\d.]+|(?:✨\s+)?Done in [\d.]+m?s\.?|info Visit https:\/\/yarnpkg\.com.*|\[stalegreen\] .*|npm warn .*|npm notice .*|Shell cwd was reset to .*|Session cwd remains .*|\s*)$/;

/** True when the output carries nothing beyond package-manager banners, so a silent-success tool printed nothing. */
export function isSilent(output: string): boolean {
  return cleanOutput(output)
    .split("\n")
    .every((line) => BANNER_LINE.test(line));
}

/** Removes ANSI colour codes and carriage-return progress noise. */
export function cleanOutput(output: string): string {
  return output
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[^\n]*\r(?!\n)/g, "");
}

/**
 * Decides the verdict for one verification run.
 *
 * `pass` needs a positive signal, or a silent-success category with exit 0.
 * `fail` needs a known non-zero exit, or fail markers when the exit is unknown.
 * Everything else is `inconclusive`.
 */
export function parseOutput(category: Category, rawOutput: string, opts: ParseOptions): ParseResult {
  const output = cleanOutput(rawOutput ?? "");
  const { pass, fail, notrun } = matchingSignals(category, output);
  const counts = parseCounts(output, category);
  const base = { counts, passSignals: pass, failSignals: fail };
  if (opts.interrupted) return { ...base, verdict: "inconclusive", signal: "interrupted" };
  if (opts.exit !== null && opts.exit !== undefined && opts.exit !== 0) {
    return { ...base, verdict: "fail", signal: fail[0] ?? `exit-${opts.exit}` };
  }
  if (opts.failed && (opts.exit === null || opts.exit === undefined)) {
    return { ...base, verdict: "fail", signal: fail[0] ?? "exit-nonzero" };
  }
  if (category === "test" && (notrun.length > 0 || NOT_RUN_ANY.test(output)) && pass.length === 0) {
    return { ...base, verdict: "inconclusive", signal: notrun[0] ?? "no-tests" };
  }
  if (category !== "test" && notrun.length > 0 && pass.length === 0 && fail.length === 0) {
    return { ...base, verdict: "inconclusive", signal: notrun[0] as string };
  }
  if (opts.exit === null || opts.exit === undefined) {
    if (fail.length > 0) return { ...base, verdict: "fail", signal: fail[0] as string };
    if (opts.outputVisible && pass.length > 0) return { ...base, verdict: "pass", signal: `summary-only:${pass[0]}` };
    if (opts.outputVisible && category !== "test" && isSilent(output)) return { ...base, verdict: "pass", signal: "silent-through-pipe" };
    if (opts.filtered) {
      const trusted = pass.find((id) => SINGLE_LINE_SUMMARY.has(id));
      if (trusted) return { ...base, verdict: "pass", signal: `summary-line:${trusted}` };
    }
    return { ...base, verdict: "inconclusive", signal: "exit-unknown" };
  }
  if (fail.length > 0 && pass.length === 0) return { ...base, verdict: "inconclusive", signal: `exit-0-with-${fail[0]}` };
  if (fail.length > 0 && pass.length > 0) return { ...base, verdict: "inconclusive", signal: "mixed-signals" };
  if (pass.length > 0) return { ...base, verdict: "pass", signal: pass[0] as string };
  if (category === "test") return { ...base, verdict: "inconclusive", signal: "no-summary" };
  return { ...base, verdict: "pass", signal: "exit-0" };
}

/** Names of every signal, for documentation and tests. */
export function signalIds(): string[] {
  return SIGNALS.map((s) => s.id);
}
