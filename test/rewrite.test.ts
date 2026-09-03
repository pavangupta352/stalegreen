import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { MARKER_RE } from "../src/core/receipts.js";
import { planRewrite, refusalReason, type RewriteTarget } from "../src/core/rewrite.js";
import { detectAll } from "../src/core/runners.js";
import { parseCommand } from "../src/core/shell.js";

let work: string;
let bin: string;
let logs: string;

/** Fake runners on PATH: each prints 60 lines and exits with $FAKE_EXIT. */
const FAKE = `#!/bin/sh
i=1
while [ $i -le 58 ]; do echo "line $i of output from $0 $*"; i=$((i+1)); done
if [ "\${FAKE_EXIT:-0}" -eq 0 ]; then echo "======== 41 passed in 1.20s ========"; else echo "FAILED tests/test_a.py::test_b - boom"; echo "======== 1 failed, 40 passed in 1.20s ========"; fi
echo "final line" >&2
exit "\${FAKE_EXIT:-0}"
`;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "stalegreen-rewrite-"));
  bin = join(work, "bin");
  logs = join(work, "logs");
  mkdirSync(bin);
  mkdirSync(join(work, "sub"));
  for (const name of ["pytest", "npm", "pnpm", "npx", "cargo", "go", "make", "ruff", "tsc", "vitest", "jest", "eslint", "mypy", "yarn"]) {
    const f = join(bin, name);
    writeFileSync(f, FAKE);
    chmodSync(f, 0o755);
  }
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

function targets(cmd: string, prefix = "r"): { parsed: ReturnType<typeof parseCommand>; targets: RewriteTarget[] } {
  const parsed = parseCommand(cmd);
  const ds = detectAll(cmd, parsed).filter((d) => d.notRun === null);
  return { parsed, targets: ds.map((d, i) => ({ detection: d, id: `${prefix}-${String(i + 1).padStart(4, "0")}`, log: join(logs, `${prefix}-${i + 1}.log`) })) };
}

function plan(cmd: string, prefix = "r") {
  const t = targets(cmd, prefix);
  return planRewrite(cmd, t.targets, DEFAULT_CONFIG, t.parsed);
}

function run(shell: string, cmd: string, exit: number): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(shell, ["-c", cmd], { cwd: work, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_EXIT: String(exit), HOME: work }, encoding: "utf8", timeout: 20_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const hasZsh = spawnSync("zsh", ["-c", "true"]).status === 0;
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;

describe("planRewrite", () => {
  it("wraps a plain runner with a log, a tail, a marker and the exit status", () => {
    const p = plan("pnpm test");
    expect(p.command).not.toBeNull();
    expect(p.command).toContain("{ pnpm test ; } > \"$__sg_log\" 2>&1");
    expect(p.command).toContain("tail -n 40 \"$__sg_log\"");
    expect(p.command).toContain("receipt=r-0001");
    expect(p.command).toContain("(exit \"$__sg_rc\")");
    expect(p.command).not.toMatch(/\bexit\b(?!=)(?! "\$__sg_rc")/);
    expect(p.ids).toEqual(["r-0001"]);
  });

  it("drops a result-eating tail and raises the tail count to at least 20", () => {
    const p = plan("pnpm test | tail -5");
    expect(p.command).not.toContain("| tail");
    expect(p.tailLines).toBe(20);
    expect(p.command).toContain("tail -n 20 \"$__sg_log\"");
    expect(plan("pnpm test | tail -100").tailLines).toBe(100);
  });

  it("drops grep and keeps surrounding operators", () => {
    const p = plan('pytest -q 2>&1 | grep -E "passed|failed"');
    expect(p.command).toContain("{ pytest -q 2>&1 ; }");
    expect(p.command).not.toContain("grep");
    const chain = plan("make lint; echo done");
    expect(chain.command).toMatch(/^\{ .*\(exit "\$__sg_rc"\); \}; echo done$/);
    const cd = plan("cd sub && pnpm test | tail -5 && echo ok");
    expect(cd.command).toMatch(/^cd sub && \{ .*\(exit "\$__sg_rc"\); \} && echo ok$/);
  });

  it("wraps every runner segment in a compound command with its own id", () => {
    const p = plan("npm run lint && npm test");
    expect(p.ids).toEqual(["r-0001", "r-0002"]);
    expect(p.command).toContain("receipt=r-0001");
    expect(p.command).toContain("receipt=r-0002");
  });

  it("keeps tee targets by copying the log afterwards", () => {
    const p = plan("pytest 2>&1 | tee run.log");
    expect(p.command).toContain('cat "$__sg_log" > run.log');
    expect(plan("pytest | tee -a run.log").command).toContain('cat "$__sg_log" >> run.log');
  });

  it("refuses heredocs, backgrounding, process substitution, sudo, nested shells, redirects and watch modes", () => {
    const cases: [string, string][] = [
      ["pytest <<'EOF'\nx\nEOF", "heredoc"],
      ["pytest &", "background"],
      ["pytest > out.log 2>&1", "redirect:out.log"],
      ["pytest > /dev/null", "redirect:/dev/null"],
      ["sudo make test", "sudo"],
      ["bash -c 'pytest'", "nested-shell"],
      ["pytest --input <(cat list.txt)", "process-substitution"],
      ["(cd sub && pytest)", "grouping"],
      ["pytest < input.txt", "stdin-redirect"],
      ["! pytest", "negated"],
      ["pytest | xargs echo", "pipe:xargs"],
      ["echo 'unterminated && pytest", "no-runner"],
    ];
    for (const [cmd, reason] of cases) {
      const p = plan(cmd);
      expect(p.command, cmd).toBeNull();
      expect(p.reason, cmd).toBe(reason);
    }
    const parsed = parseCommand("npx vitest --watch");
    const d = detectAll("npx vitest --watch", parsed)[0]!;
    expect(refusalReason(parsed, d)).toBe("watch");
  });
});

describe("rewritten commands under real shells", () => {
  const runners = ["pytest -q", "npm test", "pnpm test", "npx vitest run", "npx tsc --noEmit", "npx eslint .", "cargo test", "go test ./...", "make test", "ruff check ."];
  const prefixes = ["", "cd sub && ", "CI=true "];
  const suffixes = ["", " | tail -5", " 2>&1 | tail -20", " | grep -E 'passed|failed'", " || true", "; echo done", " && echo ok"];
  const corpus: string[] = [];
  for (const r of runners) for (const p of prefixes) for (const s of suffixes) corpus.push(`${p}${r}${s}`);

  it(`has a corpus of at least 200 commands (${corpus.length})`, () => {
    expect(corpus.length).toBeGreaterThanOrEqual(200);
  });

  /** Exit status the command would have without the filter pipe: the truth the wrapper must report. */
  function reference(cmd: string, exit: number): number {
    const parsed = parseCommand(cmd);
    const d = detectAll(cmd, parsed)[0]!;
    let end = d.segmentIndex;
    while (end + 1 < parsed.segments.length && parsed.segments[end + 1]!.op === "|") end++;
    const first = parsed.segments[d.segmentIndex]!;
    const last = parsed.segments[end]!;
    const stripped = parsed.source.slice(0, first.start) + first.head + parsed.source.slice(last.end);
    return run("sh", stripped, exit).status ?? -1;
  }

  it("preserves the runner's exit status and keeps the full output on disk, under sh, bash and zsh", () => {
    let checked = 0;
    const shells = ["sh", ...(hasBash ? ["bash"] : []), ...(hasZsh ? ["zsh"] : [])];
    for (let i = 0; i < corpus.length; i++) {
      const cmd = corpus[i]!;
      const p = plan(cmd, `c${i}`);
      expect(p.command, cmd).not.toBeNull();
      for (const exit of [0, 1]) {
        const expected = reference(cmd, exit);
        const shellsForThis = i % 5 === 0 ? shells : ["sh"];
        for (const shell of shellsForThis) {
          if (existsSync(join(logs, `c${i}-1.log`))) rmSync(join(logs, `c${i}-1.log`));
          const r = run(shell, p.command as string, exit);
          expect(r.status, `${shell}: ${cmd} (exit ${exit})`).toBe(expected);
          const marker = MARKER_RE.exec(r.stdout);
          expect(marker, `${shell}: marker missing for ${cmd}`).not.toBeNull();
          expect(Number(marker![1]), `${shell}: marker exit for ${cmd}`).toBe(exit);
          const log = readFileSync(join(logs, `c${i}-1.log`), "utf8");
          expect(log, `${shell}: log for ${cmd}`).toContain("line 58 of output");
          expect(log).toContain("final line");
          expect(log).toContain(exit === 0 ? "41 passed" : "1 failed, 40 passed");
          expect(r.stdout).toContain(exit === 0 ? "41 passed" : "1 failed, 40 passed");
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(400);
  });

  it("does not leak a top-level exit into a persistent shell", () => {
    const p = plan("pytest");
    const r = run("sh", `${p.command}; echo "still here $?"`, 3);
    expect(r.stdout).toContain("still here 3");
  });
});
