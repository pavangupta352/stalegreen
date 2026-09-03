import { describe, expect, it } from "vitest";
import { analyzeMasking } from "../src/core/masking.js";
import { detectAll } from "../src/core/runners.js";
import { parseCommand } from "../src/core/shell.js";

function analyze(cmd: string) {
  const parsed = parseCommand(cmd);
  const d = detectAll(cmd, parsed)[0];
  if (!d) throw new Error(`no runner in ${cmd}`);
  return analyzeMasking(parsed, d.segmentIndex);
}

describe("analyzeMasking", () => {
  it("leaves plain runs and && chains alone", () => {
    expect(analyze("pytest -q")).toMatchObject({ masked: false, exitPreserved: true, outputVisible: true });
    expect(analyze("npm run lint && npm test")).toMatchObject({ masked: false, exitPreserved: true });
    expect(analyze("cd api && pytest && echo ok")).toMatchObject({ masked: false });
    expect(analyze("pytest 2>&1")).toMatchObject({ masked: false });
    expect(analyze("pytest || exit 1")).toMatchObject({ masked: false });
    expect(analyze("pytest;")).toMatchObject({ masked: false });
  });

  it("flags result-eating pipes and records the tail count", () => {
    expect(analyze("pnpm test | tail -5")).toMatchObject({ masked: true, exitPreserved: false, outputVisible: true, tailLines: 5, reasons: ["pipe:tail"] });
    expect(analyze("pnpm test 2>&1 | tail -n 20")).toMatchObject({ tailLines: 20 });
    expect(analyze("pnpm test | tail")).toMatchObject({ tailLines: 10 });
    expect(analyze('pytest -q 2>&1 | grep -E "passed|failed"')).toMatchObject({ masked: true, outputVisible: false, reasons: ["pipe:grep"] });
    expect(analyze("go test ./... | tee out.log")).toMatchObject({ masked: true, exitPreserved: false, outputVisible: true });
    expect(analyze("cargo test 2>&1 | head -50 | tail -20")).toMatchObject({ masked: true, outputVisible: false, tailLines: 20, pipelineEnd: 2 });
  });

  it("keeps the exit status with pipefail but still notes filtering", () => {
    expect(analyze("set -o pipefail; pytest | tail -20")).toMatchObject({ masked: true, exitPreserved: true, pipefail: true, outputVisible: true });
    expect(analyze("set -o pipefail; pytest | grep passed")).toMatchObject({ exitPreserved: true, outputVisible: false });
  });

  it("flags || and ; suffixes that swallow the exit status", () => {
    expect(analyze("npm test || true")).toMatchObject({ masked: true, exitPreserved: false, reasons: ["or-chain"] });
    expect(analyze("npm test || echo failed")).toMatchObject({ masked: true, reasons: ["or-chain"] });
    expect(analyze("make lint; echo done")).toMatchObject({ masked: true, exitPreserved: false, reasons: ["semicolon"] });
    expect(analyze("npm test && echo ok || true")).toMatchObject({ masked: true, reasons: ["or-chain"] });
    expect(analyze("pytest\necho done")).toMatchObject({ masked: true, reasons: ["semicolon"] });
    expect(analyze("pytest; exit $?")).toMatchObject({ masked: false });
    expect(analyze("! pytest")).toMatchObject({ masked: true, reasons: ["negated"] });
  });

  it("flags output sent to /dev/null or a file", () => {
    expect(analyze("npm test > /dev/null")).toMatchObject({ masked: true, exitPreserved: true, outputVisible: false, reasons: ["devnull:stdout"] });
    expect(analyze("npm test 2>/dev/null")).toMatchObject({ masked: false, reasons: ["devnull:stderr"], outputVisible: true });
    expect(analyze("npm test > out.log 2>&1")).toMatchObject({ masked: true, exitPreserved: true, outputVisible: false, reasons: ["redirect:out.log"] });
    expect(analyze("npm test &> /dev/null")).toMatchObject({ masked: true, reasons: ["devnull:both"] });
    expect(analyze("npm test >/dev/null 2>&1 || true")).toMatchObject({ masked: true, reasons: ["devnull:stdout", "or-chain"] });
  });

  it("reports backgrounded runs", () => {
    expect(analyze("npm test &")).toMatchObject({ background: true });
    expect(analyze("npm test > out.log 2>&1 &")).toMatchObject({ background: true });
  });
});
