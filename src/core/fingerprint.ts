/**
 * Working-tree fingerprint.
 *
 * The fingerprint is a hash of the content of every tracked and untracked
 * file in the repository, taken from the index for unchanged files and from
 * disk for modified or untracked ones. It changes when any file content
 * changes and stays the same across `git add` and `git commit`, so committing
 * never turns fresh evidence stale. Documentation and other non-code paths
 * are excluded through the ignore list.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_FINGERPRINT_IGNORE } from "./config.js";
import type { Fingerprint } from "./grammar.js";

export interface FingerprintOptions {
  budgetMs?: number;
  ignore?: string[];
  maxRehashFiles?: number;
  maxRehashBytes?: number;
}

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
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

/** Builds a matcher for repo-relative paths from glob patterns. Patterns without `/` match the basename. */
export function pathIgnorer(patterns: string[] = DEFAULT_FINGERPRINT_IGNORE): (path: string) => boolean {
  const full: RegExp[] = [];
  const base: RegExp[] = [];
  for (const p of patterns) {
    if (!p) continue;
    if (p.includes("/")) full.push(globToRegExp(p.replace(/^\.\//, "")));
    else base.push(globToRegExp(p));
  }
  return (path: string) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return base.some((r) => r.test(name)) || full.some((r) => r.test(path));
  };
}

function git(args: string[], cwd: string, timeoutMs: number): { ok: boolean; out: Buffer; error?: string } {
  const r = spawnSync("git", args, { cwd, timeout: Math.max(10, timeoutMs), maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.error) return { ok: false, out: Buffer.alloc(0), error: (r.error as NodeJS.ErrnoException).code ?? r.error.message };
  if (r.status !== 0) return { ok: false, out: r.stdout ?? Buffer.alloc(0), error: `exit ${r.status}` };
  return { ok: true, out: r.stdout ?? Buffer.alloc(0) };
}

/** Git's blob id for a file, so that a freshly staged file hashes the same as its index entry. */
function blobId(file: string, size: number): string {
  const content = readFileSync(file);
  const h = createHash("sha1");
  h.update(`blob ${size}\0`);
  h.update(content);
  return h.digest("hex");
}

/** Computes the fingerprint for the repository containing `cwd`. Never throws. */
export function computeFingerprint(cwd: string, opts: FingerprintOptions = {}): Fingerprint {
  const start = Date.now();
  const budget = opts.budgetMs ?? 150;
  const ignore = pathIgnorer(opts.ignore ?? DEFAULT_FINGERPRINT_IGNORE);
  const maxFiles = opts.maxRehashFiles ?? 400;
  const maxBytes = opts.maxRehashBytes ?? 16 * 1024 * 1024;
  const elapsed = () => Date.now() - start;
  const left = () => budget - elapsed();
  const unavailable = (reason: string, head: string | null = null): Fingerprint => ({ head, tree: null, available: false, reason, ms: elapsed() });

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

    const entries = new Map<string, string>();
    const text = ls.out.toString("utf8");
    for (const rec of text.split("\0")) {
      if (!rec) continue;
      // "<mode> <sha> <stage>\t<path>"
      const tab = rec.indexOf("\t");
      if (tab < 0) continue;
      const meta = rec.slice(0, tab).split(" ");
      const path = rec.slice(tab + 1);
      if (meta.length < 3 || ignore(path)) continue;
      // The blob id alone: a file staged later hashes to the same id from the index.
      entries.set(path, meta[1] as string);
    }

    const st = git(["status", "--porcelain=v1", "-z", "-uall", "--no-renames"], root, left());
    if (!st.ok) return unavailable(st.error === "ETIMEDOUT" ? "budget" : "status-failed", head);
    if (left() <= 0) return unavailable("budget", head);

    let rehashed = 0;
    let bytes = 0;
    const stText = st.out.toString("utf8");
    for (const rec of stText.split("\0")) {
      if (rec.length < 4) continue;
      const x = rec[0] as string;
      const y = rec[1] as string;
      const path = rec.slice(3);
      if (ignore(path)) continue;
      const worktreeChanged = y === "M" || y === "T" || y === "A" || (x === "?" && y === "?");
      const worktreeDeleted = y === "D" || (x === "D" && y === " ");
      if (worktreeDeleted) {
        entries.delete(path);
        continue;
      }
      if (!worktreeChanged) continue;
      const file = join(root, path);
      let size: number;
      try {
        const info = statSync(file);
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
      h.update(entries.get(path) as string);
      h.update("\n");
    }
    return { head, tree: h.digest("hex"), available: true, ms: elapsed() };
  } catch (err) {
    return unavailable(err instanceof Error ? err.message.slice(0, 80) : "error");
  }
}

/** Compares two fingerprints. `unknown` when either side is unavailable. */
export function compareFingerprints(a: Fingerprint | undefined, b: Fingerprint | undefined): "same" | "different" | "unknown" {
  if (!a || !b || !a.available || !b.available || !a.tree || !b.tree) return "unknown";
  return a.tree === b.tree ? "same" : "different";
}
