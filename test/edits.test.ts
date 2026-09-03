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
    ["git checkout main", ["git checkout:"]],
    ["git stash", ["git stash:"]],
    ["git stash list", []],
    ["git merge origin/main", ["git merge:"]],
    ["git rebase main", ["git rebase:"]],
    ["git cherry-pick abc123", ["git cherry-pick:"]],
    ["git apply fix.patch", ["git apply:"]],
    ["git reset --hard HEAD~1", ["git reset:"]],
    ["git pull", ["git pull:"]],
    ["git clean -fd", ["git clean:"]],
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
