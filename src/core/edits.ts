/**
 * Edit events: which tool calls and shell commands change the working tree.
 * These are the fallback staleness signal when the fingerprint is unavailable.
 */

import { parseCommand, type Segment } from "./shell.js";
import { stripWrappers } from "./runners.js";
import type { EditEvent } from "./grammar.js";

export interface EditCandidate {
  path: string | null;
  kind: string;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** An edit event for a harness file tool, or null when the tool does not write files. */
export function editFromTool(toolName: string, toolInput: unknown): EditCandidate | null {
  if (!EDIT_TOOLS.has(toolName)) return null;
  const input = (toolInput ?? {}) as Record<string, unknown>;
  const path = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
  return { path, kind: toolName };
}

const GIT_TREE_COMMANDS = new Set(["apply", "am", "checkout", "switch", "restore", "stash", "merge", "rebase", "cherry-pick", "revert", "reset", "pull", "clean", "mv", "rm", "worktree"]);
const INSTALL_COMMANDS: Record<string, Set<string>> = {
  npm: new Set(["install", "i", "add", "uninstall", "remove", "rm", "un", "update", "up", "ci", "link", "dedupe", "prune"]),
  pnpm: new Set(["install", "i", "add", "remove", "rm", "uninstall", "update", "up", "link", "dedupe", "prune", "patch"]),
  yarn: new Set(["add", "remove", "install", "up", "upgrade", "dedupe", "link"]),
  bun: new Set(["add", "install", "i", "remove", "rm", "update", "link"]),
  pip: new Set(["install", "uninstall"]),
  pip3: new Set(["install", "uninstall"]),
  uv: new Set(["add", "remove", "sync", "pip", "lock"]),
  poetry: new Set(["add", "remove", "install", "update", "lock"]),
  pipenv: new Set(["install", "uninstall", "update", "lock"]),
  cargo: new Set(["add", "remove", "rm", "update"]),
  go: new Set(["get", "mod"]),
  bundle: new Set(["add", "install", "update", "remove"]),
  gem: new Set(["install", "uninstall"]),
  composer: new Set(["require", "install", "update", "remove"]),
  mix: new Set(["deps.get", "deps.update"]),
  dotnet: new Set(["add", "remove", "restore"]),
};
const FORMATTERS: { name: string; check: RegExp | null }[] = [
  { name: "prettier", check: /^(?:--check|-c|--list-different|-l)$/ },
  { name: "eslint", check: /^--fix(?:-dry-run)?$/ },
  { name: "biome", check: /^(?:--write|--apply|--apply-unsafe|--fix)$/ },
  { name: "ruff", check: null },
  { name: "black", check: /^(?:--check|--diff)$/ },
  { name: "isort", check: /^(?:--check|--check-only|--diff)$/ },
  { name: "cargo", check: /^--check$/ },
  { name: "rustfmt", check: /^--check$/ },
  { name: "gofmt", check: /^-w$/ },
  { name: "go", check: null },
  { name: "swiftformat", check: /^--lint$/ },
  { name: "mix", check: /^--check-formatted$/ },
  { name: "dotnet", check: /^--verify-no-changes$/ },
  { name: "autopep8", check: /^(?:-i|--in-place)$/ },
  { name: "yapf", check: /^(?:-i|--in-place)$/ },
  { name: "standard", check: /^--fix$/ },
  { name: "stylelint", check: /^--fix$/ },
  { name: "oxlint", check: /^--fix$/ },
];

function lastPositional(words: string[]): string | null {
  for (let i = words.length - 1; i >= 1; i--) {
    const w = words[i] as string;
    if (!w.startsWith("-")) return w;
  }
  return null;
}

function formatterEdit(words: string[]): EditCandidate | null {
  const w0 = (words[0] as string).replace(/^.*\//, "");
  for (const f of FORMATTERS) {
    if (w0 !== f.name) continue;
    const rest = words.slice(1);
    if (f.name === "prettier" || f.name === "black" || f.name === "isort" || f.name === "swiftformat" || f.name === "rustfmt") {
      if (rest.some((w) => f.check!.test(w))) return null;
      return { path: null, kind: "format" };
    }
    if (f.name === "eslint" || f.name === "stylelint" || f.name === "oxlint" || f.name === "standard") {
      return rest.some((w) => f.check!.test(w)) ? { path: null, kind: "format" } : null;
    }
    if (f.name === "biome") {
      return rest.some((w) => f.check!.test(w)) ? { path: null, kind: "format" } : null;
    }
    if (f.name === "ruff") {
      if (rest[0] === "format" && !rest.includes("--check") && !rest.includes("--diff")) return { path: null, kind: "format" };
      if (rest.includes("--fix") || rest.includes("--unsafe-fixes")) return { path: null, kind: "format" };
      return null;
    }
    if (f.name === "cargo") {
      return rest[0] === "fmt" && !rest.includes("--check") ? { path: null, kind: "format" } : null;
    }
    if (f.name === "gofmt") return rest.includes("-w") ? { path: null, kind: "format" } : null;
    if (f.name === "go") return rest[0] === "fmt" ? { path: null, kind: "format" } : null;
    if (f.name === "mix") return rest[0] === "format" && !rest.includes("--check-formatted") ? { path: null, kind: "format" } : null;
    if (f.name === "dotnet") return rest[0] === "format" && !rest.includes("--verify-no-changes") ? { path: null, kind: "format" } : null;
    if (f.name === "autopep8" || f.name === "yapf") return rest.some((w) => f.check!.test(w)) ? { path: null, kind: "format" } : null;
  }
  return null;
}

function segmentEdits(seg: Segment): EditCandidate[] {
  const out: EditCandidate[] = [];
  for (const r of seg.redirects) {
    if ((r.op === ">" || r.op === ">>" || r.op === "&>" || r.op === "&>>" || r.op === ">|") && (r.fd === null || r.fd === 1)) {
      if (r.target === "/dev/null" || r.target === "/dev/stderr" || r.target === "/dev/stdout" || /^&\d$/.test(r.target)) continue;
      if (/\.stalegreen\//.test(r.target) || r.target.startsWith("$__sg_")) continue;
      out.push({ path: r.target, kind: "redirect" });
    }
  }
  const stripped = stripWrappers(seg.words);
  const words = stripped.words;
  if (words.length === 0) return out;
  const w0 = (words[0] as string).replace(/^.*\//, "");
  const w1 = words[1] ?? "";
  if (w0 === "sed" && words.some((w) => w === "-i" || /^-i[^\s]*$/.test(w) || w === "--in-place")) {
    out.push({ path: lastPositional(words), kind: "sed" });
  } else if (w0 === "perl" && words.some((w) => /^-[a-zA-Z]*i/.test(w))) {
    out.push({ path: lastPositional(words), kind: "perl" });
  } else if (w0 === "tee") {
    const path = lastPositional(words);
    if (path && path !== "/dev/null" && !/\.stalegreen\//.test(path) && !path.startsWith("$__sg_")) out.push({ path, kind: "tee" });
  } else if (w0 === "mv" || w0 === "cp" || w0 === "rsync" || w0 === "install") {
    out.push({ path: lastPositional(words), kind: w0 });
  } else if (w0 === "rm" || w0 === "unlink" || w0 === "truncate" || w0 === "touch" || w0 === "ln") {
    out.push({ path: lastPositional(words), kind: w0 });
  } else if (w0 === "patch") {
    out.push({ path: null, kind: "patch" });
  } else if (w0 === "git" && GIT_TREE_COMMANDS.has(w1)) {
    if (w1 === "stash" && (words[2] === "list" || words[2] === "show")) return out;
    if (w1 === "worktree" && words[2] !== "add" && words[2] !== "remove") return out;
    if (w1 === "clean" && !words.some((w) => /^-[a-zA-Z]*f/.test(w))) return out;
    const dash = words.indexOf("--");
    const path = dash >= 0 && words[dash + 1] ? (words[dash + 1] as string) : null;
    out.push({ path, kind: `git ${w1}` });
  } else if (INSTALL_COMMANDS[w0]?.has(w1)) {
    out.push({ path: null, kind: `${w0} ${w1}` });
  } else if (w0 === "npx" || w0 === "bunx") {
    // handled by stripWrappers above; a bare npx never reaches here
  } else {
    const f = formatterEdit(words);
    if (f) out.push(f);
  }
  return out;
}

/** Edit events implied by a shell command. Verification runners are not edits, formatters are. */
export function editsFromBash(command: string): EditCandidate[] {
  const parsed = parseCommand(command);
  const out: EditCandidate[] = [];
  for (const seg of parsed.segments) {
    if (seg.words.length === 0 && seg.redirects.length === 0) continue;
    out.push(...segmentEdits(seg));
  }
  if (parsed.heredoc) {
    // A heredoc feeding an interpreter can write anywhere; record it without a path.
    const feeds = parsed.segments.some((s) => s.redirects.some((r) => r.op.startsWith("<<")) && /^(?:python[0-9.]*|node|ruby|perl|php|sh|bash|zsh)$/.test((s.words[0] ?? "").replace(/^.*\//, "")));
    if (feeds && out.length === 0) out.push({ path: null, kind: "heredoc" });
  }
  // Deduplicate identical events.
  const seen = new Set<string>();
  return out.filter((e) => {
    const key = `${e.kind}:${e.path ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function toEditEvent(c: EditCandidate, ts: string, agent: string | null): EditEvent {
  const ev: EditEvent = { ts, path: c.path, kind: c.kind };
  if (agent) ev.agent = agent;
  return ev;
}
