/**
 * `stalegreen redact`: a shareable copy of one session's store for bug
 * reports. Paths are shortened to what the gate needed (the file name and
 * where it sits in the repository), secrets in commands and output are
 * masked, and the agent's prose is dropped in favour of the matched claim.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute } from "node:path";
import type { EditEvent, Receipt, Verdict } from "../core/grammar.js";
import { readDeferred, readEdits, readPending, readReceipts, readVerdicts, runLogPath, type VerdictRecord } from "../core/receipts.js";
import { VERSION } from "../version.js";

export interface RedactedSession {
  stalegreen: string;
  harness: string | null;
  session: string;
  cwd: string;
  receipts: Record<string, unknown>[];
  edits: { ts: string; path: string | null; kind: string; agent?: string }[];
  verdicts: Record<string, unknown>[];
  pending: Record<string, unknown>[];
  deferred: Record<string, unknown>[];
  logs: Record<string, string[]>;
  note: string;
}

const SECRET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|PWD|AUTH|COOKIE|CREDENTIAL|PRIVATE|DSN|API)[A-Za-z0-9_]*$/i;
const ENV_ASSIGN_RE = /\b([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g;
const FLAG_SECRET_RE = /(--?(?:token|password|passwd|secret|api[-_]?key|auth|key)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi;
const BEARER_RE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const URL_USERINFO_RE = /(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g;
const LONG_RANDOM_RE = /\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g;
const KNOWN_TOKEN_RE = /\b(?:ghp_|gho_|ghs_|github_pat_|sk-|sk_live_|sk_test_|xox[abp]-|AKIA|npm_)[A-Za-z0-9_-]{6,}/g;

/** Masks secrets in a piece of text: env values, token flags, bearer headers, URL credentials, long random strings. */
export function redactSecrets(text: string): string {
  return text
    .replace(ENV_ASSIGN_RE, (m, key: string, value: string) => (SECRET_KEY_RE.test(key) ? `${key}=<redacted>` : `${key}=${value}`))
    .replace(FLAG_SECRET_RE, (_m, flag: string) => `${flag}<redacted>`)
    .replace(BEARER_RE, (_m, scheme: string) => `${scheme} <redacted>`)
    .replace(URL_USERINFO_RE, "$1<redacted>@")
    .replace(KNOWN_TOKEN_RE, "<redacted>")
    .replace(LONG_RANDOM_RE, (m) => (/^[0-9a-f]{40}$/i.test(m) ? m : "<redacted>"));
}

export interface PathContext {
  home: string;
  repos: string[];
}

/** Shortens absolute paths: inside a repository to `<repo>/...`, under the home directory to `~/...`, elsewhere to `<path>/<name>`. */
export function redactPaths(text: string, ctx: PathContext): string {
  // Windows paths are reported with forward slashes so a report reads the same everywhere.
  const slash = (s: string) => (process.platform === "win32" ? s.replace(/\\/g, "/") : s);
  const repos = [...ctx.repos].filter(Boolean).map(slash).sort((a, b) => b.length - a.length);
  let out = slash(text);
  for (const repo of repos) {
    out = out.split(repo).join("<repo>");
  }
  if (ctx.home) out = out.split(slash(ctx.home)).join("~");
  return out.replace(/(?<![\w<>~.])\/(?:[\w.@%+-]+\/){1,}[\w.@%+-]+/g, (m) => {
    if (m.startsWith("/dev/") || m.startsWith("/usr/") || m.startsWith("/bin/") || m.startsWith("/opt/homebrew/bin/")) return m;
    return `<path>/${basename(m)}`;
  });
}

function redactAll(text: string, ctx: PathContext): string {
  return redactSecrets(redactPaths(text, ctx));
}

function shortPath(path: string | null, ctx: PathContext): string | null {
  if (!path) return path;
  return redactPaths(path, ctx);
}

function redactReceipt(r: Receipt, ctx: PathContext): Record<string, unknown> {
  return {
    id: r.id,
    ts: r.ts,
    harness: r.harness,
    agent: r.agent ? "agent" : null,
    cwd: shortPath(r.cwd, ctx),
    cmd: redactAll(r.cmd, ctx),
    source: redactAll(r.source, ctx),
    runner: r.runner,
    ...(r.via ? { via: redactAll(r.via, ctx) } : {}),
    category: r.category,
    scope: r.scope,
    exit: r.exit,
    verdict: r.verdict,
    counts: r.counts,
    signal: r.signal,
    masked: r.masked,
    ...(r.maskReason ? { maskReason: redactAll(r.maskReason, ctx) } : {}),
    wrapped: r.wrapped,
    ...(r.unwrapped ? { unwrapped: r.unwrapped } : {}),
    ...(r.quiet ? { quiet: true } : {}),
    ...(r.background ? { background: true } : {}),
    ...(r.interrupted ? { interrupted: true } : {}),
    fingerprint: { available: r.fingerprint.available, ...(r.fingerprint.reason ? { reason: r.fingerprint.reason } : {}), ...(r.fingerprint.ms !== undefined ? { ms: r.fingerprint.ms } : {}) },
    log: r.log ? true : false,
    ...(r.logFile ? { logFile: shortPath(r.logFile, ctx) } : {}),
  };
}

function redactVerdict(v: Verdict, ctx: PathContext): Record<string, unknown> {
  return {
    claim: { category: v.claim.category, text: v.claim.text, scope: v.claim.scope, qualified: v.claim.qualified },
    evidence: v.evidence
      ? { receipt: v.evidence.receipt, cmd: redactAll(v.evidence.cmd, ctx), runner: v.evidence.runner, verdict: v.evidence.verdict, counts: v.evidence.counts, ts: v.evidence.ts, cwd: shortPath(v.evidence.cwd, ctx), scope: v.evidence.scope, masked: v.evidence.masked }
      : null,
    freshness: { fingerprintMatch: v.freshness.fingerprintMatch, editsAfter: v.freshness.editsAfter.map((e) => ({ ts: e.ts, path: shortPath(e.path, ctx), kind: e.kind })) },
    verdict: v.verdict,
    action: v.action,
    ...(v.note ? { note: v.note } : {}),
  };
}

function redactRecord(rec: VerdictRecord, ctx: PathContext): Record<string, unknown> {
  return {
    ts: rec.ts,
    agent: rec.agent ? "agent" : null,
    promptId: rec.promptId ? "turn" : null,
    event: rec.event,
    blocked: rec.blocked,
    verdicts: rec.verdicts.map((v) => redactVerdict(v, ctx)),
    ...(rec.message ? { message: redactAll(rec.message, ctx) } : {}),
  };
}

export interface RedactOptions {
  logs?: boolean;
  logLines?: number;
  home?: string;
}

/** Builds the shareable copy of a session. Pure apart from reading the store. */
export function redactSession(root: string, opts: RedactOptions = {}): RedactedSession {
  const home = opts.home ?? homedir();
  const receipts = readReceipts(root);
  const edits = readEdits(root);
  const verdicts = readVerdicts(root);
  const pending = readPending(root);
  const deferred = readDeferred(root);
  const repos = [...new Set(receipts.map((r) => r.cwd).concat(pending.map((p) => p.cwd)))].filter((c) => c && isAbsolute(c));
  const ctx: PathContext = { home, repos };
  const logs: Record<string, string[]> = {};
  if (opts.logs !== false) {
    const n = opts.logLines ?? 40;
    for (const r of receipts) {
      const file = r.log ?? runLogPath(root, r.id);
      if (!existsSync(file)) continue;
      try {
        const lines = readFileSync(file, "utf8").split("\n");
        logs[r.id] = lines.slice(-n).map((l) => redactAll(l, ctx));
      } catch {
        // unreadable log
      }
    }
  }
  const cwd = repos[0] ?? "";
  return {
    stalegreen: VERSION,
    harness: receipts[0]?.harness ?? null,
    session: root.length > 8 ? `${root.slice(0, 8)}...` : root,
    cwd: cwd ? `<repo> (${basename(cwd)})` : "",
    receipts: receipts.map((r) => redactReceipt(r, ctx)),
    edits: edits.map((e: EditEvent) => ({ ts: e.ts, path: shortPath(e.path, ctx), kind: e.kind, ...(e.agent ? { agent: "agent" } : {}) })),
    verdicts: verdicts.map((rec) => redactRecord(rec, ctx)),
    pending: pending.map((p) => ({ id: p.id, ts: p.ts, command: redactAll(p.command, ctx), wrapped: !!p.wrappedCommand, ...(p.unwrapped ? { unwrapped: p.unwrapped } : {}), runner: p.runner, category: p.category, scope: p.scope, background: p.background })),
    deferred: deferred.map((d) => ({ id: d.id, ts: d.ts, category: d.category, runner: d.runner, cmd: redactAll(d.cmd, ctx), ...("resolved" in d ? { resolved: true } : {}) })),
    logs,
    note: "Produced by `stalegreen redact`. Paths are shortened, secrets masked and the agent's prose replaced by the matched claim. Review before sharing.",
  };
}
