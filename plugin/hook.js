#!/usr/bin/env node

// src/hook.ts
import { writeSync } from "fs";
import * as nodeModule from "module";

// src/core/store.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync, readdirSync, readFileSync as readFileSync2, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, dirname as dirname2, join as join2 } from "path";

// src/core/config.ts
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
var DEFAULT_FINGERPRINT_IGNORE = [
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
  ".stalegreen.json"
];
var DEFAULT_CONFIG = {
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
  permission: "inherit"
};
function stalegreenHome() {
  const env = process.env.STALEGREEN_HOME;
  if (env && env.trim().length > 0) return resolve(env);
  return join(homedir(), ".stalegreen");
}
function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function findRepoConfig(cwd) {
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
function merge(base, layer) {
  if (!layer) return base;
  const out = { ...base, categories: { ...base.categories } };
  const str2 = (k, allowed) => {
    const v = layer[k];
    if (typeof v !== "string") return void 0;
    if (allowed && !allowed.includes(v)) return void 0;
    return v;
  };
  const policy = str2("policy", ["block", "advisory"]);
  if (policy) out.policy = policy;
  const mode = str2("mode", ["rewrite", "strict", "off"]);
  if (mode) out.mode = mode;
  if (typeof layer.strictNoEvidence === "boolean") out.strictNoEvidence = layer.strictNoEvidence;
  if (typeof layer.tailLines === "number" && layer.tailLines >= 1 && layer.tailLines <= 5e3) out.tailLines = Math.floor(layer.tailLines);
  if (layer.categories && typeof layer.categories === "object") {
    for (const c of ["test", "typecheck", "lint", "build"]) {
      const v = layer.categories[c];
      if (typeof v === "boolean") out.categories[c] = v;
    }
  }
  if (Array.isArray(layer.ignoreCommands)) out.ignoreCommands = layer.ignoreCommands.filter((x) => typeof x === "string");
  if (Array.isArray(layer.extraRunners)) {
    out.extraRunners = layer.extraRunners.filter(
      (x) => !!x && typeof x === "object" && typeof x.match === "string" && ["test", "typecheck", "lint", "build"].includes(x.category)
    );
  }
  const prune = str2("prune");
  if (prune && /^\d+d$/.test(prune)) out.prune = prune;
  if (Array.isArray(layer.fingerprintIgnore)) out.fingerprintIgnore = layer.fingerprintIgnore.filter((x) => typeof x === "string");
  if (typeof layer.fingerprintBudgetMs === "number" && layer.fingerprintBudgetMs >= 10) out.fingerprintBudgetMs = Math.floor(layer.fingerprintBudgetMs);
  if (typeof layer.deferredTtlMinutes === "number" && layer.deferredTtlMinutes >= 0) out.deferredTtlMinutes = layer.deferredTtlMinutes;
  if (typeof layer.maxLogBytes === "number" && layer.maxLogBytes >= 1024) out.maxLogBytes = Math.floor(layer.maxLogBytes);
  const permission = str2("permission", ["inherit", "allow", "ask"]);
  if (permission) out.permission = permission;
  return out;
}
function loadConfig(cwd) {
  let config = DEFAULT_CONFIG;
  config = merge(config, readJson(join(stalegreenHome(), "config.json")));
  const repo = findRepoConfig(cwd);
  if (repo) config = merge(config, readJson(repo));
  return config;
}

// src/core/store.ts
var SAFE_ID = /[^A-Za-z0-9._-]/g;
function safe(id) {
  const s = id.replace(SAFE_ID, "_");
  return s.length > 0 ? s.slice(0, 120) : "unknown";
}
function deriveSession(input) {
  const transcript = typeof input.transcript_path === "string" ? input.transcript_path.replace(/\\/g, "/") : "";
  const sessionId = typeof input.session_id === "string" && input.session_id.length > 0 ? input.session_id : null;
  const agentId = typeof input.agent_id === "string" && input.agent_id.length > 0 ? input.agent_id : null;
  if (transcript) {
    const m = /\/([^/]+)\/subagents\/(?:[^/]+\/)*?([^/]+)\.jsonl$/.exec(transcript);
    if (m) return { root: safe(m[1]), agent: agentId ?? safe(m[2]) };
    const base = basename(transcript);
    if (base.endsWith(".jsonl")) return { root: safe(base.slice(0, -6)), agent: agentId };
  }
  return { root: safe(sessionId ?? "unknown"), agent: agentId };
}
function sessionsRoot() {
  return join2(stalegreenHome(), "sessions");
}
function sessionDir(root) {
  return join2(sessionsRoot(), safe(root));
}
function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}
function appendJsonl(file, record) {
  ensureDir(dirname2(file));
  appendFileSync(file, JSON.stringify(record) + "\n");
}
function readJsonl(file) {
  let text;
  try {
    text = readFileSync2(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
    }
  }
  return out;
}
function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync2(file, "utf8"));
  } catch {
    return null;
  }
}
function writeJsonFile(file, value) {
  ensureDir(dirname2(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  try {
    renameSync(tmp, file);
  } catch {
    writeFileSync(file, JSON.stringify(value, null, 2));
    try {
      rmSync(tmp, { force: true });
    } catch {
    }
  }
}
function withLock(dir, fn) {
  ensureDir(dir);
  const lock = join2(dir, ".lock");
  const deadline = Date.now() + 200;
  let held = false;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lock);
      held = true;
      break;
    } catch {
      try {
        const age = Date.now() - statSync(lock).mtimeMs;
        if (age > 5e3) rmdirSync(lock);
      } catch {
      }
      const until = Date.now() + 5;
      while (Date.now() < until) {
      }
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        rmdirSync(lock);
      } catch {
      }
    }
  }
}
function nextReceiptId(dir) {
  return withLock(dir, () => {
    const file = join2(dir, "seq");
    let n = 0;
    try {
      n = Number(readFileSync2(file, "utf8").trim()) || 0;
    } catch {
      n = 0;
    }
    n += 1;
    writeFileSync(file, String(n));
    return `r-${String(n).padStart(4, "0")}`;
  });
}
function recordError(event, error) {
  try {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    appendJsonl(join2(stalegreenHome(), "errors.jsonl"), { ts: (/* @__PURE__ */ new Date()).toISOString(), event, error: message.slice(0, 500) });
  } catch {
  }
}

// src/core/shell.ts
var WORD_BREAK = /* @__PURE__ */ new Set([" ", "	", "\n", "\r"]);
function isSpace(ch) {
  return ch !== void 0 && WORD_BREAK.has(ch);
}
function skipSingle(src, i) {
  const j = src.indexOf("'", i + 1);
  return j < 0 ? -1 : j + 1;
}
function skipBacktick(src, i) {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") return j + 1;
    j++;
  }
  return -1;
}
function skipParens(src, open) {
  let depth = 0;
  let j = open;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "'") {
      j = skipSingle(src, j);
      if (j < 0) return -1;
      continue;
    }
    if (c === '"') {
      j = skipDouble(src, j);
      if (j < 0) return -1;
      continue;
    }
    if (c === "`") {
      j = skipBacktick(src, j);
      if (j < 0) return -1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return -1;
}
function skipDouble(src, i) {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === '"') return j + 1;
    if (c === "$" && src[j + 1] === "(") {
      j = skipParens(src, j + 1);
      if (j < 0) return -1;
      continue;
    }
    if (c === "`") {
      j = skipBacktick(src, j);
      if (j < 0) return -1;
      continue;
    }
    j++;
  }
  return -1;
}
function readDelimiter(src, i) {
  let j = i;
  while (isSpace(src[j]) && src[j] !== "\n") j++;
  let out = "";
  while (j < src.length && !isSpace(src[j]) && src[j] !== ";" && src[j] !== "|" && src[j] !== "&" && src[j] !== ")") {
    const c = src[j];
    if (c === "'") {
      const k = skipSingle(src, j);
      if (k < 0) return null;
      out += src.slice(j + 1, k - 1);
      j = k;
      continue;
    }
    if (c === '"') {
      const k = skipDouble(src, j);
      if (k < 0) return null;
      out += src.slice(j + 1, k - 1);
      j = k;
      continue;
    }
    if (c === "\\") {
      out += src[j + 1] ?? "";
      j += 2;
      continue;
    }
    out += c;
    j++;
  }
  if (!out) return null;
  return { delimiter: out, next: j };
}
function skipHeredocBodies(src, i, pending) {
  let j = i;
  for (const h of pending) {
    for (; ; ) {
      if (j >= src.length) return src.length;
      let eol = src.indexOf("\n", j);
      if (eol < 0) eol = src.length;
      let line = src.slice(j, eol);
      if (h.stripTabs) line = line.replace(/^\t+/, "");
      j = eol + 1;
      if (line.trimEnd() === h.delimiter) break;
    }
  }
  return Math.min(j, src.length);
}
function tokenize(head) {
  const words = [];
  const redirects = [];
  let ok = true;
  let word = "";
  let hasWord = false;
  let i = 0;
  const n = head.length;
  const flush = () => {
    if (hasWord) words.push(word);
    word = "";
    hasWord = false;
  };
  const readTarget = () => {
    while (i < n && isSpace(head[i])) i++;
    let out = "";
    while (i < n && !isSpace(head[i]) && head[i] !== ">" && head[i] !== "<") {
      const c = head[i];
      if (c === "'") {
        const k = skipSingle(head, i);
        if (k < 0) {
          ok = false;
          return out + head.slice(i + 1);
        }
        out += head.slice(i + 1, k - 1);
        i = k;
        continue;
      }
      if (c === '"') {
        const k = skipDouble(head, i);
        if (k < 0) {
          ok = false;
          return out + head.slice(i + 1);
        }
        out += head.slice(i + 1, k - 1);
        i = k;
        continue;
      }
      if (c === "\\") {
        out += head[i + 1] ?? "";
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  };
  while (i < n) {
    const c = head[i];
    if (isSpace(c)) {
      flush();
      i++;
      continue;
    }
    if (c === "\\") {
      if (head[i + 1] === "\n") {
        flush();
        i += 2;
        continue;
      }
      word += head[i + 1] ?? "";
      hasWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const k = skipSingle(head, i);
      if (k < 0) {
        ok = false;
        word += head.slice(i + 1);
        hasWord = true;
        break;
      }
      word += head.slice(i + 1, k - 1);
      hasWord = true;
      i = k;
      continue;
    }
    if (c === '"') {
      const k = skipDouble(head, i);
      if (k < 0) {
        ok = false;
        word += head.slice(i + 1);
        hasWord = true;
        break;
      }
      word += head.slice(i + 1, k - 1).replace(/\\(["\\$`\n])/g, "$1");
      hasWord = true;
      i = k;
      continue;
    }
    if (c === "`") {
      const k = skipBacktick(head, i);
      if (k < 0) {
        ok = false;
        break;
      }
      word += head.slice(i, k);
      hasWord = true;
      i = k;
      continue;
    }
    if (c === "$" && head[i + 1] === "(") {
      const k = skipParens(head, i + 1);
      if (k < 0) {
        ok = false;
        break;
      }
      word += head.slice(i, k);
      hasWord = true;
      i = k;
      continue;
    }
    if (c === "&" && (head[i + 1] === ">" || head[i + 1] === "<")) {
      flush();
      let op = "&>";
      i += 2;
      if (head[i] === ">") {
        op = "&>>";
        i++;
      }
      redirects.push({ fd: null, op, target: readTarget() });
      continue;
    }
    if (c === ">" || c === "<") {
      let fd = null;
      if (hasWord && /^\d+$/.test(word)) {
        fd = Number(word);
        word = "";
        hasWord = false;
      } else {
        flush();
      }
      let op = c;
      i++;
      if (head[i] === c) {
        op += c;
        i++;
        if (c === "<" && head[i] === "<") {
          op += "<";
          i++;
        }
      }
      if (head[i] === "&") {
        op += "&";
        i++;
      }
      if (op === "<<" && head[i] === "-") {
        op = "<<-";
        i++;
      }
      if (head[i] === "|" && op === ">") {
        op = ">|";
        i++;
      }
      redirects.push({ fd, op, target: readTarget() });
      continue;
    }
    word += c;
    hasWord = true;
    i++;
  }
  flush();
  return { words, redirects, ok };
}
function parseCommand(src) {
  const segments = [];
  const reasons = [];
  let heredoc = false;
  let processSubstitution = false;
  let grouping = false;
  let confident = true;
  const n = src.length;
  let i = 0;
  let segStart = 0;
  let op = "start";
  let pendingHeredocs = [];
  const bodyRanges = [];
  let parenDepth = 0;
  const endSegment = (end, nextOp, background) => {
    const rawEnd = end;
    let text = src.slice(segStart, rawEnd);
    let head = "";
    let cursor = segStart;
    for (const [a, b] of bodyRanges) {
      if (a < segStart || a > rawEnd) continue;
      head += src.slice(cursor, a);
      cursor = Math.max(cursor, b);
    }
    head += src.slice(cursor, rawEnd);
    text = text.trim();
    head = head.trim();
    if (text.length > 0) {
      const tok = tokenize(head);
      if (!tok.ok) {
        confident = false;
        reasons.push("unbalanced quotes");
      }
      let words = tok.words;
      let negated = false;
      if (words[0] === "!") {
        negated = true;
        words = words.slice(1);
      }
      const env = [];
      while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
        env.push(words.shift());
      }
      segments.push({ text, head, start: segStart, end: rawEnd, op, words, env, redirects: tok.redirects, background, negated });
    } else if (nextOp !== "newline" && nextOp !== "start" && segments.length === 0 && text.length === 0) {
    }
    op = nextOp;
  };
  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const k = skipSingle(src, i);
      if (k < 0) {
        confident = false;
        reasons.push("unbalanced single quote");
        i = n;
        break;
      }
      i = k;
      continue;
    }
    if (c === '"') {
      const k = skipDouble(src, i);
      if (k < 0) {
        confident = false;
        reasons.push("unbalanced double quote");
        i = n;
        break;
      }
      i = k;
      continue;
    }
    if (c === "`") {
      const k = skipBacktick(src, i);
      if (k < 0) {
        confident = false;
        reasons.push("unbalanced backtick");
        i = n;
        break;
      }
      i = k;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      const k = skipParens(src, i + 1);
      if (k < 0) {
        confident = false;
        reasons.push("unbalanced command substitution");
        i = n;
        break;
      }
      i = k;
      continue;
    }
    if (c === "$" && src[i + 1] === "{") {
      const k = src.indexOf("}", i);
      if (k < 0) {
        confident = false;
        reasons.push("unbalanced parameter expansion");
        i = n;
        break;
      }
      i = k + 1;
      continue;
    }
    if ((c === "<" || c === ">") && src[i + 1] === "(") {
      processSubstitution = true;
      const k = skipParens(src, i + 1);
      if (k < 0) {
        confident = false;
        reasons.push("unbalanced process substitution");
        i = n;
        break;
      }
      i = k;
      continue;
    }
    if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      let j = i + 2;
      let stripTabs = false;
      if (src[j] === "-") {
        stripTabs = true;
        j++;
      }
      const d = readDelimiter(src, j);
      if (!d) {
        confident = false;
        reasons.push("unreadable heredoc delimiter");
        i = j;
        continue;
      }
      heredoc = true;
      pendingHeredocs.push({ delimiter: d.delimiter, stripTabs });
      i = d.next;
      continue;
    }
    if (c === "#" && (i === 0 || isSpace(src[i - 1]))) {
      let eol = src.indexOf("\n", i);
      if (eol < 0) eol = n;
      const before = src.slice(segStart, i);
      src = src.slice(0, i) + " ".repeat(eol - i) + src.slice(eol);
      void before;
      i = eol;
      continue;
    }
    if (c === "(") {
      grouping = true;
      parenDepth++;
      i++;
      continue;
    }
    if (c === ")") {
      parenDepth--;
      if (parenDepth < 0) {
        confident = false;
        reasons.push("unbalanced parenthesis");
        parenDepth = 0;
      }
      i++;
      continue;
    }
    if (c === "{" && (i === 0 || isSpace(src[i - 1]) || src[i - 1] === ";" || src[i - 1] === "&" || src[i - 1] === "|" || src[i - 1] === "(") && isSpace(src[i + 1])) {
      grouping = true;
      i++;
      continue;
    }
    if (c === "\n") {
      const segEnd = i;
      i++;
      if (pendingHeredocs.length > 0) {
        const bodyStart = i;
        i = skipHeredocBodies(src, i, pendingHeredocs);
        bodyRanges.push([bodyStart, i]);
        pendingHeredocs = [];
        endSegment(i, "newline", false);
        segStart = i;
        continue;
      }
      endSegment(segEnd, "newline", false);
      segStart = i;
      continue;
    }
    if (c === "&" && src[i + 1] === "&") {
      endSegment(i, "&&", false);
      i += 2;
      segStart = i;
      continue;
    }
    if (c === "|" && src[i + 1] === "|") {
      endSegment(i, "||", false);
      i += 2;
      segStart = i;
      continue;
    }
    if (c === "|") {
      const isPipeBoth = src[i + 1] === "&";
      endSegment(i, "|", false);
      i += isPipeBoth ? 2 : 1;
      segStart = i;
      continue;
    }
    if (c === ";") {
      if (src[i + 1] === ";") {
        confident = false;
        reasons.push("case terminator");
        i += 2;
        continue;
      }
      endSegment(i, ";", false);
      i += 1;
      segStart = i;
      continue;
    }
    if (c === "&") {
      const prev = src[i - 1];
      const next = src[i + 1];
      if (prev === ">" || prev === "<" || next === ">" || next === "<") {
        i++;
        continue;
      }
      endSegment(i, "&", true);
      i += 1;
      segStart = i;
      continue;
    }
    i++;
  }
  if (pendingHeredocs.length > 0) {
    confident = false;
    reasons.push("heredoc without body");
  }
  endSegment(n, "start", false);
  if (parenDepth !== 0) {
    confident = false;
    reasons.push("unbalanced parenthesis");
  }
  return { source: src, segments, heredoc, processSubstitution, grouping, confident, reasons };
}
function stripGroupingWords(words) {
  const out = [...words];
  while (out.length > 0 && (out[0] === "(" || out[0] === "{")) out.shift();
  while (out.length > 0 && (out[out.length - 1] === ")" || out[out.length - 1] === "}")) out.pop();
  if (out.length > 0) {
    const first = out[0];
    if (first.length > 1 && (first.startsWith("(") || first.startsWith("{"))) out[0] = first.slice(1);
    const last = out[out.length - 1];
    if (last.length > 1 && (last.endsWith(")") || last.endsWith("}"))) out[out.length - 1] = last.slice(0, -1);
  }
  return out.filter((w) => w.length > 0);
}
function shQuote(s) {
  if (s.length === 0) return "''";
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// src/core/runners.ts
var TEST_SCRIPT = /^(test|tests|t|spec|specs|unit|e2e|integration|coverage)([:._-].*)?$/i;
var BUILD_SCRIPT = /^(build|compile|bundle|dist|prod|production)([:._-].*)?$/i;
var LINT_SCRIPT = /^(lint|eslint|biome|stylelint|oxlint|prettier:check|format:check|fmt:check|check-format|check:format|fmt-check|lint:fix|lint-fix)([:._-].*)?$/i;
var TYPECHECK_SCRIPT = /^(typecheck|type-check|types|check-types|check:types|tsc|lint:types|typecheck:.*|type-check:.*|tsc:.*)$/i;
var WATCH_SCRIPT = /(^|[:._-])(watch|dev|serve|start|ui)([:._-]|$)/i;
var WATCH_FLAGS = /* @__PURE__ */ new Set(["--watch", "--watchAll", "--watch-all", "-w", "--ui", "--open", "--watch=true", "--watchAll=true"]);
var HELP_FLAGS = /* @__PURE__ */ new Set(["--help", "-h", "-help", "--version", "-V", "help"]);
var LIST_FLAGS = /* @__PURE__ */ new Set(["--collect-only", "--co", "--collectonly", "--list", "--listTests", "--list-tests", "-list", "--dry-run", "--dryrun", "--show-config", "--showConfig", "--print-config", "--debug-config"]);
function basename2(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
function hasAny(words, flags) {
  return words.some((w) => flags.has(w));
}
function watchIn(words) {
  return words.some((w) => WATCH_FLAGS.has(w) || /^--watch(All)?=/.test(w));
}
var VALUE_FLAGS = /* @__PURE__ */ new Set(["-p", "--project", "-c", "--config", "--configPath", "--config-path", "-f", "--file", "-o", "--out", "--outDir", "--outFile", "--out-dir", "-r", "--require", "--reporter", "--setupFile", "--setupFiles", "--dir", "--root", "--rootDir", "--tsconfig", "--env-file", "--env", "--ignore-path", "--ignore-pattern", "--rulesdir", "--resolve-plugins-relative-to", "--parser", "--ext", "--format", "--output-file", "--cache-location", "--max-warnings", "-C", "--directory", "--manifest-path", "--target-dir", "--features", "--package", "-p", "--bin", "--example", "--bench", "--lib", "--workspace", "--exclude", "--filter", "--target", "-t", "--testNamePattern", "--testPathPattern", "--testPathPatterns", "-k", "-m", "--maxfail", "--timeout", "--project", "--pool", "--poolOptions", "--coverage.provider", "--shard", "--concurrency", "--threads", "-j", "--jobs", "--retries", "--repeat", "--run-in-band", "-n", "--name", "--plain-name", "--tags", "-l", "--log-level", "--verbosity", "-v"]);
function positionals(words, from) {
  const out = [];
  for (let i = from; i < words.length; i++) {
    const w = words[i];
    if (w === "--") continue;
    if (w.startsWith("-")) {
      if (VALUE_FLAGS.has(w) && !["-v", "--lib", "--workspace", "--run-in-band"].includes(w)) i++;
      continue;
    }
    out.push(w);
  }
  return out;
}
var FILE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs|mts|cts|go|rs|rb|php|ex|exs|swift|kt|java|cs|vue|svelte|sh|c|cc|cpp|h|hpp|scala|dart|elm|hs)$/i;
function hasFileArgs(words, from) {
  return positionals(words, from).some((p) => FILE_EXT.test(p) || p.includes("::"));
}
function flagValuePresent(words, ...flags) {
  return words.some((w) => flags.some((f) => w === f || w.startsWith(f + "=")));
}
function quietIn(words, extra = []) {
  return words.some((w) => w === "-q" || w === "-qq" || w === "--quiet" || w === "--silent" || w === "--reporter=dot" || w === "--reporter=silent" || extra.includes(w)) || words.some((w, i) => (w === "--reporter" || w === "-R") && (words[i + 1] === "dot" || words[i + 1] === "silent"));
}
function scriptCategory(name) {
  const n = name.trim();
  if (!n) return null;
  const watch = WATCH_SCRIPT.test(n);
  if (TYPECHECK_SCRIPT.test(n)) return { category: "typecheck", watch };
  if (TEST_SCRIPT.test(n)) return { category: "test", watch };
  if (BUILD_SCRIPT.test(n)) return { category: "build", watch };
  if (LINT_SCRIPT.test(n)) return { category: "lint", watch };
  return null;
}
var NPM_RUN_FLAGS = /* @__PURE__ */ new Set(["-s", "--silent", "-q", "--quiet", "--if-present", "--workspaces", "-ws", "--include-workspace-root", "--no-workspaces", "-r", "--recursive", "--parallel", "--stream", "--sequential", "--no-bail", "--bail", "--verbose", "--no-progress"]);
function scriptRunner(tool, words) {
  let i = 1;
  let keyword = null;
  const takesValue = /* @__PURE__ */ new Set(["--filter", "-F", "--workspace", "-w", "-C", "--dir", "--prefix", "--scope", "--project", "-p", "--concurrency", "workspace"]);
  while (i < words.length) {
    const w = words[i];
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
  const scope = cat.category === "test" && (hasFileArgs(rest, 0) || flagValuePresent(rest, "-t", "--testNamePattern", "--testPathPattern", "-k", "--grep", "-g")) ? "subset" : "all";
  const runner = keyword ? `${tool} ${keyword} ${script}` : `${tool} ${script}`;
  return { runner, category: cat.category, scope, quiet: quietIn(words, ["-s"]), notRun };
}
function makeRunner(words) {
  let target = null;
  let dryRun = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
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
  let category = null;
  const t = (target ?? "").toLowerCase();
  if (!target || /^(all|build|compile|dist|release|default)$/.test(t)) category = "build";
  else if (/^(test|tests|check-tests?|unittests?|unit|integration|e2e|spec|specs|test-.*|test_.*)$/.test(t)) category = "test";
  else if (/^(lint|check-lint|lint-check|fmt-check|format-check|clippy|vet|eslint|ruff|flake8|style)$/.test(t)) category = "lint";
  else if (/^(typecheck|type-check|types|mypy|tsc|pyright|check-types)$/.test(t)) category = "typecheck";
  if (!category) return null;
  return { runner: target ? `make ${target}` : "make", category, scope: "all", quiet: words.includes("-s") || words.includes("--silent"), notRun: dryRun ? "dry-run" : null };
}
var PYTEST_SUBSET = ["-k", "-m", "--lf", "--last-failed", "--deselect", "--ignore", "--ignore-glob"];
function classify(input) {
  const words = input;
  if (words.length === 0) return null;
  const w0 = basename2(words[0]);
  const rest = words.slice(1);
  const help = hasAny(rest, HELP_FLAGS) ? "help" : null;
  const list = hasAny(rest, LIST_FLAGS) ? "list" : null;
  const watch = watchIn(rest) ? "watch" : null;
  const notRun = help ?? list ?? watch;
  const sub1 = words[1] ?? "";
  if (w0 === "npm" || w0 === "pnpm" || w0 === "yarn" || w0 === "bun" || w0 === "deno" || w0 === "turbo" || w0 === "lerna" || w0 === "nx") {
    if (w0 === "bun" && sub1 === "test") {
      return { runner: "bun test", category: "test", scope: hasFileArgs(words, 2) || flagValuePresent(rest, "-t", "--test-name-pattern") ? "subset" : "all", quiet: quietIn(rest), notRun };
    }
    if (w0 === "deno" && (sub1 === "test" || sub1 === "check" || sub1 === "lint")) {
      const category = sub1 === "test" ? "test" : sub1 === "check" ? "typecheck" : "lint";
      return { runner: `deno ${sub1}`, category, scope: category === "test" && (hasFileArgs(words, 2) || flagValuePresent(rest, "--filter")) ? "subset" : "all", quiet: quietIn(rest), notRun };
    }
    if (w0 === "npm" && (sub1 === "t" || sub1 === "test" || sub1 === "tst")) {
      const r = words.slice(2);
      return { runner: "npm test", category: "test", scope: hasFileArgs(r, 0) || flagValuePresent(r, "-t", "--testNamePattern") ? "subset" : "all", quiet: quietIn(words, ["-s"]), notRun: watchIn(r) ? "watch" : notRun };
    }
    if (w0 === "nx") {
      let target = null;
      if (sub1 === "run" && words[2]) target = words[2].split(":")[1] ?? null;
      else if (sub1 === "run-many" || sub1 === "affected") {
        const i = words.findIndex((w) => w === "-t" || w === "--target" || w === "--targets");
        target = i >= 0 ? words[i + 1] ?? null : null;
        const eq = words.find((w) => w.startsWith("--target=") || w.startsWith("--targets="));
        if (eq) target = eq.split("=")[1] ?? null;
      } else target = sub1 || null;
      if (!target) return null;
      const cat = scriptCategory(target.split(",")[0]);
      if (!cat) return null;
      return { runner: `nx ${target}`, category: cat.category, scope: "all", quiet: quietIn(rest), notRun: cat.watch ? "watch" : notRun };
    }
    return scriptRunner(w0, words);
  }
  if (w0 === "make" || w0 === "gmake") return makeRunner(words);
  if (w0 === "pytest" || w0 === "py.test" || w0 === "pytest-3") {
    const scope = flagValuePresent(rest, ...PYTEST_SUBSET) || hasFileArgs(words, 1) ? "subset" : "all";
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
    const cat = scriptCategory(words[2]);
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
    const category = sub1 === "test" ? "test" : sub1 === "build" ? "build" : "lint";
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
  if ((w0 === "astro" || w0 === "remix" || w0 === "parcel" || w0 === "expo" || w0 === "docusaurus" || w0 === "gatsby" || w0 === "eleventy" || w0 === "hugo" || w0 === "svelte-kit" || w0 === "rspack" || w0 === "rsbuild" || w0 === "ember") && (sub1 === "build" || sub1 === "export")) {
    return { runner: `${w0} ${sub1}`, category: "build", scope: "all", quiet: false, notRun: rest.includes("--watch") ? "watch" : notRun };
  }
  if (w0 === "webpack" || w0 === "webpack-cli") return { runner: "webpack", category: "build", scope: "all", quiet: false, notRun: sub1 === "serve" || sub1 === "watch" || rest.includes("--watch") || rest.includes("-w") ? "watch" : notRun };
  if (w0 === "webpack-dev-server") return { runner: "webpack", category: "build", scope: "all", quiet: false, notRun: "watch" };
  if (w0 === "rollup") return { runner: "rollup", category: "build", scope: "all", quiet: false, notRun: rest.includes("--watch") || rest.includes("-w") ? "watch" : notRun };
  if (w0 === "esbuild") return { runner: "esbuild", category: "build", scope: "all", quiet: false, notRun: rest.includes("--watch") || rest.some((w) => w.startsWith("--serve")) ? "watch" : notRun };
  if (w0 === "tsup" || w0 === "tsdown" || w0 === "unbuild" || w0 === "microbundle" || w0 === "pkgroll" || w0 === "bunchee") return { runner: w0, category: "build", scope: "all", quiet: false, notRun: rest.includes("--watch") || rest.includes("-w") ? "watch" : notRun };
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
  if (w0 === "php" && basename2(sub1) === "artisan" && words[2] === "test") return { runner: "artisan test", category: "test", scope: flagValuePresent(rest, "--filter") ? "subset" : "all", quiet: false, notRun };
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
var SIMPLE_WRAPPERS = /* @__PURE__ */ new Set(["time", "nice", "command", "exec", "nohup", "caffeinate", "xvfb-run", "stdbuf", "unbuffer", "script", "chronic", "ionice", "hyperfine"]);
var CROSS_ENV = /* @__PURE__ */ new Set(["cross-env", "dotenv", "dotenvx", "direnv"]);
function stripWrappers(input) {
  let w = stripGroupingWords(input);
  let sudo = false;
  let cd = null;
  let nested = null;
  let guard = 0;
  while (w.length > 0 && guard++ < 12) {
    const first = basename2(w[0]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      w = w.slice(1);
      continue;
    }
    if (first === "sudo" || first === "doas") {
      sudo = true;
      let i = 1;
      while (i < w.length && w[i].startsWith("-")) {
        const f = w[i];
        if (f === "-u" || f === "-g" || f === "--user" || f === "--group") i++;
        i++;
      }
      w = w.slice(i);
      continue;
    }
    if (first === "env") {
      let i = 1;
      while (i < w.length && (w[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]))) i++;
      w = w.slice(i);
      continue;
    }
    if (CROSS_ENV.has(first)) {
      let i = 1;
      if (first === "dotenv" || first === "dotenvx") {
        while (i < w.length && w[i].startsWith("-")) {
          const f = w[i];
          if (f === "-e" || f === "-f" || f === "--env-file") i++;
          i++;
        }
        if (w[i] === "run") i++;
        if (w[i] === "--") i++;
      } else if (first === "direnv") {
        if (w[i] === "exec") i += 2;
      } else {
        while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++;
      }
      w = w.slice(i);
      continue;
    }
    if (first === "timeout" || first === "gtimeout") {
      let i = 1;
      while (i < w.length && w[i].startsWith("-")) {
        const f = w[i];
        if (f === "-s" || f === "--signal" || f === "-k" || f === "--kill-after") i++;
        i++;
      }
      i++;
      w = w.slice(i);
      continue;
    }
    if (SIMPLE_WRAPPERS.has(first)) {
      let i = 1;
      while (i < w.length && w[i].startsWith("-")) {
        const f = w[i];
        if (f === "-n" || f === "-o" || f === "-e" || f === "-s" || f === "--server-args" || f === "-a" || f === "-c") i++;
        i++;
      }
      w = w.slice(i);
      continue;
    }
    if (first === "npx" || first === "bunx" || first === "pnpx" || first === "uvx" || first === "pipx") {
      let i = 1;
      while (i < w.length && w[i].startsWith("-")) {
        const f = w[i];
        if (f === "-p" || f === "--package" || f === "-c" || f === "--call" || f === "--spec") i++;
        i++;
      }
      if (w[i] === "run" && first === "pipx") i++;
      w = w.slice(i);
      continue;
    }
    if ((first === "pnpm" || first === "yarn" || first === "npm" || first === "bun") && (w[1] === "exec" || w[1] === "dlx" || w[1] === "x") && w[2]) {
      let i = 2;
      while (i < w.length && w[i].startsWith("-")) i++;
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
      while (i < w.length && w[i].startsWith("-")) {
        const f = w[i];
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
      if (w[1] && basename2(w[1]) === "manage.py") {
        w = w.slice(1);
        continue;
      }
      if (w[1] === "-W" || w[1] === "-X") {
        w = [w[0], ...w.slice(3)];
        continue;
      }
      return { words: w, sudo, cd, nested };
    }
    if (first === "node" && w[1] && !w[1].startsWith("-")) {
      const target = basename2(w[1]);
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
        while (i < w.length && w[i].startsWith("-")) {
          if (w[i] === "--source" || w[i] === "--include" || w[i] === "--omit" || w[i] === "--data-file" || w[i] === "--context") i++;
          i++;
        }
        if (w[i] === "-m") i++;
      } else {
        while (i < w.length && w[i].startsWith("-")) {
          const f = w[i];
          if (f === "-r" || f === "--reporter" || f === "-o" || f === "--reports-dir" || f === "-x" || f === "--exclude" || f === "--include" || f === "-n") i++;
          i++;
        }
      }
      if (w[i] === "--") i++;
      w = w.slice(i);
      continue;
    }
    if ((first === "bash" || first === "sh" || first === "zsh" || first === "dash" || first === "ksh") && w[1] && /^-[a-zA-Z]*c$/.test(w[1]) && w[2] !== void 0) {
      nested = w[2];
      break;
    }
    if ((first === "cd" || first === "pushd") && w[1]) {
      cd = w[1];
      w = w.slice(2);
      continue;
    }
    if (first === "pnpm" || first === "npm" || first === "make") {
      const i = w.findIndex((x) => x === "-C" || x === "--dir" || x === "--prefix" || x === "--directory");
      if (i > 0 && w[i + 1]) {
        cd = w[i + 1];
        w = [...w.slice(0, i), ...w.slice(i + 2)];
        continue;
      }
    }
    break;
  }
  return { words: w, sudo, cd, nested };
}
function joinCd(base, next) {
  if (!next) return base;
  if (next === "-" || next === "~" || next.startsWith("~/")) return next;
  if (next.startsWith("/")) return next;
  if (!base) return next;
  return base.replace(/\/+$/, "") + "/" + next;
}
function detectAll(command, parsed) {
  const p = parsed ?? parseCommand(command);
  const out = [];
  let cd = null;
  for (let i = 0; i < p.segments.length; i++) {
    const seg = p.segments[i];
    const words = stripGroupingWords(seg.words);
    if (words.length === 0) continue;
    if ((words[0] === "cd" || words[0] === "pushd") && words.length === 2) {
      cd = joinCd(cd, words[1]);
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
function detect(command) {
  const all = detectAll(command);
  return all.find((d) => d.notRun === null) ?? null;
}
var SIGNALS = [
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
  { id: "command-not-found", category: "*", kind: "fail", re: /^(?:[^\n:]{0,60}: )?(?:line \d+: )?[^\n:]{1,80}: command not found\s*$|^(?:sh|bash|zsh|dash|\/bin\/sh): \d+: [^\n]+: not found\s*$|^(?:sh|bash|zsh|dash|\/bin\/sh): (?:line \d+: )?[^\n]+: No such file or directory\s*$|^'[^\n']+' is not recognized as an internal or external command/m }
];
var SINGLE_LINE_SUMMARY = /* @__PURE__ */ new Set([
  "pytest-passed",
  "pytest-short-passed",
  "jest-passed",
  "vitest-passed",
  "rspec-passed",
  "phpunit-passed",
  "mix-passed",
  "dotnet-passed",
  "nextest-passed",
  "playwright-passed",
  "ctest-passed",
  "jasmine-passed",
  "minitest-passed",
  "deno-pass",
  "dart-test-passed",
  "elm-test-passed",
  "sbt-test-passed",
  "cypress-passed",
  "gradle-test-passed",
  "maven-passed",
  "tsc-found-zero",
  "svelte-check-ok",
  "mypy-ok",
  "pyright-ok",
  "flow-ok",
  "phpstan-ok",
  "sorbet-ok",
  "dialyzer-ok",
  "ruff-ok",
  "ruff-format-ok",
  "black-ok",
  "biome-ok",
  "rubocop-ok",
  "oxlint-ok",
  "prettier-ok",
  "golangci-ok",
  "credo-ok",
  "swiftlint-ok",
  "dart-analyze-ok",
  "pylint-ok",
  "next-ok",
  "vite-ok",
  "webpack-ok",
  "tsup-ok",
  "rollup-ok",
  "turbo-ok",
  "gradle-build-ok",
  "maven-build-ok",
  "dotnet-build-ok",
  "xcodebuild-ok",
  "swift-build-ok",
  "docker-ok",
  "elm-make-ok",
  "parcel-ok",
  "python-build-ok",
  "esbuild-ok",
  "ninja-ok",
  "cra-ok",
  "astro-ok",
  "angular-ok",
  "docusaurus-ok",
  "gatsby-ok",
  "hugo-ok",
  "eleventy-ok",
  "nuxt-ok",
  "expo-ok",
  "generic-test-passed"
]);
function hasFailSignal(category, rawOutput) {
  const { fail } = matchingSignals(category, cleanOutput(rawOutput ?? ""));
  return fail.length > 0;
}
var COUNT_PATTERNS = [
  // pytest summary: "= 1 failed, 40 passed, 2 skipped in 3.2s ="
  { re: /=+ ((?:\d+ (?:passed|failed|errors?|skipped|deselected|xfailed|xpassed|warnings?)(?:, )?)+) in [\d.]+s/, map: (m) => tallies(m[1]) },
  { re: /^\s*((?:\d+ (?:passed|failed|errors?|skipped|deselected|xfailed|xpassed|warnings?)(?:, )?)+) in [\d.]+s\s*$/m, map: (m) => tallies(m[1]) },
  // jest: "Tests:       1 failed, 2 skipped, 40 passed, 43 total"
  { re: /^\s*Tests:\s+((?:\d+ (?:failed|passed|skipped|todo)(?:, )?)+), (\d+) total/m, map: (m) => ({ ...tallies(m[1]), total: Number(m[2]) }) },
  // vitest: " Tests  2 failed | 39 passed | 1 skipped (42)"
  { re: /^\s*Tests\s+((?:\d+ (?:failed|passed|skipped|todo)(?: \| )?)+) \((\d+)\)/m, map: (m) => ({ ...tallies(m[1].replace(/ \| /g, ", ")), total: Number(m[2]) }) },
  // mocha
  { re: /^\s*(\d+) passing\b[\s\S]*?^\s*(\d+) failing/m, map: (m) => ({ passed: Number(m[1]), failed: Number(m[2]) }) },
  { re: /^\s*(\d+) passing\b/m, map: (m) => ({ passed: Number(m[1]) }) },
  // cargo
  { re: /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/m, map: (m) => ({ passed: Number(m[1]), failed: Number(m[2]), skipped: Number(m[3]) }) },
  // nextest
  { re: /^\s*Summary \[[^\]]*\]\s+(\d+) tests? run: (\d+) passed(?:[^,\n]*)?(?:, (\d+) failed)?(?:, (\d+) skipped)?/m, map: (m) => ({ total: Number(m[1]), passed: Number(m[2]), ...m[3] ? { failed: Number(m[3]) } : {}, ...m[4] ? { skipped: Number(m[4]) } : {} }) },
  // rspec
  { re: /^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/m, map: (m) => ({ total: Number(m[1]), failed: Number(m[2]), passed: Number(m[1]) - Number(m[2]) - Number(m[3] ?? 0), ...m[3] ? { skipped: Number(m[3]) } : {} }) },
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
  { re: /^\s*(\d+) tests? passed(?:\n\s*(\d+) tests? failed)?/m, map: (m) => ({ passed: Number(m[1]), ...m[2] ? { failed: Number(m[2]) } : {} }) },
  // typecheck and lint error counts
  { re: /^Found (\d+) errors?(?: in \d+ files?)?/m, only: ["typecheck", "lint", "build"], map: (m) => ({ errors: Number(m[1]) }) },
  { re: /^(\d+) errors?, (\d+) warnings?/m, only: ["typecheck", "lint", "build"], map: (m) => ({ errors: Number(m[1]) }) },
  { re: /✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/m, only: ["lint"], map: (m) => ({ errors: Number(m[2]) }) },
  { re: /(\d+) offenses? detected/m, only: ["lint"], map: (m) => ({ errors: Number(m[1]) }) },
  { re: /svelte-check found (\d+) errors?/m, only: ["typecheck"], map: (m) => ({ errors: Number(m[1]) }) },
  { re: /Found \d+ warnings? and (\d+) errors?/m, only: ["lint"], map: (m) => ({ errors: Number(m[1]) }) }
];
var TEST_ONLY_COUNT = COUNT_PATTERNS.length - 6;
function tallies(s) {
  const out = {};
  for (const m of s.matchAll(/(\d+) (passed|failed|errors?|skipped|deselected|xfailed|xpassed|warnings?|todo)/g)) {
    const n = Number(m[1]);
    const k = m[2];
    if (k === "passed") out.passed = n;
    else if (k === "failed") out.failed = n;
    else if (k.startsWith("error")) out.errors = n;
    else if (k === "skipped" || k === "deselected" || k === "xfailed" || k === "todo") out.skipped = (out.skipped ?? 0) + n;
  }
  return out;
}
function parseCounts(output, category) {
  for (let i = 0; i < COUNT_PATTERNS.length; i++) {
    const p = COUNT_PATTERNS[i];
    if (category && i < TEST_ONLY_COUNT && category !== "test") continue;
    if (category && p.only && !p.only.includes(category)) continue;
    if (p.last) {
      const all = [...output.matchAll(p.re)];
      const m2 = all[all.length - 1];
      if (m2) return p.map(m2);
      continue;
    }
    const m = output.match(p.re);
    if (m) return p.map(m);
  }
  return {};
}
var NOT_RUN_ANY = /no tests ran|No tests found|No test files found|collected 0 items|Ran 0 tests|^0 tests? (?:ran|run|executed)/im;
function matchingSignals(category, output) {
  const pass = [];
  const fail = [];
  const notrun = [];
  for (const s of SIGNALS) {
    if (s.category !== category && s.category !== "*") continue;
    if (!s.re.test(output)) continue;
    if (s.kind === "pass") pass.push(s.id);
    else if (s.kind === "fail") fail.push(s.id);
    else notrun.push(s.id);
  }
  return { pass, fail, notrun };
}
var BANNER_LINE = /^(?:>\s.*|\$ .*|yarn run v[\d.]+|(?:✨\s+)?Done in [\d.]+m?s\.?|info Visit https:\/\/yarnpkg\.com.*|\[stalegreen\] .*|npm warn .*|npm notice .*|Shell cwd was reset to .*|Session cwd remains .*|\s*)$/;
function isSilent(output) {
  return cleanOutput(output).split("\n").every((line) => BANNER_LINE.test(line));
}
function cleanOutput(output) {
  const text = output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r\n/g, "\n");
  if (!text.includes("\r")) return text;
  return text.split("\n").map((line) => line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line).join("\n");
}
function parseOutput(category, rawOutput, opts) {
  const output = cleanOutput(rawOutput ?? "");
  const { pass, fail, notrun } = matchingSignals(category, output);
  const counts = parseCounts(output, category);
  const base = { counts, passSignals: pass, failSignals: fail };
  if (opts.interrupted) return { ...base, verdict: "inconclusive", signal: "interrupted" };
  if (opts.exit !== null && opts.exit !== void 0 && opts.exit !== 0) {
    return { ...base, verdict: "fail", signal: fail[0] ?? `exit-${opts.exit}` };
  }
  if (opts.failed && (opts.exit === null || opts.exit === void 0)) {
    return { ...base, verdict: "fail", signal: fail[0] ?? "exit-nonzero" };
  }
  if (category === "test" && (notrun.length > 0 || NOT_RUN_ANY.test(output)) && pass.length === 0) {
    return { ...base, verdict: "inconclusive", signal: notrun[0] ?? "no-tests" };
  }
  if (category !== "test" && notrun.length > 0 && pass.length === 0 && fail.length === 0) {
    return { ...base, verdict: "inconclusive", signal: notrun[0] };
  }
  if (opts.exit === null || opts.exit === void 0) {
    if (fail.length > 0) return { ...base, verdict: "fail", signal: fail[0] };
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
  if (pass.length > 0) return { ...base, verdict: "pass", signal: pass[0] };
  if (category === "test") return { ...base, verdict: "inconclusive", signal: "no-summary" };
  return { ...base, verdict: "pass", signal: "exit-0" };
}

// src/core/edits.ts
var EDIT_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
function editFromTool(toolName, toolInput) {
  if (!EDIT_TOOLS.has(toolName)) return null;
  const input = toolInput ?? {};
  const path = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
  return { path, kind: toolName };
}
var GIT_TREE_COMMANDS = /* @__PURE__ */ new Set(["apply", "am", "checkout", "switch", "restore", "stash", "merge", "rebase", "cherry-pick", "revert", "reset", "pull", "clean", "mv", "rm", "worktree"]);
var INSTALL_COMMANDS = {
  npm: /* @__PURE__ */ new Set(["install", "i", "add", "uninstall", "remove", "rm", "un", "update", "up", "ci", "link", "dedupe", "prune"]),
  pnpm: /* @__PURE__ */ new Set(["install", "i", "add", "remove", "rm", "uninstall", "update", "up", "link", "dedupe", "prune", "patch"]),
  yarn: /* @__PURE__ */ new Set(["add", "remove", "install", "up", "upgrade", "dedupe", "link"]),
  bun: /* @__PURE__ */ new Set(["add", "install", "i", "remove", "rm", "update", "link"]),
  pip: /* @__PURE__ */ new Set(["install", "uninstall"]),
  pip3: /* @__PURE__ */ new Set(["install", "uninstall"]),
  uv: /* @__PURE__ */ new Set(["add", "remove", "sync", "pip", "lock"]),
  poetry: /* @__PURE__ */ new Set(["add", "remove", "install", "update", "lock"]),
  pipenv: /* @__PURE__ */ new Set(["install", "uninstall", "update", "lock"]),
  cargo: /* @__PURE__ */ new Set(["add", "remove", "rm", "update"]),
  go: /* @__PURE__ */ new Set(["get", "mod"]),
  bundle: /* @__PURE__ */ new Set(["add", "install", "update", "remove"]),
  gem: /* @__PURE__ */ new Set(["install", "uninstall"]),
  composer: /* @__PURE__ */ new Set(["require", "install", "update", "remove"]),
  mix: /* @__PURE__ */ new Set(["deps.get", "deps.update"]),
  dotnet: /* @__PURE__ */ new Set(["add", "remove", "restore"])
};
var FORMATTERS = [
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
  { name: "oxlint", check: /^--fix$/ }
];
var HEREDOC_WRITE_RE = /\bopen\([^)]*['"][wax][bt+]*['"]|\.write_text\(|\.write_bytes\(|writeFileSync\(|writeFile\(|appendFileSync\(|fs\.write|\bshutil\.(?:copy|move|rmtree)|os\.(?:rename|remove|unlink|replace|makedirs|mkdir)|Path\([^)]*\)\.(?:unlink|rename|touch|mkdir)|File\.(?:write|open\([^)]*['"][wa])|IO\.write|fs\.rm|rmSync\(|renameSync\(|copyFileSync\(|mkdirSync\(|subprocess\.(?:run|call|check_output)\([^)]*(?:sed|mv|cp|rm|git)\b|\bsed -i\b|\bmv \b|\bcp \b|\brm \b/;
function heredocPaths(command) {
  const body = command.slice(command.indexOf("<<"));
  const out = /* @__PURE__ */ new Set();
  for (const m of body.matchAll(/['"]([^'"\n]{2,200}?\.[A-Za-z0-9]{1,6})['"]/g)) {
    const p = m[1];
    if (/\s{2,}|[{}<>|*?]/.test(p)) continue;
    if (/^(?:https?:|mailto:|www\.)/i.test(p)) continue;
    out.add(p);
    if (out.size >= 8) break;
  }
  return [...out];
}
function lastPositional(words) {
  for (let i = words.length - 1; i >= 1; i--) {
    const w = words[i];
    if (!w.startsWith("-")) return w;
  }
  return null;
}
function formatterEdit(words) {
  const w0 = words[0].replace(/^.*\//, "");
  for (const f of FORMATTERS) {
    if (w0 !== f.name) continue;
    const rest = words.slice(1);
    if (f.name === "prettier" || f.name === "black" || f.name === "isort" || f.name === "swiftformat" || f.name === "rustfmt") {
      if (rest.some((w) => f.check.test(w))) return null;
      return { path: null, kind: "format" };
    }
    if (f.name === "eslint" || f.name === "stylelint" || f.name === "oxlint" || f.name === "standard") {
      return rest.some((w) => f.check.test(w)) ? { path: null, kind: "format" } : null;
    }
    if (f.name === "biome") {
      return rest.some((w) => f.check.test(w)) ? { path: null, kind: "format" } : null;
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
    if (f.name === "autopep8" || f.name === "yapf") return rest.some((w) => f.check.test(w)) ? { path: null, kind: "format" } : null;
  }
  return null;
}
function gitChangedTree(sub, words, output) {
  const quiet = output.trim().length === 0;
  if (sub === "pull" || sub === "merge" || sub === "rebase" || sub === "cherry-pick" || sub === "revert" || sub === "am") {
    if (quiet) return false;
    if (/Already up[ -]to[ -]date|is up to date\.|nothing to commit|No changes|error: |CONFLICT \(|fatal: /i.test(output)) return false;
    return /Fast-forward|Updating [0-9a-f]+\.\.[0-9a-f]+|Merge made|Successfully rebased|files? changed|\| \d+ [+-]|create mode|delete mode/.test(output);
  }
  if (sub === "checkout" || sub === "switch") {
    if (words.includes("--")) return true;
    if (quiet) return false;
    if (/Already on '|fatal: |error: /.test(output)) return false;
    return /Switched to (?:a new )?branch|HEAD is now at|Updated \d+ paths?|Reset branch/.test(output);
  }
  if (sub === "stash") {
    if (quiet) return false;
    if (/No local changes to save|No stash entries found|fatal: /.test(output)) return false;
    return true;
  }
  if (sub === "apply") return !/error: |does not apply|fatal: /.test(output);
  if (sub === "clean") return /Removing /.test(output);
  if (sub === "reset") return !/fatal: /.test(output);
  return true;
}
function segmentEdits(seg, output = "") {
  const out = [];
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
  const w0 = words[0].replace(/^.*\//, "");
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
    if (w1 === "checkout" && words.some((w) => w === "-b" || w === "-B" || w === "--orphan") || w1 === "switch" && words.some((w) => w === "-c" || w === "-C" || w === "--orphan")) return out;
    if (w1 === "reset" && !words.some((w) => w === "--hard" || w === "--merge" || w === "--keep") && !words.includes("--")) return out;
    if (!gitChangedTree(w1, words, output)) return out;
    const dash = words.indexOf("--");
    const path = dash >= 0 && words[dash + 1] ? words[dash + 1] : null;
    out.push({ path, kind: `git ${w1}` });
  } else if (INSTALL_COMMANDS[w0]?.has(w1)) {
    out.push({ path: null, kind: `${w0} ${w1}` });
  } else if (w0 === "npx" || w0 === "bunx") {
  } else {
    const f = formatterEdit(words);
    if (f && formatterChangedFiles(w0, words, output)) out.push(f);
  }
  return out;
}
function formatterChangedFiles(tool, words, output) {
  if (!output) return true;
  if (tool === "ruff") {
    if (words[1] === "format") return /[1-9]\d* files? reformatted/.test(output) || !/files? (?:already formatted|left unchanged)/.test(output);
    return /Fixed [1-9]\d* errors?|\([1-9]\d* fixed/.test(output) || !/(?:All checks passed!|Found \d+ errors?\.?\s*$)/m.test(output);
  }
  if (tool === "black") return /^reformatted |[1-9]\d* files? reformatted/m.test(output) || !/files? would be left unchanged|files? left unchanged/.test(output);
  if (tool === "prettier") return !/^\S+ \d+ms \(unchanged\)/m.test(output) || /^\S+ \d+ms$/m.test(output);
  return true;
}
function editsFromBash(command, output = "") {
  const parsed = parseCommand(command);
  const out = [];
  for (const seg of parsed.segments) {
    if (seg.words.length === 0 && seg.redirects.length === 0) continue;
    out.push(...segmentEdits(seg, output));
  }
  if (parsed.heredoc && out.length === 0) {
    const feeds = parsed.segments.some((s) => s.redirects.some((r) => r.op.startsWith("<<")) && /^(?:python[0-9.]*|node|ruby|perl|php|sh|bash|zsh)$/.test((s.words[0] ?? "").replace(/^.*\//, "")));
    if (feeds && HEREDOC_WRITE_RE.test(command)) {
      const paths = heredocPaths(command);
      if (paths.length === 0) out.push({ path: null, kind: "heredoc" });
      else for (const p of paths) out.push({ path: p, kind: "heredoc" });
    }
  }
  const seen = /* @__PURE__ */ new Set();
  return out.filter((e) => {
    const key = `${e.kind}:${e.path ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function toEditEvent(c, ts, agent) {
  const ev = { ts, path: c.path, kind: c.kind };
  if (agent) ev.agent = agent;
  return ev;
}

// src/core/rewrite.ts
import { dirname as dirname3 } from "path";

// src/core/masking.ts
var FILTERS = /* @__PURE__ */ new Set(["grep", "egrep", "fgrep", "rg", "head", "sed", "awk", "cut", "wc", "sort", "uniq", "tr", "jq", "less", "more", "tail"]);
var PASSTHROUGH = /* @__PURE__ */ new Set(["cat", "tee"]);
function isDevNull(target) {
  return target === "/dev/null";
}
function tailCount(words) {
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    let m = /^-n(\d+)$/.exec(w) ?? /^-(\d+)$/.exec(w) ?? /^--lines=(\d+)$/.exec(w);
    if (m) return Number(m[1]);
    if ((w === "-n" || w === "--lines") && words[i + 1]) {
      m = /^\+?(\d+)$/.exec(words[i + 1]);
      if (m) return Number(m[1]);
    }
  }
  return 10;
}
function remainderText(parsed, from) {
  return parsed.segments.slice(from).map((s) => s.head).join(" ; ");
}
function hasPipefail(parsed, before) {
  for (let i = 0; i < before; i++) {
    const s = parsed.segments[i];
    if (s.words[0] === "set" && s.words.some((w) => w === "pipefail") && s.words.some((w) => w === "-o" || /^-[a-z]*o[a-z]*$/.test(w))) return true;
  }
  return false;
}
function analyzeMasking(parsed, index) {
  const seg = parsed.segments[index];
  const reasons = [];
  let exitPreserved = true;
  let outputVisible = true;
  let tailLines = null;
  let headLines = null;
  let filtered = false;
  const filterPatterns = [];
  let countOnly = false;
  const pipefail = hasPipefail(parsed, index);
  let pipelineEnd = index;
  if (seg.negated) {
    reasons.push("negated");
    exitPreserved = false;
  }
  for (const r of seg.redirects) {
    const toStdout = r.fd === null || r.fd === 1;
    if ((r.op === ">" || r.op === ">>" || r.op === ">|") && toStdout) {
      if (isDevNull(r.target)) {
        reasons.push("devnull:stdout");
        outputVisible = false;
      } else if (!/^&\d$/.test(r.target)) {
        reasons.push(`redirect:${r.target}`);
        outputVisible = false;
      }
    } else if ((r.op === ">" || r.op === ">>") && r.fd === 2 && isDevNull(r.target)) {
      reasons.push("devnull:stderr");
    } else if (r.op === "&>" || r.op === "&>>") {
      reasons.push(isDevNull(r.target) ? "devnull:both" : `redirect:${r.target}`);
      outputVisible = false;
    }
  }
  let j = index + 1;
  while (j < parsed.segments.length && parsed.segments[j].op === "|") {
    const next = parsed.segments[j];
    const cmd = next.words[0] ?? "";
    pipelineEnd = j;
    if (!pipefail) exitPreserved = false;
    if (FILTERS.has(cmd)) {
      reasons.push(`pipe:${cmd}`);
      if (cmd === "tail") tailLines = tailCount(next.words);
      else if (cmd === "head") {
        headLines = tailCount(next.words);
        outputVisible = false;
      } else {
        outputVisible = false;
        filtered = true;
        if (cmd === "grep" || cmd === "egrep" || cmd === "fgrep" || cmd === "rg") {
          const pattern = grepPattern(next.words);
          const inverted = next.words.some((w) => w === "-v" || w === "--invert-match" || /^-[a-zA-Z]*v[a-zA-Z]*$/.test(w));
          if (pattern !== null && (!inverted || /error|✖|problem|fail|warning/i.test(pattern))) filterPatterns.push(inverted ? `!${pattern}` : pattern);
          countOnly = next.words.some((w) => w === "-c" || w === "--count" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
        } else if (cmd === "wc") countOnly = next.words.includes("-l");
        else countOnly = false;
      }
    } else if (PASSTHROUGH.has(cmd)) {
      reasons.push(`pipe:${cmd}`);
    } else if (cmd === "xargs" && next.words[1] === "echo") {
      reasons.push("pipe:xargs");
    } else {
      reasons.push(`pipe:${cmd || "?"}`);
      outputVisible = false;
      countOnly = false;
    }
    j++;
  }
  if (j - 1 === pipelineEnd && pipelineEnd > index && pipefail) {
  }
  let background = seg.background;
  let k = pipelineEnd;
  if (parsed.segments[k].background) background = true;
  while (k + 1 < parsed.segments.length) {
    const next = parsed.segments[k + 1];
    const op = next.op;
    if (op === "&&") {
      k++;
      continue;
    }
    if (op === "||") {
      const rest = remainderText(parsed, k + 1);
      if (!/\b(?:exit|return|false|kill)\b/.test(rest)) {
        reasons.push("or-chain");
        exitPreserved = false;
      }
      break;
    }
    if (op === ";" || op === "newline") {
      const rest = remainderText(parsed, k + 1);
      if (rest.trim().length > 0 && !/\bexit \$\?/.test(rest) && !/^\s*(?:true|:)\s*$/.test(rest)) {
        reasons.push("semicolon");
        exitPreserved = false;
      }
      break;
    }
    if (op === "&") {
      break;
    }
    break;
  }
  if (parsed.segments[k].background) background = true;
  const masked = reasons.some((r) => r !== "devnull:stderr") || !exitPreserved;
  return { masked, reasons, exitPreserved, outputVisible, tailLines, headLines, filtered, filterPatterns, countOnly, pipefail, background, pipelineEnd };
}
function grepPattern(words) {
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if ((w === "-e" || w === "--regexp") && words[i + 1]) return words[i + 1];
    if (w.startsWith("--regexp=")) return w.slice(9);
  }
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("-")) {
      if ((w === "-A" || w === "-B" || w === "-C" || w === "-m" || w === "--max-count") && words[i + 1]) i++;
      continue;
    }
    return w;
  }
  return null;
}

// src/core/rewrite.ts
var DROPPABLE = /* @__PURE__ */ new Set(["tail", "head", "grep", "egrep", "fgrep", "rg", "wc", "cut", "awk", "sed", "less", "more", "cat", "sort", "uniq", "tr", "jq", "column", "nl"]);
function teeTargets(seg) {
  if (seg.words[0] !== "tee") return null;
  const files = [];
  let append = false;
  for (const w of seg.words.slice(1)) {
    if (w === "-a" || w === "--append") append = true;
    else if (w.startsWith("-")) return null;
    else files.push(w);
  }
  return files.length > 0 ? { files, append } : null;
}
function refusalReason(parsed, detection) {
  if (!parsed.confident) return `unreadable: ${parsed.reasons[0] ?? "parse"}`;
  if (parsed.heredoc) return "heredoc";
  if (parsed.processSubstitution) return "process-substitution";
  if (parsed.grouping) return "grouping";
  if (parsed.segments.some((s) => s.background)) return "background";
  if (detection.sudo) return "sudo";
  if (detection.nested) return "nested-shell";
  if (detection.notRun) return detection.notRun;
  const seg = detection.segment;
  for (const r of seg.redirects) {
    const stdout = r.fd === null || r.fd === 1;
    if ((r.op === ">" || r.op === ">>" || r.op === ">|" || r.op === "&>" || r.op === "&>>") && stdout && !/^&\d$/.test(r.target)) return `redirect:${r.target}`;
    if (r.op === "<" || r.op === "<<<" || r.op === "<&") return "stdin-redirect";
  }
  if (seg.negated) return "negated";
  return null;
}
function shellPath(p) {
  return process.platform === "win32" ? p.replace(/\\/g, "/") : p;
}
function wrapper(head, id, log, tailLines, tee) {
  const q = shQuote(shellPath(log));
  const dir = shQuote(shellPath(dirname3(log)));
  const parts = [];
  parts.push(`__sg_log=${q}`);
  parts.push(`mkdir -p ${dir}`);
  parts.push(`{ ${head} ; } > "$__sg_log" 2>&1`);
  parts.push("__sg_rc=$?");
  parts.push(`printf '%s\\n' "$__sg_rc" > "$__sg_log.exit"`);
  if (tee) for (const f of tee.files) parts.push(`cat "$__sg_log" ${tee.append ? ">>" : ">"} ${shQuote(f)}`);
  parts.push(`tail -n ${tailLines} "$__sg_log"`);
  parts.push(`printf '\\n[stalegreen] exit=%s receipt=${id} lines=%s log=%s\\n' "$__sg_rc" "$(wc -l < "$__sg_log" | tr -d ' ')" "$__sg_log"`);
  parts.push(`(exit "$__sg_rc")`);
  return `{ ${parts.join("; ")}; }`;
}
function unfilteredCommand(command, targets, parsed) {
  const p = parsed ?? parseCommand(command);
  const ends = /* @__PURE__ */ new Map();
  for (const t of targets) ends.set(t.detection.segmentIndex, analyzeMasking(p, t.detection.segmentIndex).pipelineEnd);
  let out = "";
  let cursor = 0;
  for (let i = 0; i < p.segments.length; i++) {
    const end = ends.get(i);
    if (end === void 0 || end === i) continue;
    const first = p.segments[i];
    const last = p.segments[end];
    const rawLast = p.source.slice(last.start, last.end);
    out += p.source.slice(cursor, first.end).replace(/\s+$/, "");
    cursor = last.end - (rawLast.length - rawLast.trimEnd().length);
    i = end;
  }
  out += p.source.slice(cursor);
  return out;
}
function planRewrite(command, targets, config, parsed) {
  const p = parsed ?? parseCommand(command);
  if (targets.length === 0) return { command: null, reason: "no-runner", tailLines: config.tailLines, ids: [] };
  let tailLines = config.tailLines;
  const replacements = /* @__PURE__ */ new Map();
  for (const t of targets) {
    const d = t.detection;
    const refuse = refusalReason(p, d);
    if (refuse) return { command: null, reason: refuse, tailLines, ids: [] };
    const analysis = analyzeMasking(p, d.segmentIndex);
    if (analysis.tailLines !== null) tailLines = targets.length === 1 ? Math.max(20, analysis.tailLines) : Math.max(tailLines, Math.max(20, analysis.tailLines));
    let tee = null;
    for (let j = d.segmentIndex + 1; j <= analysis.pipelineEnd; j++) {
      const seg = p.segments[j];
      const cmd = seg.words[0] ?? "";
      const t2 = teeTargets(seg);
      if (t2) {
        tee = tee ? { files: [...tee.files, ...t2.files], append: tee.append && t2.append } : t2;
        continue;
      }
      if (!DROPPABLE.has(cmd)) return { command: null, reason: `pipe:${cmd || "?"}`, tailLines, ids: [] };
      if (seg.redirects.length > 0) return { command: null, reason: `pipe-redirect:${cmd}`, tailLines, ids: [] };
    }
    if (analysis.pipefail && analysis.pipelineEnd > d.segmentIndex) {
    }
    replacements.set(d.segmentIndex, { text: wrapper(d.segment.head, t.id, t.log, tailLines, tee), end: analysis.pipelineEnd });
  }
  let out = "";
  let cursor = 0;
  const segments = p.segments;
  for (let i = 0; i < segments.length; i++) {
    const rep = replacements.get(i);
    if (!rep) continue;
    const first = segments[i];
    const last = segments[rep.end];
    const rawFirst = p.source.slice(first.start, first.end);
    const rawLast = p.source.slice(last.start, last.end);
    const startPos = first.start + (rawFirst.length - rawFirst.trimStart().length);
    const endPos = last.end - (rawLast.length - rawLast.trimEnd().length);
    out += p.source.slice(cursor, startPos);
    out += rep.text;
    cursor = endPos;
    i = rep.end;
  }
  out += p.source.slice(cursor);
  if (targets.length > 0 && tailLines !== config.tailLines) {
    out = out.replace(/tail -n \d+ "\$__sg_log"/g, `tail -n ${tailLines} "$__sg_log"`);
  }
  return { command: out, reason: null, tailLines, ids: targets.map((t) => t.id) };
}

// src/harness/hooks.ts
import { join as join5 } from "path";

// src/core/claims.ts
var FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
var INLINE_CODE_RE = /`[^`\n]*`/g;
var DOUBLE_QUOTE_RE = /(^|[\s(\[:,])["“][^"”\n]{1,120}["”](?=[\s.,;:!?)\]]|$)/g;
var SINGLE_QUOTE_RE = /(^|[\s(\[:,])['‘][^'’\n]{1,80}['’](?=[\s.,;:!?)\]]|$)/g;
var SENTENCE_SPLIT_RE = /(?<=[.!?])\s+|\n+/;
var UNCHECKED_TODO_RE = /^\s*(?:[-*+]\s*)?\[ \]/;
var LEADING_NOISE_RE = /^(?:[\s\-*+>#|✓✔✅•·]+|\d+[.)]\s+)+/;
var NUM = "\\d{1,3}(?:,\\d{3})+|\\d+";
var CONDITIONAL_WORDS = [
  "as soon as",
  "gates? (?:deploys?|merges?|releases?) on",
  "depends on",
  "conditional on",
  "on tests? passing",
  "only when",
  "only if",
  "make sure",
  "makes sure",
  "making sure",
  "ensure",
  "ensuring",
  "ensures",
  "until",
  "once",
  "if",
  "unless",
  "should",
  "will",
  "would",
  "could",
  "might",
  "may",
  "need(?:s|ed)? to",
  "must",
  "so that",
  "when",
  "whenever",
  "whether",
  "verify(?:ing)? (?:that|if|whether)",
  "to verify",
  "check(?:ed|ing|s)? (?:that|if|whether)",
  "to check",
  "confirm(?:ing)? (?:that|if|whether)",
  "to confirm",
  "expect(?:s|ed|ing)?",
  "assum(?:e|es|ing)",
  "let'?s",
  "let me",
  "going to",
  "gonna",
  "want(?:s|ed)?",
  "hope(?:fully)?",
  "please",
  "can you",
  "goal",
  "todo",
  "to-do",
  "next steps?",
  "re-?run(?:ning)?",
  "try(?:ing)?",
  "plan(?:ning|s)?",
  "step \\d",
  "criteria",
  "requirement",
  "acceptance",
  "definition of done",
  "not yet",
  "haven'?t",
  "hasn'?t",
  "hadn'?t",
  "you said",
  "you asked",
  "the user",
  "instructions?",
  "requires?",
  "required",
  "guarantee",
  "blocked",
  "blocker",
  "only after",
  "after (?:you|that|this)",
  "believe",
  "think",
  "presumably",
  "probably",
  "likely",
  "appears?",
  "seems?",
  "looks? like",
  "supposedly",
  "supposed to",
  "allegedly",
  "reportedly",
  "in theory",
  "working on",
  "in progress",
  "wip",
  "not sure",
  "unsure",
  "unclear",
  "not certain",
  "double[- ]check",
  "sanity[- ]check",
  "to be safe",
  "to see if",
  "and see",
  "still (?:need|have) to",
  "waiting (?:for|on)",
  "pending",
  "then (?:run|re-?run|verify|check)",
  "before (?:merging|committing|shipping|release)",
  "about to",
  "am going",
  "i'?m going"
];
var CONDITIONAL_RE = new RegExp(`\\b(?:${CONDITIONAL_WORDS.join("|")})\\b`, "i");
var IMPERATIVE_RE = /^(?:please\s+)?(?:run|re-?run|check|verify|confirm|try|make sure|ensure|let me know|see|note|remember|use|execute|kick off|start)\b/i;
var RELAYED_RE = new RegExp(
  [
    "you (?:said|mentioned|asked|told|noted|wrote|reported|indicated|claimed|stated)",
    "according to",
    "as (?:you|the (?:readme|docs?|issue|pr|ticket|spec)) (?:said|says|noted|notes|mentioned|mentions)",
    "per the (?:readme|docs?|documentation|issue|pr|ticket|spec|description|comment|changelog)",
    "the (?:(?:pr|pull request|issue|ticket|task|original|previous|earlier|last|prior|old) )?(?:readme|docs?|documentation|issue|pr|pull request|ticket|description|commit message|commit|changelog|comment|comments|session|run summary|summary|agent|report|note|notes|spec) (?:says?|said|claims?|claimed|states?|stated|mentions?|mentioned|notes?|noted|indicates?|indicated|reports?|reported|asserts?|asserted|suggests?|suggested)",
    "(?:in|on) ci\\b",
    "ci (?:is |are |was |went |stays |remains |all )?(?:green|passing|passes|passed|clean|happy)",
    "(?:github|gitlab) actions? (?:is |are |was )?(?:green|passing|passes|passed)",
    "the pipeline (?:is |was )?(?:green|passing|passes|passed)",
    "^ci\\b",
    "\\d+-way matrix",
    "ci matrix",
    "workflow runs?",
    "actions? runs?"
  ].join("|"),
  "i"
);
var OPERATIONS_RE = /\b(?:health(?:check)?s?|smoke|uptime|falco|pm2|endpoints?|probes?|live site|on prod|in production|production is|deployed|deploys?|served|cdn|status codes?|http \d{3}|\b\d{3} ok\b|200s?\b|500s?\b|infra|infrastructure|monitors?|dns|ssl|certificates?)\b/i;
var MENTION_RE = /\b(?:badge|shields?\.io|label(?:led)?|heading|headline|placeholder|wording)\b/i;
var MANUAL_TEST_RE = /\b(?:live|manual|manually|supervised|smoke|browser|visual|hands-on) (?:\w+ )?tests?\b/i;
var VERIFICATION_NOUN_RE = /\b(?:tests?|suite|tsc|typecheck|type-?check|types|lint|linter|eslint|ruff|clippy|mypy|pyright|builds?|compile[sd]?|vitest|jest|pytest|gates?)\b/i;
var FAILURE_RE = /\b(fail(?:s|ed|ing|ure|ures)?|broken|regress(?:ion|ions|ed)|crash(?:es|ed|ing)?|hangs?|not all|none of|no tests?|zero tests|error(?:s)? remain|still (?:erroring|red)|is red|are red)\b/gi;
var FAILURE_NEGATOR_RE = /\b(?:no|zero|0|without|none|nothing|never)\b(?:\s+\S+){0,2}\s*$/i;
var NEGATION_BEFORE_RE = /\b(?:not|never|no longer|isn'?t|aren'?t|wasn'?t|weren'?t|don'?t|doesn'?t|didn'?t|won'?t|can'?t|cannot|couldn'?t|previously|used to|originally|earlier|initially|before|without|instead of|rather than|stop(?:ped)?|until)\b/i;
var NEGATION_AFTER_RE = /\b(?:but not|not any ?more|no longer|before (?:my|the|this|these|those|that|i)\b|prior to|as of (?:the|my) (?:previous|last|earlier)|on (?:main|master|the previous|the old) (?:branch|commit|version)?)/i;
var QUALIFIER_RE = /\b(?:remaining|pre-?existing|except|excluding|unrelated|known (?:[\w-]+ ){0,2}(?:failures?|issues?|problems?|breakages?|errors?|warnings?|prerender|limitations?)|only the known|flaky|other than|apart from|aside from|besides|all other|the other|only (?:the|these|those|\d+)|partial(?:ly)?|mostly|most|almost|nearly|so far|for now|at least|the rest|subset|ignoring|for (?:its|these|those|my|the new|the changed|the touched|the affected|the modified) files?|on its files)\b/i;
var EVERYTHING_RE = /(?<!\b(?:smoke|health|status|uptime|infra|infrastructure|prod|production|deploys?|endpoints?|routes?|pages?|links?|servers?|services?|processes|monitors?|queues?) )\b(?:everything|all checks|all the checks|all verification|all verifications|every check|gates)(?: (?:is|are|now|still|also|else))* (?:pass(?:es|ed|ing)?|green|clean|succeed(?:s|ed)?)\b|(?<!\b(?:smoke|health|status|uptime|infra|infrastructure|prod|production|deploys?|endpoints?|routes?|pages?|links?|servers?|services?|processes|monitors?|queues?|checks?) )\ball green\b|\bgreen across the board\b|\bpass(?:es|ed)? every check\b/i;
var AUX = "(?: (?:are|is|now|still|were|was|all|both|also|currently|already|again|finally|exits?|exited|returns?|returned|comes back|came back|finishes|finished|ran|runs))*";
var PATTERNS = [
  {
    id: "all_tests_pass",
    category: "test",
    re: new RegExp(`\\b(?:all|every)(?: (?:${NUM})| of the| the| existing| (?:${NUM}) of the| my| our| your| (?:${NUM}) of)?(?: [\\w-]+){0,2}? tests?(?: cases?)?(?: (?:in|of|for|from|under|inside|across) (?:the )?[\\w./-]+(?: [\\w-]+){0,2})?${AUX} (?:pass(?:es|ed|ing)?|green|succeed(?:ed|s)?)\\b`, "i"),
    scope: "all"
  },
  {
    id: "suite_green",
    category: "test",
    re: new RegExp(`\\b(?:the )?(?:(?:(?:full|entire|whole|complete|test|unit test|integration test|e2e|end-to-end|spec) )?suite|test run|test suite):?${AUX} (?:green|pass(?:es|ed|ing)?|clean|succeed(?:s|ed)?|passing)\\b`, "i"),
    scope: "all"
  },
  {
    id: "suite_ran_clean",
    category: "test",
    re: /\b(?:the )?(?:suite|tests?|test run|specs?)(?: (?:ran|runs|completed?|finish(?:ed|es)|came back|come back|are back|is back|went))+ (?:clean|cleanly|successfully|green|all green|through|without (?:any )?(?:failures?|errors?|issues?|problems?))\b/i,
    scope: (s) => /\bsuite\b/i.test(s) ? "all" : "some"
  },
  {
    id: "tests_pass",
    category: "test",
    re: new RegExp(`\\b(?:the |both |existing |new |unit |integration |remaining |updated |affected |relevant |related |added |(?:${NUM}) )*tests?(?: (?:suite|suites|cases?|files?))?:?${AUX} (?:pass(?:es|ed|ing)?|succeed(?:ed|s)?|green)\\b`, "i"),
    scope: (s) => /\b(?:all|every|suite)\b/i.test(s) ? "all" : "some"
  },
  {
    id: "tests_and_they_pass",
    category: "test",
    re: /\btests?,? and (?:they|it|everything|all of them) (?:all |now |still |also )?pass(?:es|ed|ing)?\b/i,
    scope: (s) => /\b(?:everything|all of them)\b/i.test(s) ? "all" : "some"
  },
  {
    id: "passes_the_tests",
    category: "test",
    re: /\bpass(?:es|ed|ing)? (?:all|every|the|its|our|both|\d+)(?: (?:existing|new|unit|integration|e2e|\d+))? (?:tests?|checks?|specs?|test suite|suite|test cases?)\b/i,
    scope: (s) => /\b(?:all|every|suite)\b/i.test(s) ? "all" : "some"
  },
  {
    id: "n_passed",
    category: "test",
    re: new RegExp(`\\b([1-9](?:\\d{0,2}(?:,\\d{3})+|\\d*))(?:\\/(${NUM}))? (?:tests? |specs? |test cases? |checks? |examples? )?(?:passed|passing|pass|green)\\b`, "i"),
    scope: (s) => {
      const m = s.match(/^([\d,]+)\/([\d,]+)/);
      return m && m[1] === m[2] ? "all" : "some";
    }
  },
  {
    id: "green_tests",
    category: "test",
    re: /\b(?:tests?|specs?):?(?: (?:is|are|now|still|all|also|currently|again))* (?:green|all green|fully green)\b|\bgreen (?:test )?suite\b/i,
    scope: (s) => /\b(?:all|suite)\b/i.test(s) ? "all" : "some"
  },
  {
    id: "typecheck_pass",
    category: "typecheck",
    re: new RegExp(`\\b(?:type-?checks?(?:ing)?|type checks?(?:ing)?|tsc|vue-tsc|svelte-check|mypy|pyright|basedpyright|typescript(?: compiler| check)?|types|the types|type checker|cargo check|flow)(?: (?:--[\\w-]+|-\\w|-p [\\w./-]+))*:?${AUX} (?:pass(?:es|ed|ing)?|green|clean|succeed(?:s|ed)?|compiles?|check out|checks out|happy|ok|okay|fine|good)\\b`, "i"),
    scope: "all"
  },
  {
    id: "no_type_errors",
    category: "typecheck",
    re: /\b(?:no|zero|0|without) (?:type|typescript|tsc|mypy|pyright|typing|type-?check(?:ing)?|compiler|type-level) errors?\b|\btype-?checks? (?:cleanly|clean|without errors|with no errors|with zero errors)\b|\b(?:tsc|mypy|pyright|typecheck|type-?check|the type checker|typescript) (?:reports?|shows?|finds?|returns?|gives?|has|had|comes back with|with|at)? ?(?:no|zero|0) (?:errors?|issues?|problems?|complaints?)\b|\btypes (?:all )?check(?: out)?\b/i,
    scope: "all"
  },
  {
    id: "lint_pass",
    category: "lint",
    re: new RegExp(`\\b(?:lint(?:er|ing)?|linters|eslint|ruff|biome|flake8|pylint|clippy|golangci-lint|rubocop|oxlint|prettier|formatting|format check|stylelint|shellcheck|swiftlint|black|isort)(?: checks?| rules?| run)?(?: (?:--[\\w-]+|-\\w))*:?${AUX} (?:pass(?:es|ed|ing)?|green|clean|succeed(?:s|ed)?|happy|ok|okay|fine|good)\\b`, "i"),
    scope: "all"
  },
  {
    id: "no_lint_errors",
    category: "lint",
    re: /\b(?:no|zero|0|without) (?:lint(?:ing|er)?|eslint|ruff|clippy|rubocop|biome|formatting|prettier|style|flake8|pylint) (?:errors?|warnings?|issues?|problems?|violations?|offenses?|complaints?|findings?)\b|\blint(?:ing)?(?: is)? clean\b|\b(?:eslint|ruff|clippy|biome|rubocop|the linter|linting|lint) (?:reports?|shows?|finds?|returns?|gives?|has|had|comes back with|with|at)? ?(?:no|zero|0) (?:errors?|issues?|problems?|warnings?|complaints?|findings?)\b/i,
    scope: "all"
  },
  {
    id: "build_pass",
    category: "build",
    re: new RegExp(`\\b(?:(?:production|prod|release|docker|next|vite|cargo|go|swift|gradle|maven|xcode|dev|the|a|our|my) )?builds?(?: (?:step|command|process|pipeline|output))?:?${AUX} (?:succeed(?:s|ed)?|pass(?:es|ed|ing)?|green|clean|works|worked|complet(?:es|ed) successfully|finish(?:es|ed) successfully|successful|ok|okay|fine|good|happy)\\b|\\bbuil(?:d|t|ds) (?:cleanly|successfully|without (?:any )?errors|with no errors|with zero errors|fine|ok)\\b|\\bsuccessful build\\b|\\b(?:no|zero|0) build errors\\b`, "i"),
    scope: "all"
  },
  {
    id: "project_builds",
    category: "build",
    re: /(?<!\b(?:while|as|when|once|until|before|after|if) )\b(?:project|app|application|package|codebase|library|crate|module|binary|image|container|site|everything|it|code) (?:still |now |also |again )?builds\b(?! (?:on|upon|from|with|off|toward|towards|atop|against|over|onto|around|the|a|an|your|our|its|their|this|that|these|those|each|every|all|out|up|in|into|to|itself|them|us|you|me|new|one|two|three|several|multiple|many|some|most|any|no)\b)/i,
    scope: "all"
  },
  {
    id: "compiles_clean",
    category: "build",
    re: /\bcompil(?:es|ed|ing) (?:cleanly|clean|successfully|without (?:any )?errors|with no errors|with zero errors|fine|ok)\b|\bno compil(?:e|ation|er) errors\b|\bcompiled successfully\b|\bcompilation (?:succeeds|succeeded|passes|passed|is clean)\b/i,
    scope: "all",
    alternates: ["typecheck"],
    unless: ["typecheck"]
  }
];
var SUBJECT_WORDS = [
  [/^(?:the )?(?:tests?|test suite|suite|specs?|unit tests|integration tests|e2e tests)$/i, "test"],
  [/^(?:the )?(?:typecheck|type-?check|typechecking|type checking|tsc|mypy|pyright|types|typescript)$/i, "typecheck"],
  [/^(?:the )?(?:lint|linting|linter|eslint|ruff|clippy|biome|rubocop|prettier|formatting)$/i, "lint"],
  [/^(?:the )?(?:build|builds|compile|compilation|bundle)$/i, "build"]
];
var SUBJECT_ALT = "(?:the )?(?:tests?|test suite|suite|specs?|unit tests|integration tests|e2e tests|typecheck|type-?check|typechecking|type checking|tsc|mypy|pyright|types|typescript|lint|linting|linter|eslint|ruff|clippy|biome|rubocop|prettier|formatting|build|builds|compile|compilation|bundle)";
var COORDINATED_RE = new RegExp(`\\b(${SUBJECT_ALT}(?:, ${SUBJECT_ALT})*,? and ${SUBJECT_ALT})(?: (?:are|is|both|all|now|still|also))* (?:pass(?:es|ed|ing)?|green|clean|succeed(?:s|ed)?|ok|fine|happy)\\b`, "i");
function subjectCategory(word) {
  for (const [re, category] of SUBJECT_WORDS) if (re.test(word.trim())) return category;
  return null;
}
var CATEGORY_NOUN = { test: "tests", typecheck: "typecheck", lint: "lint", build: "build" };
var TOOL_HINT_RE = /\b(tsc|vue-tsc|mypy|pyright|eslint|ruff|biome|clippy|rubocop|oxlint|prettier|flake8|pylint|pytest|vitest|jest|mocha|playwright|cypress|cargo|go test|go vet|next build|vite build|webpack|tsup|phpunit|rspec|phpstan|golangci-lint|svelte-check)\b/i;
function toolHint(span) {
  const m = TOOL_HINT_RE.exec(span);
  return m ? m[1].toLowerCase() : void 0;
}
function stripCode(text) {
  let out = text.replace(FENCE_RE, " ");
  out = out.replace(INLINE_CODE_RE, (span) => {
    const inner = span.slice(1, -1).trim();
    if (inner.length > 0 && inner.length < 120 && !/[\n]/.test(inner)) {
      const d = detect(inner);
      if (d) return ` ${CATEGORY_NOUN[d.category]} `;
    }
    return " ` ";
  });
  out = out.replace(DOUBLE_QUOTE_RE, (_m, lead) => `${lead} " `);
  out = out.replace(SINGLE_QUOTE_RE, (_m, lead) => `${lead} ' `);
  return out.replace(/[ \t]+/g, " ");
}
function splitSentences(text) {
  return text.split(SENTENCE_SPLIT_RE).map((s) => s.trim()).filter((s) => s.length > 0);
}
function failureIsNegated(sentence) {
  FAILURE_RE.lastIndex = 0;
  let m;
  while ((m = FAILURE_RE.exec(sentence)) !== null) {
    const before = sentence.slice(0, m.index);
    const word = m[1];
    if (/^(?:not all|none of|no tests?|zero tests|error(?:s)? remain|still (?:erroring|red)|is red|are red)$/i.test(word)) return false;
    if (!FAILURE_NEGATOR_RE.test(before)) return false;
  }
  return true;
}
function numbersIn(span) {
  const m = span.match(/\b([1-9][\d,]*)(?:\/([\d,]+))?\b/);
  if (!m) return void 0;
  const counts = { passed: Number(m[1].replace(/,/g, "")) };
  if (m[2]) counts.total = Number(m[2].replace(/,/g, ""));
  return counts;
}
function extractClaims(text) {
  const claims = [];
  if (!text) return claims;
  const cleaned = stripCode(text);
  const paragraphs = cleaned.split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const paragraphQualified = QUALIFIER_RE.test(paragraph);
    for (const raw of splitSentences(paragraph)) {
      if (UNCHECKED_TODO_RE.test(raw)) continue;
      const sentence = raw.replace(LEADING_NOISE_RE, "").trim();
      if (!sentence) continue;
      if (sentence.includes("?")) continue;
      if (IMPERATIVE_RE.test(sentence)) continue;
      if (CONDITIONAL_RE.test(sentence)) continue;
      if (RELAYED_RE.test(sentence)) continue;
      if (MENTION_RE.test(sentence)) continue;
      if (!failureIsNegated(sentence)) continue;
      if (NEGATION_AFTER_RE.test(sentence)) continue;
      const operations = OPERATIONS_RE.test(sentence);
      const found = /* @__PURE__ */ new Map();
      const put = (claim) => {
        const existing = found.get(claim.category);
        if (!existing || existing.scope === "some" && claim.scope === "all") found.set(claim.category, claim);
      };
      const everything = sentence.match(EVERYTHING_RE);
      if (everything && !NEGATION_BEFORE_RE.test(sentence.slice(0, everything.index ?? 0)) && VERIFICATION_NOUN_RE.test(paragraph) && !operations) {
        for (const category of ["test", "typecheck", "lint", "build"]) {
          put({ category, text: everything[0], sentence, scope: "some", qualified: paragraphQualified, expanded: true });
        }
      }
      const coordinated = COORDINATED_RE.exec(sentence);
      if (coordinated && !NEGATION_BEFORE_RE.test(sentence.slice(0, coordinated.index))) {
        const subjects = coordinated[1].split(/,\s*|\s+and\s+/);
        for (const s of subjects) {
          const category = subjectCategory(s);
          if (!category) continue;
          const scope = category === "test" ? /\b(?:suite|all)\b/i.test(s) ? "all" : "some" : "all";
          put({ category, text: coordinated[0], sentence, scope, qualified: paragraphQualified });
        }
      }
      for (const p of PATTERNS) {
        if (p.unless && p.unless.some((c) => found.has(c))) continue;
        const m = p.re.exec(sentence);
        if (!m) continue;
        const span = m[0];
        const before = sentence.slice(0, m.index);
        if (NEGATION_BEFORE_RE.test(before)) continue;
        if (p.category === "test" && operations && !/\b(?:tests?|specs?|test cases?)\b/i.test(span)) continue;
        if (p.category === "test" && MANUAL_TEST_RE.test(`${before.trim().split(/\s+/).slice(-3).join(" ")} ${span}`.replace(/\s+/g, " "))) continue;
        const scope = typeof p.scope === "function" ? p.scope(span) : p.scope;
        const claim = { category: p.category, text: span, sentence, scope, qualified: paragraphQualified };
        const counts = p.category === "test" ? numbersIn(span) : void 0;
        if (counts) claim.counts = counts;
        if (p.alternates) claim.alternates = p.alternates;
        const tool = toolHint(span);
        if (tool) claim.tool = tool;
        put(claim);
      }
      for (const c of found.values()) claims.push(c);
    }
  }
  return claims;
}
function dedupeClaims(claims) {
  const byCategory = /* @__PURE__ */ new Map();
  for (const c of claims) {
    const prev = byCategory.get(c.category);
    if (!prev) {
      byCategory.set(c.category, c);
      continue;
    }
    if (prev.qualified && !c.qualified) byCategory.set(c.category, c);
    else if (prev.qualified === c.qualified && prev.scope === "some" && c.scope === "all") byCategory.set(c.category, c);
  }
  return [...byCategory.values()];
}

// src/core/fingerprint.ts
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync as readFileSync3, statSync as statSync2 } from "fs";
import { join as join3 } from "path";
function globToRegExp(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (/[.+^${}()|[\]\\]/.test(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}
function pathIgnorer(patterns = DEFAULT_FINGERPRINT_IGNORE) {
  const full = [];
  const base = [];
  for (const p of patterns) {
    if (!p) continue;
    if (p.includes("/")) full.push(globToRegExp(p.replace(/^\.\//, "")));
    else base.push(globToRegExp(p));
  }
  return (path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return base.some((r) => r.test(name)) || full.some((r) => r.test(path));
  };
}
function git(args, cwd, timeoutMs) {
  const r = spawnSync("git", args, { cwd, timeout: Math.max(10, timeoutMs), maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.error) return { ok: false, out: Buffer.alloc(0), error: r.error.code ?? r.error.message };
  if (r.status !== 0) return { ok: false, out: r.stdout ?? Buffer.alloc(0), error: `exit ${r.status}` };
  return { ok: true, out: r.stdout ?? Buffer.alloc(0) };
}
function blobId(file, size) {
  const content = readFileSync3(file);
  const h = createHash("sha1");
  h.update(`blob ${size}\0`);
  h.update(content);
  return h.digest("hex");
}
function computeFingerprint(cwd, opts = {}) {
  const start = Date.now();
  const budget = opts.budgetMs ?? 150;
  const ignore = pathIgnorer(opts.ignore ?? DEFAULT_FINGERPRINT_IGNORE);
  const maxFiles = opts.maxRehashFiles ?? 400;
  const maxBytes = opts.maxRehashBytes ?? 16 * 1024 * 1024;
  const elapsed = () => Date.now() - start;
  const left = () => budget - elapsed();
  const unavailable = (reason, head = null) => ({ head, tree: null, available: false, reason, ms: elapsed() });
  try {
    const top = git(["rev-parse", "--show-toplevel"], cwd, left());
    if (!top.ok) return unavailable(top.error === "ENOENT" ? "git-missing" : "not-git");
    const root = top.out.toString("utf8").trim();
    if (!root) return unavailable("not-git");
    const headRes = git(["rev-parse", "HEAD"], root, left());
    const head = headRes.ok ? headRes.out.toString("utf8").trim().slice(0, 12) || null : null;
    if (left() <= 0) return unavailable("budget", head);
    const ls = git(["ls-files", "-s", "-z"], root, left());
    if (!ls.ok) return unavailable(ls.error === "ETIMEDOUT" ? "budget" : "ls-files-failed", head);
    if (left() <= 0) return unavailable("budget", head);
    const entries = /* @__PURE__ */ new Map();
    const text = ls.out.toString("utf8");
    for (const rec of text.split("\0")) {
      if (!rec) continue;
      const tab = rec.indexOf("	");
      if (tab < 0) continue;
      const meta = rec.slice(0, tab).split(" ");
      const path = rec.slice(tab + 1);
      if (meta.length < 3 || ignore(path)) continue;
      entries.set(path, meta[1]);
    }
    const st = git(["status", "--porcelain=v1", "-z", "-uall", "--no-renames"], root, left());
    if (!st.ok) return unavailable(st.error === "ETIMEDOUT" ? "budget" : "status-failed", head);
    if (left() <= 0) return unavailable("budget", head);
    let rehashed = 0;
    let bytes = 0;
    const stText = st.out.toString("utf8");
    for (const rec of stText.split("\0")) {
      if (rec.length < 4) continue;
      const x = rec[0];
      const y = rec[1];
      const path = rec.slice(3);
      if (ignore(path)) continue;
      const worktreeChanged = y === "M" || y === "T" || y === "A" || x === "?" && y === "?";
      const worktreeDeleted = y === "D" || x === "D" && y === " ";
      if (worktreeDeleted) {
        entries.delete(path);
        continue;
      }
      if (!worktreeChanged) continue;
      const file = join3(root, path);
      let size;
      try {
        const info = statSync2(file);
        if (!info.isFile()) continue;
        size = info.size;
      } catch {
        entries.delete(path);
        continue;
      }
      rehashed++;
      bytes += size;
      if (rehashed > maxFiles || bytes > maxBytes) return unavailable("too-many-changes", head);
      if (left() <= 0) return unavailable("budget", head);
      try {
        entries.set(path, blobId(file, size));
      } catch {
        entries.delete(path);
      }
    }
    const h = createHash("sha256");
    for (const path of [...entries.keys()].sort()) {
      h.update(path);
      h.update("\0");
      h.update(entries.get(path));
      h.update("\n");
    }
    return { head, tree: h.digest("hex"), available: true, ms: elapsed() };
  } catch (err) {
    return unavailable(err instanceof Error ? err.message.slice(0, 80) : "error");
  }
}
function compareFingerprints(a, b) {
  if (!a || !b || !a.available || !b.available || !a.tree || !b.tree) return "unknown";
  return a.tree === b.tree ? "same" : "different";
}

// src/core/receipts.ts
import { existsSync as existsSync3, readFileSync as readFileSync4, statSync as statSync3, writeFileSync as writeFileSync2 } from "fs";
import { join as join4, resolve as resolve2 } from "path";
var MARKER_RE = /\[stalegreen\] exit=(-?\d+) receipt=([\w-]+)(?: lines=(\d+))?(?: log=(\S+))?/;
var MARKER_RE_ALL = new RegExp(MARKER_RE.source, "g");
function findMarkers(text) {
  const out = [];
  for (const m of text.matchAll(MARKER_RE_ALL)) out.push({ exit: Number(m[1]), id: m[2], log: m[4] ?? null });
  return out;
}
function runLogPath(root, id) {
  return join4(sessionDir(root), "runs", `${id}.log`);
}
function runExitPath(log) {
  return `${log}.exit`;
}
function readRunExit(log) {
  try {
    const text = readFileSync4(runExitPath(log), "utf8").trim();
    return /^-?\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}
function readReceipts(root) {
  return readJsonl(join4(sessionDir(root), "receipts.jsonl"));
}
function readEdits(root) {
  return readJsonl(join4(sessionDir(root), "edits.jsonl"));
}
function readPending(root) {
  return readJsonl(join4(sessionDir(root), "pending.jsonl"));
}
function readDeferred(root) {
  const all = readJsonl(join4(sessionDir(root), "deferred.jsonl"));
  const resolved = new Set(all.filter((d) => d.resolved).map((d) => d.id));
  return all.filter((d) => !d.resolved && !resolved.has(d.id));
}
function detectRuns(command, config, parsed) {
  const p = parsed ?? parseCommand(command);
  let found = detectAll(command, p);
  if (config.extraRunners.length > 0) {
    const taken = new Set(found.map((d) => d.segmentIndex));
    p.segments.forEach((seg, i) => {
      if (taken.has(i) || seg.words.length === 0) return;
      for (const extra of config.extraRunners) {
        let re;
        try {
          re = new RegExp(extra.match);
        } catch {
          continue;
        }
        if (!re.test(seg.head)) continue;
        found.push({ runner: extra.match, category: extra.category, scope: "all", segmentIndex: i, segment: seg, words: seg.words, cd: null, quiet: false, notRun: null, sudo: false, nested: false });
        break;
      }
    });
    found.sort((a, b) => a.segmentIndex - b.segmentIndex);
  }
  found = found.filter((d) => config.categories[d.category] !== false);
  if (config.ignoreCommands.length > 0) {
    found = found.filter((d) => !config.ignoreCommands.some((ig) => ig.length > 0 && (d.segment.head.includes(ig) || command.includes(ig))));
  }
  return found;
}
function countedMatches(output, parsed, pipelineEnd) {
  const last = parsed.segments[pipelineEnd];
  const words = stripGroupingWords(last.words);
  let label = "";
  if (words[0] === "xargs" && words[1] === "echo") label = words.slice(2).join(" ");
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${escaped}\\s*(\\d+)\\s*$`, "m");
  const m = re.exec(output);
  return m ? Number(m[1]) : null;
}
function countLines(text) {
  if (text.length === 0) return 0;
  const parts = text.split("\n");
  return text.endsWith("\n") ? parts.length - 1 : parts.length;
}
function truncateLog(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.2);
  const tail = max - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}
[stalegreen] log truncated: ${omitted} characters omitted
${text.slice(text.length - tail)}`;
}
function readLog(path, max) {
  try {
    if (!existsSync3(path)) return null;
    const size = statSync3(path).size;
    if (size > max * 4) return null;
    return readFileSync4(path, "utf8");
  } catch {
    return null;
  }
}
function extraVerdict(config, runner, output, exit) {
  const extra = config.extraRunners.find((e) => e.match === runner);
  if (!extra) return null;
  try {
    if (extra.fail && new RegExp(extra.fail, "m").test(output)) return { verdict: "fail", signal: "extra-fail" };
    if (extra.pass && exit === 0 && new RegExp(extra.pass, "m").test(output)) return { verdict: "pass", signal: "extra-pass" };
  } catch {
    return null;
  }
  return null;
}
function maskingFor(parsed, d) {
  const outer = analyzeMasking(parsed, d.segmentIndex);
  if (!d.inner) return outer;
  const innerParsed = parseCommand(d.inner.command);
  const inner = analyzeMasking(innerParsed, d.inner.index);
  return {
    masked: outer.masked || inner.masked,
    reasons: [...inner.reasons, ...outer.reasons],
    exitPreserved: outer.exitPreserved && inner.exitPreserved,
    outputVisible: outer.outputVisible && inner.outputVisible,
    tailLines: inner.tailLines ?? outer.tailLines,
    headLines: inner.headLines ?? outer.headLines,
    filtered: inner.filtered || outer.filtered,
    filterPatterns: [...inner.filterPatterns, ...outer.filterPatterns],
    countOnly: inner.countOnly || outer.countOnly,
    pipefail: inner.pipefail,
    background: outer.background || inner.background,
    pipelineEnd: outer.pipelineEnd
  };
}
var RUNNER_HEADERS = [
  [/^vitest$/, /^\s*RUN\s+v\d/],
  [/^pytest$/, /^=+ test session starts =+\s*$/],
  [/^jest$/, /^(?:PASS|FAIL) \S/],
  [/^next build$/, /^\s*▲ Next\.js/],
  [/^vite build$/, /^vite v\d/],
  [/^tsup$/, /^CLI Building entry/],
  [/^cargo /, /^\s+(?:Compiling|Checking|Finished|Running|Downloading|Updating)\b/],
  [/^go test$/, /^(?:ok|FAIL|\?)\s+\S+\s/],
  [/^playwright test$/, /^Running \d+ tests? using/],
  [/^mix test$/, /^Running ExUnit with seed/],
  [/^rspec$/, /^(?:Randomized with seed|Run options)/],
  [/^phpunit$/, /^PHPUnit \d/],
  [/^dotnet /, /^\s*Determining projects to restore/]
];
function literalEcho(seg) {
  const words = stripGroupingWords(seg.words);
  const w0 = words[0];
  if (w0 !== "echo" && w0 !== "printf") return null;
  const args = words.slice(1).filter((w) => !(w0 === "echo" && /^-[neE]+$/.test(w)));
  if (args.length === 0) return null;
  const text = w0 === "printf" ? args[0].replace(/\\n/g, "") : args.join(" ");
  if (/[$`]/.test(text) || text.trim().length < 3) return null;
  return text.trim();
}
var ERROR_PATTERN_RE = /error|✖|problem|fail|warning|Exception|panic|✘/i;
function scriptVia(output) {
  const m = /^>\s+(?!\S+@\S+\s)([a-z][\w./@-]*(?: [^\n]*)?)$/m.exec(output) ?? /^\$ ([a-z][\w./@-]*(?: [^\n]*)?)$/m.exec(output);
  return m ? m[1].trim().slice(0, 120) : void 0;
}
function recoverExitFromEcho(parsed, pipelineEnd, hasPipe, output) {
  for (let j = pipelineEnd + 1; j <= Math.min(pipelineEnd + 2, parsed.segments.length - 1); j++) {
    const seg = parsed.segments[j];
    if (j === pipelineEnd + 1 && seg.op !== ";" && seg.op !== "newline" && seg.op !== "&&") return null;
    const w0 = seg.words[0];
    if (w0 !== "echo" && w0 !== "printf") continue;
    const raw = seg.head;
    const pipeStatus = /\$\{?PIPESTATUS\[0\]\}?|\$pipestatus\[1\]/i.test(raw);
    const plain = /\$\?/.test(raw);
    if (!pipeStatus && !plain) continue;
    if (plain && !pipeStatus && hasPipe) return null;
    const text = seg.words.slice(1).filter((w) => !(w0 === "echo" && /^-[neE]+$/.test(w))).join(" ");
    const escaped = text.replace(/\$\{?PIPESTATUS\[0\]\}?|\$pipestatus\[1\]|\$\?/gi, "\0").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\0/g, "(-?\\d+)");
    if (!escaped.includes("(-?\\d+)")) continue;
    const m = new RegExp(`^${escaped.replace(/\\\\n/g, "")}\\s*$`, "m").exec(output);
    if (m) return Number(m[1]);
    return null;
  }
  return null;
}
function stripStatusEchoLines(output, parsed, pipelineEnd) {
  const patterns = [];
  for (let j = pipelineEnd + 1; j <= Math.min(pipelineEnd + 2, parsed.segments.length - 1); j++) {
    const seg = parsed.segments[j];
    const w0 = seg.words[0];
    if (w0 !== "echo" && w0 !== "printf") continue;
    if (!/\$[?{(]|\$[A-Za-z_]/.test(seg.head)) continue;
    const text = seg.words.slice(1).filter((w) => !(w0 === "echo" && /^-[neE]+$/.test(w))).join(" ");
    const escaped = text.replace(/\$\{[^}]*\}|\$\([^)]*\)|\$\??[A-Za-z_?]*/g, "\0").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\0/g, ".*");
    if (escaped.trim().length > 0) patterns.push(new RegExp(`^${escaped.replace(/\\\\n/g, "")}\\s*$`));
  }
  if (patterns.length === 0) return output;
  return output.split("\n").filter((line) => !patterns.some((p) => p.test(line))).join("\n");
}
function attributeOutput(parsed, detections, output) {
  const lines = output.split("\n");
  const pos = /* @__PURE__ */ new Map();
  let cursor = 0;
  const findLine = (test) => {
    for (let i = cursor; i < lines.length; i++) if (test(lines[i])) return i;
    return -1;
  };
  const byIndex = new Map(detections.map((d) => [d.segmentIndex, d]));
  parsed.segments.forEach((seg, i) => {
    const echo = literalEcho(seg);
    let found = -1;
    if (echo !== null) found = findLine((l) => l.trim() === echo);
    else {
      const d = byIndex.get(i);
      if (d) {
        const script = /^(?:npm run|npm|pnpm run|pnpm|yarn run|yarn|bun run) (\S+)$/.exec(d.runner)?.[1];
        if (script) found = findLine((l) => new RegExp(`^> \\S+@\\S+ ${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(l) || /^\$ /.test(l));
        if (found < 0) {
          const header = RUNNER_HEADERS.find(([r]) => r.test(d.runner))?.[1];
          if (header) found = findLine((l) => header.test(l));
        }
      }
    }
    if (found >= 0) {
      pos.set(i, found);
      cursor = found + 1;
    }
  });
  const out = /* @__PURE__ */ new Map();
  if (pos.size === 0) {
    for (const d of detections) out.set(d.segmentIndex, output);
    return out;
  }
  for (const d of detections) {
    const i = d.segmentIndex;
    let start = 0;
    for (const [j, p] of pos) {
      const from = j === i ? p : p + 1;
      if (j <= i && from >= start) start = from;
    }
    let end = lines.length;
    for (const [j, p] of pos) if (j > i && p < end) end = p;
    out.set(i, lines.slice(start, Math.max(start, end)).join("\n"));
  }
  return out;
}
function buildReceipts(input, ctx, pending, pendingAll = pending ? [pending] : []) {
  const now = ctx.now ?? (/* @__PURE__ */ new Date()).toISOString();
  const combined = `${input.stdout ?? ""}${input.stderr ? `
${input.stderr}` : ""}`;
  const markers = findMarkers(combined);
  const fingerprints = /* @__PURE__ */ new Map();
  const fingerprintFor = (cwd) => {
    let f = fingerprints.get(cwd);
    if (!f) {
      f = ctx.fingerprintFor ? ctx.fingerprintFor(cwd) : computeFingerprint(cwd, { budgetMs: ctx.config.fingerprintBudgetMs, ignore: ctx.config.fingerprintIgnore });
      fingerprints.set(cwd, f);
    }
    return f;
  };
  const base = (d, extra) => ({
    id: "r-?",
    ts: now,
    harness: ctx.harness,
    session: ctx.root,
    agent: ctx.agent,
    cwd: input.cwd,
    cmd: d ? d.segment.head : input.command,
    source: input.command,
    runner: d?.runner ?? "unknown",
    category: d?.category ?? "test",
    scope: d?.scope ?? "all",
    exit: null,
    verdict: "inconclusive",
    counts: {},
    signal: null,
    masked: false,
    wrapped: false,
    fingerprint: { head: null, tree: null, available: false, reason: "not-computed" },
    log: null,
    ...input.toolUseId ? { toolUseId: input.toolUseId } : {},
    ...input.background ? { background: true } : {},
    ...extra
  });
  if (markers.length > 0) {
    const out2 = [];
    const seen = /* @__PURE__ */ new Set();
    for (const marker of markers) {
      if (seen.has(marker.id)) continue;
      seen.add(marker.id);
      const p = pendingAll.find((x) => x.id === marker.id) ?? (pending?.id === marker.id ? pending : null);
      const logPath = p?.log ?? marker.log ?? runLogPath(ctx.root, marker.id);
      const exit = ctx.markerExits?.get(marker.id) ?? marker.exit;
      const output = readLog(logPath, ctx.config.maxLogBytes) ?? combined;
      const source = p?.command ?? input.command;
      const detections2 = detectRuns(source, ctx.config);
      const d = (p ? detections2.find((x) => x.notRun === null && x.runner === p.runner) : null) ?? detections2.find((x) => x.notRun === null) ?? detections2[0] ?? null;
      const cwd = resolve2(input.cwd, p?.cd ?? d?.cd ?? ".");
      const category = p?.category ?? d?.category ?? "test";
      const parsed = parseOutput(category, output, { exit, interrupted: input.interrupted });
      const extra = extraVerdict(ctx.config, p?.runner ?? d?.runner ?? "", output, exit);
      const runnerName = p?.runner ?? d?.runner ?? "unknown";
      const via = /^(?:npm|pnpm|yarn|bun) /.test(runnerName) ? scriptVia(output) : void 0;
      const started = input.background && p ? p.ts : null;
      const receipt = base(d, {
        id: marker.id,
        ...started ? { ts: started } : {},
        cwd,
        cmd: d?.segment.head ?? p?.command ?? input.command,
        source,
        runner: runnerName,
        ...via ? { via } : {},
        category,
        scope: p?.scope ?? d?.scope ?? "all",
        exit,
        verdict: extra?.verdict ?? parsed.verdict,
        counts: parsed.counts,
        signal: extra?.signal ?? parsed.signal,
        masked: false,
        wrapped: true,
        ...d?.quiet ? { quiet: true } : {},
        ...input.interrupted ? { interrupted: true } : {},
        fingerprint: started ? { head: null, tree: null, available: false, reason: "background" } : fingerprintFor(cwd),
        log: logPath
      });
      out2.push({ receipt, output });
    }
    return out2;
  }
  const parsedCommand = parseCommand(input.command);
  const detections = detectRuns(input.command, ctx.config, parsedCommand).filter((d) => d.notRun === null);
  if (detections.length === 0) return [];
  const exitKnown = input.exit !== null && input.exit !== void 0 || input.exitFailed === true;
  const failedExit = input.exitFailed === true && (input.exit === null || input.exit === void 0);
  const analyses = detections.map((d) => maskingFor(parsedCommand, d));
  const chunks = attributeOutput(parsedCommand, detections, combined);
  const preliminary = detections.map((d) => parseOutput(d.category, chunks.get(d.segmentIndex) ?? combined, { exit: null, interrupted: input.interrupted }));
  const anyFail = preliminary.some((r) => r.verdict === "fail");
  const out = [];
  detections.forEach((d, i) => {
    const analysis = analyses[i];
    if (analysis.background) return;
    let output = stripStatusEchoLines(chunks.get(d.segmentIndex) ?? combined, parsedCommand, analysis.pipelineEnd);
    let exit = null;
    let signalNote = null;
    let failedNoNumber = false;
    if (exitKnown && analysis.exitPreserved) {
      if (input.exit === 0) exit = 0;
      else if (detections.length === 1) exit = failedExit ? null : input.exit;
      else if (preliminary[i].verdict === "fail") exit = failedExit ? null : input.exit;
      else if (!anyFail && i === detections.length - 1) exit = failedExit ? null : input.exit;
      else signalNote = "compound-exit-unattributed";
      failedNoNumber = failedExit && signalNote === null && exit === null;
    }
    let recovered = null;
    if (exit === null && !d.nested) {
      recovered = recoverExitFromEcho(parsedCommand, analysis.pipelineEnd, analysis.pipelineEnd > d.segmentIndex, combined);
      if (recovered !== null) exit = recovered;
    }
    const redirectTarget = analysis.reasons.map((r) => r.startsWith("redirect:") ? r.slice(9) : null).find((r) => r !== null) ?? null;
    let readBack = false;
    if (redirectTarget) {
      for (let j = analysis.pipelineEnd + 1; j < parsedCommand.segments.length; j++) {
        const seg = parsedCommand.segments[j];
        const w0 = seg.words[0] ?? "";
        if ((w0 === "cat" || w0 === "tail" || w0 === "less" || w0 === "more") && seg.words.includes(redirectTarget)) {
          readBack = true;
          output = combined;
          break;
        }
      }
    }
    const lines = countLines(output);
    const complete = analysis.tailLines !== null && lines < analysis.tailLines || analysis.headLines !== null && lines < analysis.headLines;
    const shortTail = analysis.tailLines !== null && analysis.tailLines < 3 && !complete;
    const outputVisible = readBack || complete || analysis.outputVisible && !shortTail;
    const filtered = (analysis.filtered || shortTail) && !complete && !readBack;
    const parsed = parseOutput(d.category, output, { exit, interrupted: input.interrupted, outputVisible, filtered, ...failedNoNumber ? { failed: true } : {} });
    const extra = extraVerdict(ctx.config, d.runner, output, failedNoNumber ? 1 : exit);
    let verdict = extra?.verdict ?? parsed.verdict;
    let signal = extra?.signal ?? parsed.signal;
    const errorSearch = analysis.filterPatterns.length > 0 ? analysis.filterPatterns.every((p) => !p.startsWith("!") && ERROR_PATTERN_RE.test(p)) : analysis.countOnly && d.category !== "build";
    if (verdict === "inconclusive" && exit === null && filtered && d.category !== "test" && errorSearch) {
      if (analysis.countOnly) {
        const count = countedMatches(output, parsedCommand, analysis.pipelineEnd);
        if (count === 0) {
          verdict = "pass";
          signal = "count-zero";
        } else if (count !== null && count > 0) {
          verdict = "fail";
          signal = "count-nonzero";
        }
      } else if (isSilent(output)) {
        verdict = "pass";
        signal = "grep-empty";
      }
    }
    if (verdict === "inconclusive" && exit === null && (d.category === "typecheck" || d.category === "lint") && !hasFailSignal(d.category, combined)) {
      if (analysis.headLines !== null && analysis.headLines >= 3 && !analysis.filtered) {
        verdict = "pass";
        signal = "head-no-errors";
      } else if (analysis.filtered && errorSearch && !analysis.countOnly) {
        verdict = "pass";
        signal = "grep-no-errors";
      }
    }
    if (recovered !== null && verdict !== "inconclusive") signal = `${signal}+exit-from-echo`;
    if (signalNote && verdict === "inconclusive") signal = signalNote;
    const cwd = resolve2(input.cwd, d.cd ?? ".");
    const via = /^(?:npm|pnpm|yarn|bun) /.test(d.runner) ? scriptVia(output) : void 0;
    const receipt = base(d, {
      cwd,
      exit,
      verdict,
      counts: parsed.counts,
      signal,
      masked: analysis.masked,
      ...via ? { via } : {},
      ...analysis.reasons.length ? { maskReason: analysis.reasons.join(",") } : {},
      ...redirectTarget && verdict === "inconclusive" ? { logFile: resolve2(cwd, redirectTarget) } : {},
      wrapped: false,
      ...pending?.unwrapped ? { unwrapped: pending.unwrapped } : {},
      ...d.quiet ? { quiet: true } : {},
      ...input.interrupted ? { interrupted: true } : {},
      fingerprint: fingerprintFor(cwd)
    });
    out.push({ receipt, output });
  });
  return out;
}
var LOG_READERS = /* @__PURE__ */ new Set(["cat", "tail", "head", "less", "more", "grep", "egrep", "rg", "bat"]);
function resolveLogRead(input, ctx, receipts) {
  const parsed = parseCommand(input.command);
  const seg = parsed.segments.find((s) => s.words.length > 0);
  if (!seg || parsed.segments.filter((s) => s.words.length > 0).length !== 1) return null;
  const words = seg.words;
  const cmd = (words[0] ?? "").replace(/^.*\//, "");
  if (!LOG_READERS.has(cmd)) return null;
  const files = words.slice(1).filter((w) => !w.startsWith("-") && !/^\+?\d+$/.test(w));
  const target = cmd === "grep" || cmd === "egrep" || cmd === "rg" ? files[files.length - 1] : files[0];
  if (!target) return null;
  const abs = resolve2(input.cwd, target);
  const candidates = receipts.filter((r) => r.verdict === "inconclusive" && r.logFile !== void 0 && r.logFile === abs);
  const original = candidates[candidates.length - 1];
  if (!original) return null;
  const output = `${input.stdout ?? ""}${input.stderr ? `
${input.stderr}` : ""}`;
  const lines = countLines(output);
  let n = null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const m = /^-n(\d+)$/.exec(w) ?? /^-(\d+)$/.exec(w) ?? /^--lines=(\d+)$/.exec(w);
    if (m) n = Number(m[1]);
    else if ((w === "-n" || w === "--lines") && words[i + 1]) n = Number(words[i + 1]) || null;
  }
  const complete = (cmd === "head" || cmd === "tail") && n !== null ? lines < n : cmd === "cat" || cmd === "less" || cmd === "more" || cmd === "bat";
  const outputVisible = complete || cmd === "cat" || cmd === "tail" || cmd === "less" || cmd === "more" || cmd === "bat";
  const filtered = cmd === "grep" || cmd === "egrep" || cmd === "rg" || cmd === "head" && !complete;
  const parsedOut = parseOutput(original.category, output, { exit: null, outputVisible, filtered });
  if (parsedOut.verdict === "inconclusive") return null;
  return {
    ...original,
    id: "r-?",
    ts: ctx.now ?? (/* @__PURE__ */ new Date()).toISOString(),
    source: input.command,
    verdict: parsedOut.verdict,
    counts: parsedOut.counts,
    signal: `log-read:${parsedOut.signal ?? "?"}`,
    maskReason: `${original.maskReason ?? "redirect"},read`,
    ...input.toolUseId ? { toolUseId: input.toolUseId } : {}
  };
}
function trustMarkers(input, root, pendingAll, existing) {
  const exits = /* @__PURE__ */ new Map();
  const drop = /* @__PURE__ */ new Set();
  for (const m of findMarkers(`${input.stdout ?? ""}
${input.stderr ?? ""}`)) {
    if (exits.has(m.id) || drop.has(m.id)) continue;
    const p = pendingAll.find((x) => x.id === m.id);
    const exit = p && !existing.has(m.id) ? readRunExit(p.log ?? runLogPath(root, m.id)) : null;
    if (exit === null) drop.add(m.id);
    else exits.set(m.id, exit);
  }
  if (drop.size === 0) return { input, exits };
  const strip = (text) => text.split("\n").filter((line) => {
    const m = MARKER_RE.exec(line);
    return !(m && drop.has(m[2]));
  }).join("\n");
  return { input: { ...input, stdout: strip(input.stdout ?? ""), stderr: strip(input.stderr ?? "") }, exits };
}
function recordRun(rawInput, ctx) {
  const dir = sessionDir(ctx.root);
  ensureDir(dir);
  const pendingAll = readPending(ctx.root);
  const existing = new Set(readReceipts(ctx.root).map((r) => r.id));
  const { input, exits } = trustMarkers(rawInput, ctx.root, pendingAll, existing);
  const combined = `${input.stdout ?? ""}
${input.stderr ?? ""}`;
  const markers = findMarkers(combined);
  const marker = markers[0] ?? null;
  let pending = null;
  if (marker) pending = pendingAll.find((p) => p.id === marker.id) ?? null;
  else if (input.toolUseId) pending = pendingAll.filter((p) => p.toolUseId === input.toolUseId).pop() ?? null;
  else pending = pendingAll.filter((p) => p.command === input.command && !p.wrappedCommand).pop() ?? null;
  const built = buildReceipts(input, { ...ctx, markerExits: exits }, pending, pendingAll);
  const receipts = [];
  built.forEach((b, i) => {
    const r = b.receipt;
    if (r.id === "r-?") r.id = i === 0 && pending && !marker && !existing.has(pending.id) ? pending.id : nextReceiptId(dir);
    if (existing.has(r.id)) return;
    existing.add(r.id);
    if (!r.log) {
      const logPath = runLogPath(ctx.root, r.id);
      try {
        ensureDir(join4(dir, "runs"));
        writeFileSync2(logPath, truncateLog(b.output, ctx.config.maxLogBytes));
        r.log = logPath;
      } catch {
        r.log = null;
      }
    }
    appendJsonl(join4(dir, "receipts.jsonl"), r);
    receipts.push(r);
  });
  return receipts;
}
function describeCounts(counts) {
  const parts = [];
  if (counts.failed !== void 0 && counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.errors !== void 0 && counts.errors > 0) parts.push(`${counts.errors} error${counts.errors === 1 ? "" : "s"}`);
  if (counts.passed !== void 0) parts.push(`${counts.passed} passed`);
  if (parts.length === 0 && counts.errors === 0) parts.push("0 errors");
  return parts.join(", ");
}

// src/core/freshness.ts
function latestFirst(items) {
  return items.map((item, index) => ({ item, index })).sort((a, b) => a.item.ts < b.item.ts ? 1 : a.item.ts > b.item.ts ? -1 : b.index - a.index).map((x) => x.item);
}
function evidenceOf(r) {
  return { receipt: r.id, cmd: r.cmd, runner: r.runner, verdict: r.verdict, counts: r.counts, ts: r.ts, cwd: r.cwd, scope: r.scope, masked: r.masked };
}
function selectReceipt(claim, receipts) {
  const categories = /* @__PURE__ */ new Set([claim.category, ...claim.alternates ?? []]);
  let candidates = latestFirst(receipts.filter((r) => categories.has(r.category)));
  if (claim.tool) {
    const named = candidates.filter((r) => `${r.runner} ${r.cmd} ${r.via ?? ""}`.toLowerCase().includes(claim.tool));
    if (named.length > 0) candidates = named;
  }
  if (candidates.length === 0) return { receipt: null };
  const latest = candidates[0];
  if (claim.scope === "some") return { receipt: latest };
  const latestAll = candidates.find((r) => r.scope === "all") ?? null;
  if (!latestAll) return { receipt: null, note: `latest run ${latest.id} (\`${latest.cmd}\`) covers a subset, not the whole suite` };
  if (latest !== latestAll && latest.verdict === "fail") return { receipt: latest };
  return { receipt: latestAll };
}
var CODE_EXT_RE = /\.(?:py|pyi|ts|tsx|mts|cts|js|jsx|mjs|cjs|go|rs|java|kt|kts|swift|rb|php|c|cc|cpp|h|hpp|cs|vue|svelte|sql|prisma|json|toml|yaml|yml|ini|cfg|sh|bash|zsh|css|scss|less|html|env|lock|graphql|gql|proto|ex|exs|dart|scala|elm|hs|zig|lua|pl|pm|r|m|mm|gradle|xml|tf|ipynb|erb|hbs|ejs|njk|astro|mdx|cmake|mk|nix|wxs|csproj|sln|fs|fsx|clj|cljs|edn|jl|nim|v|sv|vhd|mod|sum|txt\.in)$/i;
var CODE_BARE_RE = /^(?:Makefile|GNUmakefile|Dockerfile|Rakefile|Gemfile|Justfile|Procfile|Brewfile|Podfile|Vagrantfile|Jenkinsfile|Earthfile|BUILD|WORKSPACE|Pipfile|Cargo|Containerfile|\.env|\.envrc|\.gitmodules|\.npmrc|\.nvmrc|\.node-version|\.python-version|\.ruby-version|\.tool-versions|\.babelrc|\.eslintrc|\.prettierrc|\.editorconfig|\.flake8|\.pylintrc|\.mocharc|\.swcrc)$/;
function affectsVerification(path, ignore, cwd) {
  if (path === null) return true;
  const normalized = path.replace(/\\/g, "/");
  const name = normalized.split("/").pop() ?? normalized;
  if (ignore(name) || ignore(normalized)) return false;
  if (/\.(?:out|log|txt|tmp|bak|orig|rej|swp|pid|cache|snap)$/i.test(name)) return false;
  if (normalized.startsWith("/dev/")) return false;
  const insideProject = cwd !== void 0 && cwd.length > 1 && normalized.startsWith(cwd.replace(/\\/g, "/").replace(/\/+$/, "") + "/");
  if (!insideProject && (/^\/(?:tmp|private\/tmp|private\/var|var\/folders|var\/tmp)\//.test(normalized) || /\/\.claude\/|\/scratchpad\//.test(normalized))) return false;
  if (CODE_BARE_RE.test(name)) return true;
  if (name.startsWith(".") && /^\.[^.]+\.(?:json|js|cjs|mjs|ts|yml|yaml|toml)$/.test(name)) return true;
  return CODE_EXT_RE.test(name);
}
function editsAfter(r, edits, config, cwd) {
  const ignore = pathIgnorer(config.fingerprintIgnore);
  return edits.filter((e) => e.ts > r.ts && affectsVerification(e.path, ignore, cwd)).sort((a, b) => a.ts < b.ts ? -1 : 1);
}
function evaluate(input) {
  const out = [];
  const ttlMs = input.config.deferredTtlMinutes * 6e4;
  const nowMs = Date.parse(input.now);
  const ignoreForEdits = pathIgnorer(input.config.fingerprintIgnore);
  const lastEditTs = input.edits.filter((e) => affectsVerification(e.path, ignoreForEdits, input.cwd)).reduce((acc, e) => e.ts > acc ? e.ts : acc, "");
  const verifiedSinceEdit = lastEditTs !== "" && input.receipts.some((r) => r.ts > lastEditTs);
  for (const claim of input.claims) {
    const header = { category: claim.category, text: claim.text, scope: claim.scope, qualified: claim.qualified };
    const decide = (kind, evidence2, freshness, note2) => {
      const blocking = kind === "STALE" || kind === "FAILED" || kind === "MASKED" || kind === "NONE" && input.config.strictNoEvidence && !evidence2;
      let action = "allowed";
      let finalNote = note2;
      if (blocking) {
        if (claim.qualified) finalNote = [finalNote, "qualified claim, reported only"].filter(Boolean).join("; ");
        else if (input.config.policy === "advisory") action = "advisory";
        else if (input.blockedThisTurn.has(claim.category)) finalNote = [finalNote, "allowed_after_block"].filter(Boolean).join("; ");
        else action = "blocked";
      }
      const v = { claim: header, evidence: evidence2, freshness, verdict: kind, action };
      if (finalNote) v.note = finalNote;
      return v;
    };
    const noFreshness = { fingerprintMatch: null, editsAfter: [] };
    const pendingDeferred = input.deferred.find((d) => d.category === claim.category && nowMs - Date.parse(d.ts) < ttlMs);
    if (pendingDeferred) {
      out.push(decide("DEFERRED", null, noFreshness, `background run ${pendingDeferred.id} (\`${pendingDeferred.cmd}\`) has not reported yet`));
      continue;
    }
    const { receipt: r, note } = selectReceipt(claim, input.receipts);
    if (!r) {
      out.push(decide("NONE", null, noFreshness, note ?? "no verification run recorded in this session"));
      continue;
    }
    if (claim.expanded && verifiedSinceEdit && r.ts <= lastEditTs) {
      out.push(decide("NONE", evidenceOf(r), noFreshness, `not part of the checks run since the last edit (latest ${claim.category} run ${r.id} predates it)`));
      continue;
    }
    const evidence = evidenceOf(r);
    let countsNote;
    if (claim.counts?.passed !== void 0 && r.counts.passed !== void 0 && claim.counts.passed !== r.counts.passed) {
      countsNote = `counts_match: false (claim says ${claim.counts.passed}, run reported ${r.counts.passed})`;
    }
    if (r.verdict === "fail") {
      const newerSubsets = input.receipts.filter((x) => x.category === r.category && x.ts > r.ts && x.scope === "subset" && x.verdict === "pass").length;
      const subsetNote = newerSubsets > 0 ? `${newerSubsets} later subset run${newerSubsets === 1 ? "" : "s"} passed but did not cover the whole suite` : void 0;
      out.push(decide("FAILED", evidence, noFreshness, [countsNote, subsetNote].filter(Boolean).join("; ") || void 0));
      continue;
    }
    if (r.verdict === "inconclusive") {
      if (r.masked) out.push(decide("MASKED", evidence, noFreshness, r.maskReason ? `masked by ${r.maskReason}` : "result not recorded"));
      else out.push(decide("NONE", evidence, noFreshness, `latest run ${r.id} is inconclusive (${r.signal ?? "no signal"})`));
      continue;
    }
    const now = input.fingerprintFor(r.cwd);
    const cmp = compareFingerprints(r.fingerprint, now);
    const later = editsAfter(r, input.edits, input.config, input.cwd);
    if (cmp === "different") {
      out.push(decide("STALE", evidence, { fingerprintMatch: false, editsAfter: later }, countsNote));
      continue;
    }
    if (cmp === "same") {
      out.push(decide("FRESH", evidence, { fingerprintMatch: true, editsAfter: [] }, countsNote));
      continue;
    }
    if (later.length > 0) {
      out.push(decide("STALE", evidence, { fingerprintMatch: null, editsAfter: later }, countsNote));
      continue;
    }
    out.push(decide("FRESH", evidence, { fingerprintMatch: null, editsAfter: [] }, countsNote));
  }
  return out;
}
function clock(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function shortPath(path, cwd) {
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}
var CATEGORY_WORD = { test: "the tests", typecheck: "the typecheck", lint: "the linter", build: "the build" };
function receiptLabel(v, cwd) {
  const e = v.evidence;
  if (!e) return "";
  const counts = describeCounts(e.counts);
  const where = e.cwd && e.cwd !== cwd ? ` in ${shortPath(e.cwd, cwd)}` : "";
  const parts = [`\`${e.cmd}\``, e.runner !== "unknown" && !e.cmd.includes(e.runner) ? e.runner : null, counts || null, clock(e.ts)].filter(Boolean);
  return `Receipt ${e.receipt} (${parts.join(", ")})${where}`;
}
function formatBlockMessage(verdicts, cwd) {
  const blocks = [];
  for (const v of verdicts) {
    const claim = `"${v.claim.text}"`;
    const cmd = v.evidence?.cmd;
    const rerun = cmd ? `Rerun \`${cmd}\`` : `Run ${CATEGORY_WORD[v.claim.category]}`;
    if (v.verdict === "STALE") {
      const edits = v.freshness.editsAfter;
      const shown = edits.slice(0, 6).map((e) => `${e.path ? shortPath(e.path, cwd) : e.kind} (${clock(e.ts)})`);
      const more = edits.length > 6 ? `, and ${edits.length - 6} more` : "";
      const lines = [`stalegreen: ${claim} is stale. ${receiptLabel(v, cwd)} predates ${edits.length > 0 ? `${edits.length} later edit${edits.length === 1 ? "" : "s"}:` : "later changes to the working tree."}`];
      if (shown.length > 0) lines.push(`  ${shown.join(", ")}${more}`);
      lines.push(`${rerun} and report the result, or state explicitly that ${CATEGORY_WORD[v.claim.category].replace("the ", "the ")} were not rerun after these edits.`);
      blocks.push(lines.join("\n"));
    } else if (v.verdict === "FAILED") {
      const e = v.evidence;
      const exit = e && typeof e.exit === "number" ? "" : "";
      blocks.push(
        [
          `stalegreen: ${claim} does not match the latest run. ${receiptLabel(v, cwd)} failed${exit}.`,
          `Fix the failure and ${rerun.charAt(0).toLowerCase() + rerun.slice(1)}, or report the failure instead of a pass.`
        ].join("\n")
      );
    } else if (v.verdict === "MASKED") {
      const reason = v.note?.replace(/^masked by /, "") ?? "a pipe";
      blocks.push(
        [
          `stalegreen: ${claim} has no recorded result. ${receiptLabel(v, cwd)} was run with ${describeMask(reason)}, so the exit status and summary were not recorded.`,
          `${rerun.replace(/^Rerun `(.*)`$/, "Run `$1`")} without the pipe or suffix so the result is recorded, then report it.`
        ].join("\n")
      );
    } else if (v.verdict === "NONE") {
      blocks.push(`stalegreen: ${claim} has no verification run in this session${v.note ? ` (${v.note})` : ""}. ${rerun} and report the result.`);
    }
  }
  return blocks.join("\n\n");
}
function describeMask(reason) {
  const parts = reason.split(",").map((r) => r.trim());
  const words = parts.map((p) => {
    if (p.startsWith("pipe:")) return `a pipe into ${p.slice(5)}`;
    if (p === "or-chain") return "an `||` suffix";
    if (p === "semicolon") return "a `;` chain";
    if (p.startsWith("devnull")) return "output sent to /dev/null";
    if (p.startsWith("redirect:")) return `output redirected to ${p.slice(9)}`;
    if (p === "negated") return "a leading `!`";
    return p;
  });
  return words.join(" and ");
}

// src/harness/hooks.ts
function str(v) {
  return typeof v === "string" ? v : null;
}
function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function turnStatePath(dir, agent) {
  return join5(dir, agent ? `turn-${agent.replace(/[^A-Za-z0-9._-]/g, "_")}.json` : "turn.json");
}
function runHook(adapter, event, raw) {
  const input = obj(raw);
  const cwd = str(input.cwd) ?? process.cwd();
  const config = loadConfig(cwd);
  const session = deriveSession(input);
  const dir = sessionDir(session.root);
  const ctx = { adapter, input, cwd, config, root: session.root, agent: session.agent, dir };
  switch (event) {
    case "PreToolUse":
      return preToolUse(ctx);
    case "PostToolUse":
      return postToolUse(ctx);
    case "Stop":
    case "SubagentStop":
      return stop(ctx, event);
    default:
      return { exit: 0 };
  }
}
function preToolUse({ adapter, input, cwd, config, root, agent, dir }) {
  const toolName = str(input.tool_name);
  if (toolName !== "Bash" && toolName !== "bash") return { exit: 0 };
  const toolInput = obj(input.tool_input);
  const command = str(toolInput.command);
  if (!command) return { exit: 0 };
  const parsed = parseCommand(command);
  const detections = detectRuns(command, config, parsed).filter((d) => d.notRun === null);
  if (detections.length === 0) return { exit: 0 };
  ensureDir(dir);
  const ts = nowIso();
  const background = toolInput.run_in_background === true;
  const record = (d, id, wrappedCommand, unwrapped, log) => {
    const p = { id, ts, toolUseId: str(input.tool_use_id), command, wrappedCommand, cwd, runner: d.runner, category: d.category, scope: d.scope, cd: d.cd, background, agent, log };
    if (unwrapped) p.unwrapped = unwrapped;
    appendJsonl(join5(dir, "pending.jsonl"), p);
    return p;
  };
  if (config.mode === "off" || background) {
    record(detections[0], nextReceiptId(dir), null, config.mode === "off" ? "mode-off" : "background", null);
    return { exit: 0 };
  }
  const targets = detections.map((d) => {
    const id = nextReceiptId(dir);
    return { detection: d, id, log: runLogPath(root, id) };
  });
  const plan = planRewrite(command, targets, config, parsed);
  const deny = (reason) => ({ exit: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) });
  if (!plan.command) {
    record(detections[0], targets[0].id, null, plan.reason, null);
    if (config.mode === "strict") {
      const analysis = analyzeMasking(parsed, detections[0].segmentIndex);
      if (analysis.masked && !analysis.exitPreserved) {
        return deny(`stalegreen: \`${detections[0].segment.head}\` is piped or chained so its result would not be recorded, and it cannot be wrapped (${plan.reason}). Run it without the pipe or suffix so the result is recorded.`);
      }
    }
    return { exit: 0 };
  }
  const decision = adapter.allowDecision(input, config, { command, targets, parsed, cwd });
  if (adapter.rewriteNeedsAllow && !decision.allow) {
    record(detections[0], targets[0].id, null, "no-allow", null);
    if (config.mode === "strict") {
      const analysis = analyzeMasking(parsed, detections[0].segmentIndex);
      if (analysis.masked && !analysis.exitPreserved) {
        return deny(`stalegreen: \`${detections[0].segment.head}\` is piped or chained so its result would not be recorded. Run it without the pipe or suffix so the result is recorded.`);
      }
    }
    return { exit: 0 };
  }
  for (const t of targets) record(t.detection, t.id, plan.command, null, t.log);
  const hookSpecificOutput = { hookEventName: "PreToolUse", updatedInput: { ...toolInput, command: plan.command } };
  if (decision.allow) {
    hookSpecificOutput.permissionDecision = "allow";
    hookSpecificOutput.permissionDecisionReason = decision.reason;
  }
  return { exit: 0, stdout: JSON.stringify({ hookSpecificOutput }) };
}
function postToolUse(ctx) {
  const { adapter, input, cwd, config, root, agent, dir } = ctx;
  const toolName = str(input.tool_name) ?? "";
  const toolInput = obj(input.tool_input);
  const ts = nowIso();
  const receiptCtx = { harness: adapter.harness, root, agent, config, now: ts };
  const run = adapter.shellRun(input);
  if (run) {
    const combined = `${run.stdout}
${run.stderr}`;
    const detections = detectRuns(run.command, config).filter((d) => d.notRun === null);
    const hasMarker = MARKER_RE.test(combined);
    if (run.background && detections.length > 0 && !hasMarker) {
      for (const d of detections) {
        const rec = { id: nextReceiptId(dir), ts, category: d.category, runner: d.runner, cmd: d.segment.head, command: run.command, cwd };
        if (run.cellId) rec.cellId = run.cellId;
        appendJsonl(join5(dir, "deferred.jsonl"), rec);
      }
    } else if (detections.length > 0 || hasMarker) {
      recordRun({ command: run.command, stdout: run.stdout, stderr: run.stderr, exit: run.exit, exitFailed: run.exitFailed, interrupted: run.interrupted, cwd, toolUseId: str(input.tool_use_id) }, receiptCtx);
    } else {
      const read = resolveLogRead({ command: run.command, stdout: run.stdout, stderr: run.stderr, exit: run.exit, interrupted: run.interrupted, cwd, toolUseId: str(input.tool_use_id) }, receiptCtx, readReceipts(root));
      if (read) {
        read.id = nextReceiptId(dir);
        appendJsonl(join5(dir, "receipts.jsonl"), read);
      }
    }
    for (const e of editsFromBash(run.command, combined)) appendJsonl(join5(dir, "edits.jsonl"), toEditEvent(e, ts, agent));
    return { exit: 0 };
  }
  const deferredOut = adapter.deferredOutput(input);
  if (deferredOut) {
    resolveDeferred(ctx, deferredOut, ts);
    return { exit: 0 };
  }
  for (const edit of adapter.editsFromTool(toolName, toolInput)) appendJsonl(join5(dir, "edits.jsonl"), toEditEvent(edit, ts, agent));
  return { exit: 0 };
}
function resolveDeferred({ adapter, input, cwd, config, root, agent, dir }, out, ts) {
  const text = out.text;
  if (!text && out.state === null) return;
  const pending = readDeferred(root).filter((d) => !("resolved" in d));
  const matching = out.cellId ? pending.filter((d) => d.cellId === out.cellId) : pending;
  if (matching.length === 0) return;
  const receiptCtx = { harness: adapter.harness, root, agent, config, now: ts };
  if (out.state !== null || MARKER_RE.test(text)) {
    const command = matching[0].command ?? matching[0].cmd;
    const exitFailed = out.state === "failed" && out.exit === null;
    recordRun({ command, stdout: text, stderr: "", exit: out.exit ?? (out.state === "completed" ? 0 : null), exitFailed, interrupted: false, background: true, cwd: matching[0].cwd ?? cwd, toolUseId: str(input.tool_use_id) }, receiptCtx);
    for (const d of matching) appendJsonl(join5(dir, "deferred.jsonl"), { ...d, ts, resolved: true });
    return;
  }
  for (const d of matching) {
    const parsed = parseOutput(d.category, text, { exit: null });
    if (parsed.verdict !== "fail") continue;
    const fingerprint = computeFingerprint(cwd, { budgetMs: config.fingerprintBudgetMs, ignore: config.fingerprintIgnore });
    const receipt = {
      id: d.id,
      ts,
      harness: adapter.harness,
      session: root,
      agent,
      cwd,
      cmd: d.cmd,
      source: d.command ?? d.cmd,
      runner: d.runner,
      category: d.category,
      scope: "all",
      exit: null,
      verdict: "fail",
      counts: parsed.counts,
      signal: parsed.signal,
      masked: false,
      wrapped: false,
      background: true,
      fingerprint,
      log: null
    };
    appendJsonl(join5(dir, "receipts.jsonl"), receipt);
    appendJsonl(join5(dir, "deferred.jsonl"), { ...d, ts, resolved: true });
  }
}
function stop({ adapter, input, cwd, config, root, agent, dir }, event) {
  const text = str(input.last_assistant_message);
  if (!text) return { exit: 0 };
  const claims = dedupeClaims(extractClaims(text));
  if (claims.length === 0) return { exit: 0 };
  const now = nowIso();
  const promptId = adapter.turnId(input);
  const stopHookActive = input.stop_hook_active === true;
  const statePath = turnStatePath(dir, agent);
  const state = readJsonFile(statePath);
  const sameTurn = state !== null && (promptId ? state.promptId === promptId : stopHookActive);
  const blockedThisTurn = new Set(sameTurn ? state.blocked : []);
  const cache = /* @__PURE__ */ new Map();
  const fingerprintFor = (c) => {
    let f = cache.get(c);
    if (!f) {
      f = computeFingerprint(c, { budgetMs: config.fingerprintBudgetMs, ignore: config.fingerprintIgnore });
      cache.set(c, f);
    }
    return f;
  };
  const verdicts = evaluate({
    claims,
    receipts: readReceipts(root),
    edits: readEdits(root),
    deferred: readDeferred(root),
    now,
    cwd,
    config,
    fingerprintFor,
    blockedThisTurn
  });
  const blocked = verdicts.filter((v) => v.action === "blocked");
  const message = blocked.length > 0 ? formatBlockMessage(blocked, cwd) : void 0;
  const record = { ts: now, root, agent, promptId, event, verdicts, blocked: blocked.length > 0 };
  if (message) record.message = message;
  appendJsonl(join5(dir, "verdicts.jsonl"), record);
  if (blocked.length > 0) {
    const categories = /* @__PURE__ */ new Set([...blockedThisTurn, ...blocked.map((v) => v.claim.category)]);
    writeJsonFile(statePath, { promptId, blocked: [...categories], ts: now });
    return adapter.block(message ?? "");
  }
  if (!sameTurn) writeJsonFile(statePath, { promptId, blocked: [], ts: now });
  return { exit: 0 };
}

// src/harness/claude/permissions.ts
import { execFileSync } from "child_process";
import { existsSync as existsSync4, readFileSync as readFileSync5 } from "fs";
import { homedir as homedir2, platform } from "os";
import { join as join6 } from "path";
var WRAPPERS = /* @__PURE__ */ new Set(["timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin", "noglob"]);
var SAFE_ENV = /^(?:CI|NODE_ENV|FORCE_COLOR|NO_COLOR|TERM|LANG|LC_ALL|TZ|DEBUG|RUST_BACKTRACE|PYTHONPATH|NODE_OPTIONS|PORT|HOME|PATH)=/;
function readRules(file) {
  try {
    if (!existsSync4(file)) return null;
    const json = JSON.parse(readFileSync5(file, "utf8"));
    const p = json.permissions ?? {};
    const list = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    return { allow: list(p.allow), deny: list(p.deny), ask: list(p.ask) };
  } catch {
    return null;
  }
}
function gitRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 100, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
function loadPermissionRules(cwd, env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim() ? env.CLAUDE_CONFIG_DIR : join6(homedir2(), ".claude");
  const project = env.CLAUDE_PROJECT_DIR && env.CLAUDE_PROJECT_DIR.trim() ? env.CLAUDE_PROJECT_DIR : cwd;
  const files = [
    platform() === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json",
    join6(configDir, "settings.json"),
    join6(project, ".claude", "settings.json"),
    join6(gitRoot(project) ?? project, ".claude", "settings.local.json")
  ];
  const merged = { allow: [], deny: [], ask: [] };
  for (const f of files) {
    const r = readRules(f);
    if (!r) continue;
    merged.allow.push(...r.allow);
    merged.deny.push(...r.deny);
    merged.ask.push(...r.ask);
  }
  return merged;
}
function bashRuleMatcher(rule) {
  const trimmed = rule.trim();
  if (trimmed === "Bash" || trimmed === "Bash(*)") return () => true;
  const m = /^Bash\((.*)\)$/s.exec(trimmed);
  if (!m) return null;
  let pattern = m[1];
  if (pattern.endsWith(":*")) pattern = `${pattern.slice(0, -2)} *`;
  const stars = (pattern.match(/\*/g) ?? []).length;
  const trailingOnly = stars === 1 && pattern.endsWith(" *");
  const escaped = pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  const full = new RegExp(`^${escaped}$`, "s");
  const bare = trailingOnly ? new RegExp(`^${pattern.slice(0, -2).replace(/[.+?^${}()|[\]\\]/g, "\\$&")}$`, "s") : null;
  return (cmd) => full.test(cmd) || bare !== null && bare.test(cmd);
}
function normalize(words) {
  let w = [...words];
  let guard = 0;
  while (w.length > 0 && guard++ < 8) {
    const first = w[0];
    if (SAFE_ENV.test(first)) {
      w = w.slice(1);
      continue;
    }
    if (WRAPPERS.has(first)) {
      if (first === "timeout") {
        let i = 1;
        while (i < w.length && w[i].startsWith("-")) i += w[i] === "-s" || w[i] === "-k" ? 2 : 1;
        w = w.slice(i + 1);
      } else w = w.slice(1);
      continue;
    }
    break;
  }
  return w;
}
var READ_ONLY = /* @__PURE__ */ new Set(["ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "echo", "printf", "pwd", "which", "type", "true", "false", "sort", "uniq", "cut", "tr", "less", "more", "file", "stat", "du", "df", "env", "printenv", "date", "whoami", "uname", "basename", "dirname", "realpath", "readlink", "test", "[", "column", "nl", "jq"]);
var READ_ONLY_GIT = /* @__PURE__ */ new Set(["status", "log", "diff", "show", "branch", "rev-parse", "remote", "tag", "describe", "blame", "shortlog", "ls-files"]);
function isReadOnlySegment(words) {
  const w0 = words[0] ?? "";
  if (w0 === "cd") {
    const target = words[1] ?? "";
    return words.length === 2 && target.length > 0 && !/^(?:\/|\.\.|~|-)/.test(target);
  }
  if (w0 === "git") return words.length >= 2 && READ_ONLY_GIT.has(words[1]) && !words.some((w) => w === "-c" || w.startsWith("--output"));
  if (!READ_ONLY.has(w0)) return false;
  return !words.some((w) => w.includes("*") || w.includes("?") || w.startsWith("--exec") || w === "-exec" || w === "-delete");
}
function commandAllowedByRules(command, rules) {
  const parsed = parseCommand(command);
  if (!parsed.confident || parsed.segments.length === 0) return false;
  const allow = rules.allow.map(bashRuleMatcher).filter((f) => f !== null);
  const denyOrAsk = [...rules.deny, ...rules.ask].map(bashRuleMatcher).filter((f) => f !== null);
  if (allow.length === 0) return false;
  for (const seg of parsed.segments) {
    if (seg.env.some((e) => !SAFE_ENV.test(e))) return false;
    const words = normalize(seg.words);
    if (words.length === 0) return false;
    const text = seg.head.trim();
    const candidates = /* @__PURE__ */ new Set([text, words.join(" ")]);
    const env = seg.env.filter((e) => SAFE_ENV.test(e));
    if (env.length > 0) candidates.add(seg.head.trim().slice(env.join(" ").length).trim());
    for (const c of candidates) if (denyOrAsk.some((f) => f(c))) return false;
    if (isReadOnlySegment(words) && seg.redirects.length === 0) continue;
    if (![...candidates].some((c) => allow.some((f) => f(c)))) return false;
  }
  return true;
}

// src/harness/claude/hooks.ts
var claudeAdapter = {
  harness: "claude",
  rewriteNeedsAllow: false,
  turnId: (input) => str(input.prompt_id),
  allowDecision(input, config, { command, targets, parsed, cwd }) {
    const mode = str(input.permission_mode) ?? "default";
    if (mode === "bypassPermissions" || mode === "auto" || mode === "plan") return { allow: false, reason: "" };
    const head = targets[0]?.detection.segment.head ?? command;
    if (config.permission === "allow") return { allow: true, reason: `stalegreen: \`${head}\` is a verification run; wrapped so its result is recorded` };
    if (config.permission === "inherit" && commandAllowedByRules(unfilteredCommand(command, targets, parsed), loadPermissionRules(cwd))) {
      return { allow: true, reason: `stalegreen: \`${head}\` is allowed by your permission rules; wrapped so its result is recorded` };
    }
    return { allow: false, reason: "" };
  },
  shellRun(input) {
    if (str(input.tool_name) !== "Bash") return null;
    const toolInput = obj(input.tool_input);
    const command = str(toolInput.command);
    if (!command) return null;
    const response = input.tool_response;
    const r = obj(response);
    const stdout = str(r.stdout) ?? (typeof response === "string" ? response : "");
    const stderr = str(r.stderr) ?? "";
    const exit = typeof r.exit_code === "number" ? r.exit_code : typeof r.exitCode === "number" ? r.exitCode : null;
    return { command, stdout, stderr, exit, exitFailed: false, interrupted: r.interrupted === true, background: toolInput.run_in_background === true, cellId: typeof r.backgroundTaskId === "string" ? r.backgroundTaskId : null };
  },
  deferredOutput(input) {
    const toolName = str(input.tool_name);
    if (toolName !== "TaskOutput" && toolName !== "BashOutput") return null;
    const r = obj(input.tool_response);
    const text = [str(r.stdout), str(r.output), str(r.stderr), typeof input.tool_response === "string" ? input.tool_response : null].filter((s) => !!s).join("\n");
    return { text, state: null, exit: null, cellId: null };
  },
  editsFromTool(toolName, toolInput) {
    const e = editFromTool(toolName, toolInput);
    return e ? [e] : [];
  },
  block(message) {
    return { exit: 2, stderr: message };
  }
};
function runClaudeHook(event, raw) {
  return runHook(claudeAdapter, event, raw);
}

// src/harness/codex/output.ts
var HEADER_RE = /^\s*(Script completed|Script failed|Script running with cell ID (\d+)|Script terminated|aborted by user)\b[^\n]*/i;
var EXIT_RE = /(?:exit(?:ed)? (?:with )?(?:code|status)|exit code|Process exited with code)[:=]?\s*(-?\d+)/i;
var WALL_RE = /^\s*Wall time ([\d.]+) seconds?\s*$/i;
function parseCodexExecOutput(text) {
  const lines = text.split("\n");
  const m = HEADER_RE.exec(lines[0] ?? "");
  if (!m) return { state: "unknown", cellId: null, wallSeconds: null, output: text, exit: null, exitFailed: false };
  const head = m[1].toLowerCase();
  let state = "unknown";
  if (head.startsWith("script completed")) state = "completed";
  else if (head.startsWith("script failed")) state = "failed";
  else if (head.startsWith("script running")) state = "running";
  else if (head.startsWith("script terminated")) state = "terminated";
  else if (head.startsWith("aborted")) state = "aborted";
  let i = 1;
  let wallSeconds = null;
  const wall = WALL_RE.exec(lines[i] ?? "");
  if (wall) {
    wallSeconds = Number(wall[1]);
    i++;
  }
  if (/^\s*Output:\s*$/.test(lines[i] ?? "")) i++;
  const output = lines.slice(i).join("\n");
  let exit = state === "completed" ? 0 : null;
  const exitMatch = EXIT_RE.exec(lines.slice(0, i).join("\n"));
  if (exitMatch) exit = Number(exitMatch[1]);
  return { state, cellId: m[2] ?? null, wallSeconds, output, exit, exitFailed: state === "failed" && exit === null };
}
var PATCH_LINE_RE = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+?)\s*$/gm;
function applyPatchEdits(patch) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const m of patch.matchAll(PATCH_LINE_RE)) {
    const path = m[2].trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, kind: "apply_patch" });
  }
  return out;
}

// src/harness/codex/hooks.ts
function responseText(response) {
  if (typeof response === "string") return response;
  const r = obj(response);
  const direct = str(r.output) ?? str(r.stdout);
  if (direct !== null) return `${direct}${str(r.stderr) ? `
${str(r.stderr)}` : ""}`;
  if (Array.isArray(response)) return response.map((b) => b && typeof b === "object" && typeof b.text === "string" ? b.text : "").join("");
  return "";
}
var codexAdapter = {
  harness: "codex",
  rewriteNeedsAllow: true,
  turnId: (input) => str(input.turn_id),
  allowDecision(input, config, { command, targets }) {
    if (config.permission === "ask") return { allow: false, reason: "" };
    if ((str(input.permission_mode) ?? "default") === "plan") return { allow: false, reason: "" };
    const head = targets[0]?.detection.segment.head ?? command;
    return { allow: true, reason: `stalegreen: \`${head}\` is a verification run; wrapped so its result is recorded` };
  },
  shellRun(input) {
    if (str(input.tool_name) !== "Bash") return null;
    const toolInput = obj(input.tool_input);
    const command = str(toolInput.command);
    if (!command) return null;
    const response = input.tool_response;
    const r = obj(response);
    const parsed = parseCodexExecOutput(responseText(response));
    const exit = typeof r.exit_code === "number" ? r.exit_code : typeof r.exitCode === "number" ? r.exitCode : parsed.exit;
    return {
      command,
      stdout: parsed.output,
      stderr: "",
      exit,
      exitFailed: exit === null && parsed.exitFailed,
      interrupted: parsed.state === "aborted" || r.interrupted === true,
      background: parsed.state === "running",
      cellId: parsed.cellId
    };
  },
  deferredOutput(input) {
    const toolName = str(input.tool_name);
    if (toolName !== "wait" && toolName !== "TaskOutput" && toolName !== "BashOutput") return null;
    const toolInput = obj(input.tool_input);
    const parsed = parseCodexExecOutput(responseText(input.tool_response));
    const cellId = parsed.cellId ?? (typeof toolInput.cell_id === "number" || typeof toolInput.cell_id === "string" ? String(toolInput.cell_id) : null);
    const state = parsed.state === "completed" ? "completed" : parsed.state === "failed" ? "failed" : null;
    if (parsed.state === "running") return { text: "", state: null, exit: null, cellId };
    return { text: parsed.output, state, exit: parsed.exit, cellId };
  },
  editsFromTool(toolName, toolInput) {
    const input = obj(toolInput);
    if (toolName === "apply_patch" || typeof input.command === "string" && /^\*\*\* Begin Patch/.test(input.command)) {
      return applyPatchEdits(str(input.command) ?? "");
    }
    const e = editFromTool(toolName, toolInput);
    return e ? [e] : [];
  },
  block(message) {
    return { exit: 0, stdout: JSON.stringify({ decision: "block", reason: message }) };
  }
};
function runCodexHook(event, raw) {
  return runHook(codexAdapter, event, raw);
}

// src/harness/dsh/hooks.ts
var EXIT_MARKER_RE = /\[exit code: (-?\d+)\]\s*$/;
var SAVED_OUTPUT_RE = /(?:full output (?:was )?saved to|saved to file):?\s+(\S+)/i;
var FILE_TOOLS = /* @__PURE__ */ new Set(["edit", "write", "str_replace_editor", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
function splitDshOutput(text) {
  const m = EXIT_MARKER_RE.exec(text);
  const output = m ? text.slice(0, m.index).replace(/\s+$/, "") : text;
  const saved = SAVED_OUTPUT_RE.exec(text);
  return { output, exit: m ? Number(m[1]) : null, savedTo: saved ? saved[1] : null };
}
var dshAdapter = {
  harness: "dsh",
  rewriteNeedsAllow: true,
  turnId: (input) => input.turn === void 0 || input.turn === null ? null : String(input.turn),
  allowDecision: () => ({ allow: false, reason: "" }),
  shellRun(input) {
    const toolName = str(input.tool_name);
    if (toolName !== "bash" && toolName !== "Bash") return null;
    const toolInput = obj(input.tool_input);
    const command = str(toolInput.command);
    if (!command) return null;
    const text = typeof input.tool_response === "string" ? input.tool_response : str(obj(input.tool_response).text) ?? "";
    const { output, exit } = splitDshOutput(text);
    const background = toolInput.run_in_background === true;
    const known = exit !== null ? exit : input.is_error === true ? null : 0;
    return { command, stdout: output, stderr: "", exit: known, exitFailed: false, interrupted: false, background, cellId: null };
  },
  deferredOutput(input) {
    const toolName = str(input.tool_name);
    if (toolName !== "job_output") return null;
    const text = typeof input.tool_response === "string" ? input.tool_response : "";
    const { output, exit } = splitDshOutput(text);
    return { text: output, state: exit === null ? null : exit === 0 ? "completed" : "failed", exit, cellId: null };
  },
  editsFromTool(toolName, toolInput) {
    if (!FILE_TOOLS.has(toolName)) return [];
    const input = obj(toolInput);
    if (toolName === "str_replace_editor" && str(input.command) === "view") return [];
    const path = str(input.path) ?? str(input.file_path) ?? null;
    if (path) return [{ path, kind: toolName }];
    const e = editFromTool(toolName, toolInput);
    return e ? [e] : [];
  },
  block(message) {
    return { exit: 2, stderr: message };
  }
};
function runDshHook(event, raw) {
  return runHook(dshAdapter, event, raw);
}

// src/hook.ts
try {
  const enable = nodeModule.enableCompileCache;
  if (typeof enable === "function") enable();
} catch {
}
var STDIN_TIMEOUT_MS = 3e3;
function readStdin() {
  return new Promise((resolve3) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve3(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.resume();
  });
}
function emit(outcome) {
  if (outcome.stdout) writeSync(1, outcome.stdout);
  if (outcome.stderr) writeSync(2, outcome.stderr.endsWith("\n") ? outcome.stderr : `${outcome.stderr}
`);
  process.exit(outcome.exit);
}
async function main() {
  const harness = process.argv[2] ?? "";
  const event = process.argv[3] ?? "";
  let payload = null;
  try {
    const text = await readStdin();
    payload = text.trim() ? JSON.parse(text) : null;
  } catch (err) {
    recordError(`${harness}:${event}:stdin`, err);
    emit({ exit: 0 });
  }
  if (payload === null) emit({ exit: 0 });
  try {
    if (harness === "claude") emit(runClaudeHook(event, payload));
    if (harness === "codex") emit(runCodexHook(event, payload));
    if (harness === "dsh") emit(runDshHook(event, payload));
    emit({ exit: 0 });
  } catch (err) {
    recordError(`${harness}:${event}`, err);
    emit({ exit: 0 });
  }
}
void main();
//# sourceMappingURL=hook.js.map