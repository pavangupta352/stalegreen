import { describe, expect, it } from "vitest";
import { editFromTool, editsFromBash } from "../src/core/edits.js";

describe("editsFromBash", () => {
  const cases: [string, string[]][] = [
    ["sed -i 's/a/b/' src/x.ts", ["sed:src/x.ts"]],
    ["sed -i '' -e 's/a/b/' src/x.ts", ["sed:src/x.ts"]],
    ["sed 's/a/b/' src/x.ts", []],
    ["echo hi > out.txt", ["redirect:out.txt"]],
    ["cat <<'EOF' > config.json\n{\n}\nEOF", ["redirect:config.json"]],
    ["printf 'x' >> notes.log", ["redirect:notes.log"]],
    ["npm test > /dev/null", []],
    ["pytest 2>&1 | tee run.log", ["tee:run.log"]],
    ["mv a.ts b.ts", ["mv:b.ts"]],
    ["cp -r src dist", ["cp:dist"]],
    ["rm -rf build", ["rm:build"]],
    ["touch src/new.ts", ["touch:src/new.ts"]],
    ["git checkout -- src/x.ts", ["git checkout:src/x.ts"]],
    ["git checkout main", []],
    ["git checkout -b feature/x", []],
    ["git switch -c feature/x", []],
    ["git reset --hard HEAD~1", ["git reset:"]],
    ["git reset HEAD~1", []],
    ["git reset -- src/x.ts", ["git reset:src/x.ts"]],
    ["git stash", []],
    ["git stash list", []],
    ["git merge origin/main", []],
    ["git rebase main", []],
    ["git cherry-pick abc123", []],
    ["git apply fix.patch", ["git apply:"]],
    ["git reset --hard HEAD~1", ["git reset:"]],
    ["git pull", []],
    ["git clean -fd", []],
    ["git clean -n", []],
    ["git commit -m 'wip'", []],
    ["git add -A", []],
    ["git status", []],
    ["git push origin main", []],
    ["git diff", []],
    ["npm install", ["npm install:"]],
    ["npm i lodash", ["npm i:"]],
    ["pnpm add -D vitest", ["pnpm add:"]],
    ["yarn add react", ["yarn add:"]],
    ["pip install requests", ["pip install:"]],
    ["uv add httpx", ["uv add:"]],
    ["cargo add serde", ["cargo add:"]],
    ["go get github.com/x/y", ["go get:"]],
    ["go mod tidy", ["go mod:"]],
    ["npx prettier --write .", ["format:"]],
    ["npx prettier --check .", []],
    ["npx eslint . --fix", ["format:"]],
    ["npx eslint .", []],
    ["ruff format .", ["format:"]],
    ["ruff format --check .", []],
    ["ruff check --fix .", ["format:"]],
    ["black .", ["format:"]],
    ["black --check .", []],
    ["cargo fmt", ["format:"]],
    ["cargo fmt --check", []],
    ["gofmt -w .", ["format:"]],
    ["gofmt -l .", []],
    ["go fmt ./...", ["format:"]],
    ["npx biome format --write .", ["format:"]],
    ["npx biome check .", []],
    ["python - <<'EOF'\nopen('x.txt','w').write('hi')\nEOF", ["heredoc:"]],
    ["python3 - <<'EOF'\nimport json\nprint(json.dumps({'a': 1}))\nEOF", []],
    ["node - <<'EOF'\nrequire('fs').writeFileSync('a.json', '{}')\nEOF", ["heredoc:"]],
    ["git reset --hard HEAD~1", ["git reset:"]],
    ["ls -la", []],
    ["cat src/x.ts", []],
    ["grep -rn foo src", []],
    ["pytest -q", []],
    ["npx vitest run", []],
    ["npm run build", []],
    ["perl -pi -e 's/a/b/' src/x.ts", ["perl:src/x.ts"]],
  ];
  for (const [cmd, expected] of cases) {
    it(JSON.stringify(cmd), () => {
      expect(editsFromBash(cmd).map((e) => `${e.kind}:${e.path ?? ""}`)).toEqual(expected);
    });
  }
});

describe("editsFromBash with output", () => {
  it("counts git operations only when the output shows the tree changed", () => {
    const kinds = (cmd: string, out: string) => editsFromBash(cmd, out).map((e) => e.kind);
    expect(kinds("git pull", "Already up to date.\n")).toEqual([]);
    expect(kinds("git pull", "Updating 1a2b3c4..5d6e7f8\nFast-forward\n src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n")).toEqual(["git pull"]);
    expect(kinds("git merge origin/main", "Already up to date.\n")).toEqual([]);
    expect(kinds("git merge origin/main", "Merge made by the 'ort' strategy.\n")).toEqual(["git merge"]);
    expect(kinds("git checkout main", "Already on 'main'\nYour branch is up to date with 'origin/main'.\n")).toEqual([]);
    expect(kinds("git checkout main", "Switched to branch 'main'\n")).toEqual(["git checkout"]);
    expect(kinds("git checkout main", "error: pathspec 'main' did not match any file(s) known to git\n")).toEqual([]);
    expect(kinds("git stash", "No local changes to save\n")).toEqual([]);
    expect(kinds("git stash", "Saved working directory and index state WIP on main: 1a2b3c4 wip\n")).toEqual(["git stash"]);
    expect(kinds("git apply fix.patch", "error: patch failed: src/a.ts:1\nerror: src/a.ts: patch does not apply\n")).toEqual([]);
    expect(kinds("git clean -fd", "")).toEqual([]);
    expect(kinds("git clean -fd", "Removing build/\n")).toEqual(["git clean"]);
    expect(kinds("git rebase main", "Current branch feature is up to date.\n")).toEqual([]);
    expect(kinds("git rebase main", "Successfully rebased and updated refs/heads/feature.\n")).toEqual(["git rebase"]);
    // Quiet operations prove nothing either way; the live gate has the fingerprint.
    expect(kinds("git checkout -q main && git pull -q", "")).toEqual([]);
    expect(kinds("git pull", "")).toEqual([]);
    expect(kinds("git checkout -- src/a.ts", "")).toEqual(["git checkout"]);
    expect(kinds("git reset --hard HEAD~1", "")).toEqual(["git reset"]);
  });

  it("counts formatters only when they report changed files", () => {
    const kinds = (cmd: string, out: string) => editsFromBash(cmd, out).map((e) => e.kind);
    expect(kinds("ruff format src", "24 files already formatted\n")).toEqual([]);
    expect(kinds("ruff format src", "1 file reformatted, 23 files left unchanged\n")).toEqual(["format"]);
    expect(kinds("ruff check --fix src", "Found 3 errors (3 fixed, 0 remaining).\n")).toEqual(["format"]);
    expect(kinds("ruff check --fix src", "All checks passed!\n")).toEqual([]);
    expect(kinds("black .", "All done! ✨ 🍰 ✨\n24 files left unchanged.\n")).toEqual([]);
    expect(kinds("black .", "reformatted src/a.py\nAll done! ✨ 🍰 ✨\n1 file reformatted, 23 files left unchanged.\n")).toEqual(["format"]);
    expect(kinds("npx prettier --write src", "src/a.ts 12ms (unchanged)\nsrc/b.ts 8ms (unchanged)\n")).toEqual([]);
    expect(kinds("npx prettier --write src", "src/a.ts 12ms\nsrc/b.ts 8ms (unchanged)\n")).toEqual(["format"]);
  });

  it("names the files a heredoc script writes", () => {
    const edits = editsFromBash("python3 - <<'PY'\nimport pathlib\np = pathlib.Path('README.md'); s = p.read_text()\np.write_text(s.replace('a', 'b'))\nPY");
    expect(edits).toEqual([{ path: "README.md", kind: "heredoc" }]);
    const two = editsFromBash("python3 - <<'PY'\np = 'src/app/page.tsx'\ns = open(p).read()\nopen(p, 'w').write(s)\nopen('tests/page.test.ts', 'w').write('x')\nPY");
    expect(two.map((e) => e.path)).toEqual(["src/app/page.tsx", "tests/page.test.ts"]);
    const none = editsFromBash("node - <<'EOF'\nrequire('fs').writeFileSync(process.argv[2], '{}')\nEOF");
    expect(none).toEqual([{ path: null, kind: "heredoc" }]);
  });
});

describe("affectsVerification", () => {
  it("ignores scratch, temp and note paths but keeps code", async () => {
    const { affectsVerification } = await import("../src/core/freshness.js");
    const ignore = () => false;
    expect(affectsVerification("/private/tmp/claude-501/x/scratchpad/q2.sql", ignore)).toBe(false);
    expect(affectsVerification("/tmp/probe.ts", ignore)).toBe(false);
    expect(affectsVerification("/Users/dev/.claude/projects/x/memory/notes.md", ignore)).toBe(false);
    expect(affectsVerification("/Users/dev/app/src/lib/hold.ts", ignore)).toBe(true);
    expect(affectsVerification("Makefile", ignore)).toBe(true);
    expect(affectsVerification(".eslintrc.json", ignore)).toBe(true);
    expect(affectsVerification("rewa.apk", ignore)).toBe(false);
    expect(affectsVerification("apk2", ignore)).toBe(false);
    expect(affectsVerification("notes.out", ignore)).toBe(false);
    expect(affectsVerification(null, ignore)).toBe(true);
  });
});

describe("editFromTool", () => {
  it("records the four file tools and nothing else", () => {
    expect(editFromTool("Edit", { file_path: "/r/a.ts" })).toEqual({ path: "/r/a.ts", kind: "Edit" });
    expect(editFromTool("Write", { file_path: "/r/a.ts" })).toEqual({ path: "/r/a.ts", kind: "Write" });
    expect(editFromTool("MultiEdit", { file_path: "/r/a.ts" })).toEqual({ path: "/r/a.ts", kind: "MultiEdit" });
    expect(editFromTool("NotebookEdit", { notebook_path: "/r/a.ipynb" })).toEqual({ path: "/r/a.ipynb", kind: "NotebookEdit" });
    expect(editFromTool("Read", { file_path: "/r/a.ts" })).toBeNull();
    expect(editFromTool("Bash", { command: "ls" })).toBeNull();
    expect(editFromTool("Edit", null)).toEqual({ path: null, kind: "Edit" });
  });
});
