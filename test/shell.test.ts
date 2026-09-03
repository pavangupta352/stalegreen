import { describe, expect, it } from "vitest";
import { parseCommand, shQuote } from "../src/core/shell.js";

describe("parseCommand", () => {
  it("splits on pipes and records the operator before each segment", () => {
    const p = parseCommand("pnpm test | tail -5");
    expect(p.segments.map((s) => s.op)).toEqual(["start", "|"]);
    expect(p.segments[0]?.words).toEqual(["pnpm", "test"]);
    expect(p.segments[1]?.words).toEqual(["tail", "-5"]);
    expect(p.confident).toBe(true);
  });

  it("splits on && and ; and || and newlines", () => {
    const p = parseCommand("cd pkg && pnpm test; echo done || true\nmake lint");
    expect(p.segments.map((s) => s.op)).toEqual(["start", "&&", ";", "||", "newline"]);
    expect(p.segments.map((s) => s.words[0])).toEqual(["cd", "pnpm", "echo", "true", "make"]);
  });

  it("does not split inside quotes or command substitution", () => {
    const p = parseCommand('pytest -q 2>&1 | grep -E "passed|failed" && echo "a && b" && echo $(ls | wc -l)');
    expect(p.segments.map((s) => s.head)).toEqual(["pytest -q 2>&1", 'grep -E "passed|failed"', 'echo "a && b"', "echo $(ls | wc -l)"]);
    expect(p.segments[0]?.redirects).toEqual([{ fd: 2, op: ">&", target: "1" }]);
    expect(p.segments[1]?.words).toEqual(["grep", "-E", "passed|failed"]);
    expect(p.segments[2]?.words).toEqual(["echo", "a && b"]);
  });

  it("keeps heredoc bodies inside the segment and flags them", () => {
    const p = parseCommand("cat > notes.txt <<'EOF'\nline one && not a command\nEOF\necho done");
    expect(p.heredoc).toBe(true);
    expect(p.segments).toHaveLength(2);
    expect(p.segments[0]?.words).toEqual(["cat"]);
    expect(p.segments[0]?.redirects).toEqual([
      { fd: null, op: ">", target: "notes.txt" },
      { fd: null, op: "<<", target: "EOF" },
    ]);
    expect(p.segments[0]?.text).toContain("line one && not a command");
    expect(p.segments[1]?.words).toEqual(["echo", "done"]);
  });

  it("flags backgrounding, process substitution and grouping", () => {
    expect(parseCommand("npm run dev &").segments[0]?.background).toBe(true);
    expect(parseCommand("diff <(ls a) <(ls b)").processSubstitution).toBe(true);
    const grouped = parseCommand("(cd pkg && pytest)");
    expect(grouped.grouping).toBe(true);
    expect(grouped.segments.map((s) => s.head)).toEqual(["(cd pkg", "pytest)"]);
    expect(parseCommand("{ pytest; } > out.log").grouping).toBe(true);
  });

  it("loses confidence on unbalanced quotes", () => {
    const p = parseCommand("echo 'unterminated && pytest");
    expect(p.confident).toBe(false);
    expect(p.reasons.join(" ")).toMatch(/quote/);
  });

  it("separates environment assignments, negation and redirects from words", () => {
    const p = parseCommand("! CI=true NODE_ENV=test npm test 2>/dev/null > out.log");
    const s = p.segments[0]!;
    expect(s.negated).toBe(true);
    expect(s.env).toEqual(["CI=true", "NODE_ENV=test"]);
    expect(s.words).toEqual(["npm", "test"]);
    expect(s.redirects).toEqual([
      { fd: 2, op: ">", target: "/dev/null" },
      { fd: null, op: ">", target: "out.log" },
    ]);
  });

  it("treats comments as whitespace", () => {
    const p = parseCommand("pytest # run the suite\nls");
    expect(p.segments[0]?.words).toEqual(["pytest"]);
    expect(p.segments[1]?.words).toEqual(["ls"]);
  });

  it("handles the bash pipe-both operator and &> redirects", () => {
    const p = parseCommand("cargo test |& tee run.log && next build &> build.log");
    expect(p.segments.map((s) => s.op)).toEqual(["start", "|", "&&"]);
    expect(p.segments[2]?.redirects).toEqual([{ fd: null, op: "&>", target: "build.log" }]);
    expect(p.segments[2]?.background).toBe(false);
  });

  it("reads single-quoted, double-quoted and escaped words", () => {
    const p = parseCommand(`pytest -k 'not slow' -m "unit and not db" path\\ with\\ space`);
    expect(p.segments[0]?.words).toEqual(["pytest", "-k", "not slow", "-m", "unit and not db", "path with space"]);
  });
});

describe("shQuote", () => {
  it("quotes only when needed", () => {
    expect(shQuote("simple-word_1.2")).toBe("simple-word_1.2");
    expect(shQuote("has space")).toBe("'has space'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
    expect(shQuote("")).toBe("''");
  });
});
