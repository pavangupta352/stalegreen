import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareFingerprints, computeFingerprint, pathIgnorer } from "../src/core/fingerprint.js";
import { makeRepo, type TempRepo } from "./helpers.js";

let repo: TempRepo;
const GENEROUS = { budgetMs: 5000 };
beforeEach(() => {
  repo = makeRepo();
});
afterEach(() => {
  repo.cleanup();
});

describe("computeFingerprint", () => {
  it("is stable across calls and changes after any content edit", () => {
    const a = computeFingerprint(repo.dir, GENEROUS);
    const b = computeFingerprint(repo.dir, GENEROUS);
    expect(a.available).toBe(true);
    expect(compareFingerprints(a, b)).toBe("same");
    writeFileSync(repo.file, "export const remaining = 0;\n");
    expect(compareFingerprints(a, computeFingerprint(repo.dir, GENEROUS))).toBe("different");
  });

  it("changes for untracked files and deletions", () => {
    const a = computeFingerprint(repo.dir, GENEROUS);
    writeFileSync(join(repo.dir, "new.ts"), "export const x = 1;\n");
    const b = computeFingerprint(repo.dir, GENEROUS);
    expect(compareFingerprints(a, b)).toBe("different");
    rmSync(join(repo.dir, "new.ts"));
    expect(compareFingerprints(a, computeFingerprint(repo.dir, GENEROUS))).toBe("same");
    rmSync(repo.file);
    expect(compareFingerprints(a, computeFingerprint(repo.dir, GENEROUS))).toBe("different");
  });

  it("does not change on git add or git commit", () => {
    writeFileSync(repo.file, "export const remaining = 0;\n");
    mkdirSync(join(repo.dir, "src"));
    writeFileSync(join(repo.dir, "src", "a.ts"), "export const a = 1;\n");
    const dirty = computeFingerprint(repo.dir, GENEROUS);
    execFileSync("git", ["add", "-A"], { cwd: repo.dir });
    expect(compareFingerprints(dirty, computeFingerprint(repo.dir, GENEROUS))).toBe("same");
    execFileSync("git", ["commit", "-q", "-m", "change"], { cwd: repo.dir });
    const committed = computeFingerprint(repo.dir, GENEROUS);
    expect(compareFingerprints(dirty, committed)).toBe("same");
    expect(committed.head).not.toBe(dirty.head);
  });

  it("ignores documentation and other listed paths", () => {
    const a = computeFingerprint(repo.dir, GENEROUS);
    writeFileSync(join(repo.dir, "README.md"), "# changed\n");
    writeFileSync(join(repo.dir, "notes.txt"), "scratch\n");
    mkdirSync(join(repo.dir, "docs"));
    writeFileSync(join(repo.dir, "docs", "guide.html"), "<p>hi</p>\n");
    expect(compareFingerprints(a, computeFingerprint(repo.dir, GENEROUS))).toBe("same");
    expect(compareFingerprints(a, computeFingerprint(repo.dir, { ...GENEROUS, ignore: [] }))).toBe("different");
  });

  it("works from a subdirectory of the repository", () => {
    mkdirSync(join(repo.dir, "packages", "api"), { recursive: true });
    writeFileSync(join(repo.dir, "packages", "api", "index.ts"), "export {};\n");
    const a = computeFingerprint(join(repo.dir, "packages", "api"), GENEROUS);
    const b = computeFingerprint(repo.dir, GENEROUS);
    expect(a.available && b.available).toBe(true);
    expect(compareFingerprints(a, b)).toBe("same");
  });

  it("is marked unavailable outside a repository and when the budget is exceeded", () => {
    const plain = mkdtempSync(join(tmpdir(), "stalegreen-plain-"));
    try {
      const f = computeFingerprint(plain);
      expect(f.available).toBe(false);
      expect(f.reason).toBe("not-git");
      expect(compareFingerprints(f, computeFingerprint(repo.dir, GENEROUS))).toBe("unknown");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    const tight = computeFingerprint(repo.dir, { budgetMs: 0 });
    expect(tight.available).toBe(false);
    expect(computeFingerprint(repo.dir, { ...GENEROUS, maxRehashFiles: 0 }).available).toBe(true);
    writeFileSync(repo.file, "export const remaining = 9;\n");
    expect(computeFingerprint(repo.dir, { ...GENEROUS, maxRehashFiles: 0 })).toMatchObject({ available: false, reason: "too-many-changes" });
  });

  it("reports how long it took on a small repository", () => {
    const f = computeFingerprint(repo.dir, GENEROUS);
    expect(f.available).toBe(true);
    console.log(`fingerprint on a small repository: ${f.ms} ms`);
    expect(f.ms ?? 0).toBeLessThan(5000);
  });

  it("handles a repository with no commits", () => {
    const fresh = mkdtempSync(join(tmpdir(), "stalegreen-nocommit-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: fresh });
      writeFileSync(join(fresh, "a.ts"), "1\n");
      const a = computeFingerprint(fresh, GENEROUS);
      expect(a.available).toBe(true);
      expect(a.head).toBeNull();
      writeFileSync(join(fresh, "a.ts"), "2\n");
      expect(compareFingerprints(a, computeFingerprint(fresh, GENEROUS))).toBe("different");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe("pathIgnorer", () => {
  it("matches basenames for bare patterns and paths for slashed patterns", () => {
    const ignore = pathIgnorer(["*.md", "docs/**", "LICENSE*", ".stalegreen/**"]);
    expect(ignore("README.md")).toBe(true);
    expect(ignore("src/deep/notes.md")).toBe(true);
    expect(ignore("docs/guide.html")).toBe(true);
    expect(ignore("docs/a/b/c.txt")).toBe(true);
    expect(ignore("LICENSE-MIT")).toBe(true);
    expect(ignore(".stalegreen/sessions/x/receipts.jsonl")).toBe(true);
    expect(ignore("src/index.ts")).toBe(false);
    expect(ignore("mydocs/x.ts")).toBe(false);
  });
});
