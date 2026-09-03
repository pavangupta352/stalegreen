import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classify, detect, detectAll, isSilent, parseCounts, parseOutput, scriptCategory, stripWrappers } from "../src/core/runners.js";
import type { Category, RunVerdict } from "../src/core/grammar.js";

const fixtureDir = join(__dirname, "fixtures", "runner-output");

interface FixtureEntry {
  file: string;
  category: Category;
  exit: number | null;
  verdict: RunVerdict;
  counts: Record<string, number>;
  interrupted?: boolean;
}

const index = JSON.parse(readFileSync(join(fixtureDir, "index.json"), "utf8")) as FixtureEntry[];

describe("runner output fixtures", () => {
  it("cover every category with both pass and fail cases", () => {
    for (const category of ["test", "typecheck", "lint", "build"] as const) {
      const verdicts = new Set(index.filter((f) => f.category === category).map((f) => f.verdict));
      expect(verdicts.has("pass"), `${category} has a pass fixture`).toBe(true);
      expect(verdicts.has("fail"), `${category} has a fail fixture`).toBe(true);
    }
    expect(index.length).toBeGreaterThan(150);
  });

  for (const f of index) {
    it(`${f.file} -> ${f.verdict}`, () => {
      const output = readFileSync(join(fixtureDir, f.file), "utf8");
      const r = parseOutput(f.category, output, { exit: f.exit, ...(f.interrupted ? { interrupted: true } : {}) });
      expect(r.verdict, `${f.file}: signal ${r.signal}`).toBe(f.verdict);
      for (const [k, v] of Object.entries(f.counts)) {
        expect((r.counts as Record<string, number | undefined>)[k], `${f.file} counts.${k}`).toBe(v);
      }
    });
  }
});

describe("parseOutput rules", () => {
  it("treats zero failures and zero errors as pass, never fail", () => {
    expect(parseOutput("test", "======== 41 passed, 0 failed in 1.2s ========\n", { exit: 0 }).verdict).toBe("pass");
    expect(parseOutput("test", "Tests:       0 failed, 41 passed, 41 total\n", { exit: 0 }).verdict).toBe("pass");
    expect(parseOutput("test", " Tests  0 failed | 41 passed (41)\n", { exit: 0 }).verdict).toBe("pass");
    expect(parseOutput("typecheck", "Found 0 errors.\n", { exit: 0 }).verdict).toBe("pass");
    expect(parseOutput("typecheck", "Success: no issues found in 3 source files\n", { exit: 0 }).verdict).toBe("pass");
    expect(parseOutput("typecheck", "0 errors, 0 warnings, 0 informations\n", { exit: 0 }).verdict).toBe("pass");
    expect(parseOutput("lint", "Found 0 warnings and 0 errors.\n", { exit: 0 }).verdict).toBe("pass");
    expect(parseOutput("lint", "No issues found!\n", { exit: 0 }).verdict).toBe("pass");
  });

  it("requires a known exit status of 0 for a pass", () => {
    expect(parseOutput("test", "======== 41 passed in 1.2s ========\n", { exit: null }).verdict).toBe("inconclusive");
    expect(parseOutput("test", "======== 41 passed in 1.2s ========\n", { exit: 1 }).verdict).toBe("fail");
    expect(parseOutput("typecheck", "", { exit: null }).verdict).toBe("inconclusive");
    expect(parseOutput("typecheck", "", { exit: 0 }).verdict).toBe("pass");
  });

  it("marks a missing summary as inconclusive rather than fail", () => {
    const truncated = "============ test session starts ============\ncollected 41 items\n\ntests/test_a.py ....";
    expect(parseOutput("test", truncated, { exit: 0 }).verdict).toBe("inconclusive");
    expect(parseOutput("test", truncated, { exit: 0 }).signal).toBe("no-summary");
  });

  it("reads counts from the common summary formats", () => {
    expect(parseCounts("========= 1 failed, 40 passed, 2 skipped in 2.4s =========")).toEqual({ failed: 1, passed: 40, skipped: 2 });
    expect(parseCounts("Tests:       1 failed, 2 skipped, 40 passed, 43 total")).toEqual({ failed: 1, skipped: 2, passed: 40, total: 43 });
    expect(parseCounts("      Tests  2 failed | 39 passed | 1 skipped (42)")).toEqual({ failed: 2, passed: 39, skipped: 1, total: 42 });
    expect(parseCounts("test result: ok. 17 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out")).toEqual({ passed: 17, failed: 0, skipped: 1 });
    expect(parseCounts("28 examples, 1 failure, 2 pending")).toEqual({ total: 28, failed: 1, passed: 25, skipped: 2 });
    expect(parseCounts("✖ 3 problems (2 errors, 1 warning)")).toEqual({ errors: 2 });
  });

  it("treats package-manager banners as silence for silent-success tools", () => {
    expect(isSilent("\n> app@0.1.0 typecheck\n> tsc --noEmit\n\n")).toBe(true);
    expect(isSilent("\n> app@0.1.0 typecheck /work/app\n> tsc --noEmit\n\n")).toBe(true);
    expect(isSilent("yarn run v1.22.19\n$ tsc --noEmit\nDone in 2.31s.\n")).toBe(true);
    expect(isSilent("")).toBe(true);
    expect(isSilent("src/a.ts(1,1): error TS2322: nope\n")).toBe(false);
    expect(parseOutput("typecheck", "\n> app@0.1.0 typecheck\n> tsc --noEmit\n\n", { exit: null, outputVisible: true }).verdict).toBe("pass");
    expect(parseOutput("typecheck", "\n> app@0.1.0 typecheck\n> tsc --noEmit\n\nsrc/a.ts(1,1): error TS2322: nope\n", { exit: null, outputVisible: true }).verdict).toBe("fail");
    expect(parseOutput("test", "", { exit: null, outputVisible: true }).verdict).toBe("inconclusive");
  });

  it("trusts one-line summaries through a filter but not multi-line ones", () => {
    expect(parseOutput("test", "========= 41 passed in 1.20s =========\n", { exit: null, filtered: true })).toMatchObject({ verdict: "pass", signal: "summary-line:pytest-passed" });
    expect(parseOutput("test", "ok  \texample.com/app\t0.4s\n", { exit: null, filtered: true }).verdict).toBe("inconclusive");
    expect(parseOutput("test", "  12 passing (84ms)\n", { exit: null, filtered: true }).verdict).toBe("inconclusive");
    expect(parseOutput("lint", "All checks passed!\n", { exit: null, filtered: true }).verdict).toBe("pass");
    expect(parseOutput("lint", "", { exit: null, filtered: true }).verdict).toBe("inconclusive");
  });

  it("strips ANSI colours before matching", () => {
    const coloured = "\x1b[32m============================== \x1b[32m\x1b[1m3 passed\x1b[0m\x1b[32m in 0.04s\x1b[0m\x1b[32m ==============================\x1b[0m\n";
    expect(parseOutput("test", coloured, { exit: 0 })).toMatchObject({ verdict: "pass", counts: { passed: 3 } });
  });
});

interface DetectCase {
  cmd: string;
  runner: string | null;
  category?: Category;
  scope?: "all" | "subset";
  notRun?: string | null;
  cd?: string | null;
  sudo?: boolean;
  nested?: boolean;
}

const cases: DetectCase[] = [
  { cmd: "pytest", runner: "pytest", category: "test", scope: "all", notRun: null },
  { cmd: "pytest -q tests/test_holds.py", runner: "pytest", scope: "subset" },
  { cmd: "pytest tests/", runner: "pytest", scope: "all" },
  { cmd: "pytest -k expiry", runner: "pytest", scope: "subset" },
  { cmd: "pytest tests/test_a.py::test_b", runner: "pytest", scope: "subset" },
  { cmd: "pytest --collect-only", runner: "pytest", notRun: "list" },
  { cmd: "pytest --co -q", runner: "pytest", notRun: "list" },
  { cmd: "python -m pytest -x", runner: "pytest", category: "test", scope: "all" },
  { cmd: "python3 -m pytest tests/unit -q", runner: "pytest", scope: "all" },
  { cmd: "uv run pytest", runner: "pytest" },
  { cmd: "poetry run pytest -q", runner: "pytest" },
  { cmd: "python -m unittest discover -s tests", runner: "unittest", category: "test", scope: "all" },
  { cmd: "python manage.py test", runner: "manage.py test", category: "test" },
  { cmd: "python -m mypy src/", runner: "mypy", category: "typecheck", scope: "all" },
  { cmd: "mypy app/holds.py", runner: "mypy", scope: "subset" },
  { cmd: "pyright", runner: "pyright", category: "typecheck" },
  { cmd: "ruff check .", runner: "ruff check", category: "lint", scope: "all" },
  { cmd: "ruff check app/holds.py", runner: "ruff check", scope: "subset" },
  { cmd: "ruff format --check .", runner: "ruff format", category: "lint", notRun: null },
  { cmd: "ruff format .", runner: "ruff format", notRun: "format" },
  { cmd: "ruff", runner: "ruff", notRun: "help" },
  { cmd: "black --check .", runner: "black", category: "lint", notRun: null },
  { cmd: "black .", runner: "black", notRun: "format" },
  { cmd: "flake8", runner: "flake8", category: "lint" },
  { cmd: "npm test", runner: "npm test", category: "test", scope: "all" },
  { cmd: "npm t", runner: "npm test" },
  { cmd: "npm run test", runner: "npm run test", category: "test" },
  { cmd: "npm run test:unit -- --coverage", runner: "npm run test:unit", category: "test" },
  { cmd: "npm run test:watch", runner: "npm run test:watch", notRun: "watch" },
  { cmd: "npm run build", runner: "npm run build", category: "build" },
  { cmd: "npm run lint", runner: "npm run lint", category: "lint" },
  { cmd: "npm run typecheck", runner: "npm run typecheck", category: "typecheck" },
  { cmd: "npm run type-check", runner: "npm run type-check", category: "typecheck" },
  { cmd: "npm run dev", runner: null },
  { cmd: "npm run deploy", runner: null },
  { cmd: "npm install", runner: null },
  { cmd: "pnpm test", runner: "pnpm test", category: "test" },
  { cmd: "pnpm -r test", runner: "pnpm test", category: "test" },
  { cmd: "pnpm --filter api test", runner: "pnpm test", category: "test" },
  { cmd: "pnpm build", runner: "pnpm build", category: "build" },
  { cmd: "pnpm lint", runner: "pnpm lint", category: "lint" },
  { cmd: "pnpm typecheck", runner: "pnpm typecheck", category: "typecheck" },
  { cmd: "pnpm run test:e2e", runner: "pnpm run test:e2e", category: "test" },
  { cmd: "pnpm exec vitest run", runner: "vitest", category: "test" },
  { cmd: "pnpm dlx tsc --noEmit", runner: "tsc", category: "typecheck" },
  { cmd: "yarn test", runner: "yarn test", category: "test" },
  { cmd: "yarn build", runner: "yarn build", category: "build" },
  { cmd: "yarn workspace api test", runner: "yarn test", category: "test" },
  { cmd: "bun test", runner: "bun test", category: "test" },
  { cmd: "bun test src/hold.test.ts", runner: "bun test", scope: "subset" },
  { cmd: "bun run build", runner: "bun run build", category: "build" },
  { cmd: "bunx vitest run", runner: "vitest" },
  { cmd: "deno test", runner: "deno test", category: "test" },
  { cmd: "deno check main.ts", runner: "deno check", category: "typecheck" },
  { cmd: "deno task test", runner: "deno task test", category: "test" },
  { cmd: "npx jest", runner: "jest", category: "test", scope: "all" },
  { cmd: "npx jest src/lib/hold.test.ts", runner: "jest", scope: "subset" },
  { cmd: "npx jest -t 'expires'", runner: "jest", scope: "subset" },
  { cmd: "npx jest --watch", runner: "jest", notRun: "watch" },
  { cmd: "npx jest --watchAll", runner: "jest", notRun: "watch" },
  { cmd: "npx jest --listTests", runner: "jest", notRun: "list" },
  { cmd: "npx vitest run", runner: "vitest", category: "test", scope: "all" },
  { cmd: "npx vitest", runner: "vitest", notRun: null },
  { cmd: "npx vitest run src/hold.test.ts", runner: "vitest", scope: "subset" },
  { cmd: "npx vitest --watch", runner: "vitest", notRun: "watch" },
  { cmd: "npx vitest watch", runner: "vitest", notRun: "watch" },
  { cmd: "npx vitest --ui", runner: "vitest", notRun: "watch" },
  { cmd: "npx vitest list", runner: "vitest", notRun: "list" },
  { cmd: "npx mocha", runner: "mocha", category: "test" },
  { cmd: "npx mocha test/hold.test.js", runner: "mocha", scope: "subset" },
  { cmd: "node --test", runner: "node --test", category: "test", scope: "all" },
  { cmd: "node --test test/hold.test.js", runner: "node --test", scope: "subset" },
  { cmd: "node --test --watch", runner: "node --test", notRun: "watch" },
  { cmd: "npx playwright test", runner: "playwright test", category: "test" },
  { cmd: "npx playwright test checkout.spec.ts", runner: "playwright test", scope: "subset" },
  { cmd: "npx playwright test --ui", runner: "playwright test", notRun: "watch" },
  { cmd: "npx tsc --noEmit", runner: "tsc", category: "typecheck", scope: "all" },
  { cmd: "npx tsc --noEmit -p tsconfig.app.json", runner: "tsc", scope: "all" },
  { cmd: "npx tsc -b --noEmit", runner: "tsc", scope: "all" },
  { cmd: "npx tsc --noEmit src/lib/hold.ts", runner: "tsc", scope: "subset" },
  { cmd: "pytest -c pytest.ini", runner: "pytest", scope: "all" },
  { cmd: "npx jest --config jest.config.js", runner: "jest", scope: "all" },
  { cmd: "npx eslint -c eslint.config.js .", runner: "eslint", scope: "all" },
  { cmd: "npx tsc -p tsconfig.json --noEmit", runner: "tsc", category: "typecheck" },
  { cmd: "npx tsc -b", runner: "tsc", category: "typecheck" },
  { cmd: "npx tsc --watch", runner: "tsc", notRun: "watch" },
  { cmd: "npx tsc -w", runner: "tsc", notRun: "watch" },
  { cmd: "npx tsc --version", runner: "tsc", notRun: "help" },
  { cmd: "node node_modules/.bin/tsc --noEmit", runner: "tsc", category: "typecheck" },
  { cmd: "./node_modules/.bin/eslint src", runner: "eslint", category: "lint" },
  { cmd: "npx vue-tsc --noEmit", runner: "vue-tsc", category: "typecheck" },
  { cmd: "npx svelte-check", runner: "svelte-check", category: "typecheck" },
  { cmd: "npx eslint .", runner: "eslint", category: "lint", scope: "all" },
  { cmd: "npx eslint src/lib/hold.ts", runner: "eslint", scope: "subset" },
  { cmd: "npx eslint . --fix", runner: "eslint", notRun: null },
  { cmd: "npx eslint --print-config src/a.ts", runner: "eslint", notRun: "list" },
  { cmd: "npx biome check .", runner: "biome check", category: "lint" },
  { cmd: "npx biome format --write .", runner: "biome format", notRun: "format" },
  { cmd: "npx prettier --check .", runner: "prettier", category: "lint", notRun: null },
  { cmd: "npx prettier --write .", runner: "prettier", notRun: "format" },
  { cmd: "npx oxlint", runner: "oxlint", category: "lint" },
  { cmd: "npx next build", runner: "next build", category: "build" },
  { cmd: "next build", runner: "next build", category: "build" },
  { cmd: "next dev", runner: null },
  { cmd: "npx next lint", runner: "next lint", category: "lint" },
  { cmd: "npx vite build", runner: "vite build", category: "build" },
  { cmd: "npx vite", runner: null },
  { cmd: "npx vite build --watch", runner: "vite build", notRun: "watch" },
  { cmd: "npx webpack", runner: "webpack", category: "build" },
  { cmd: "npx webpack serve", runner: "webpack", notRun: "watch" },
  { cmd: "npx tsup", runner: "tsup", category: "build" },
  { cmd: "npx tsup --watch", runner: "tsup", notRun: "watch" },
  { cmd: "npx esbuild src/index.ts --bundle --outfile=dist/index.js", runner: "esbuild", category: "build" },
  { cmd: "npx turbo run build", runner: "turbo run build", category: "build" },
  { cmd: "npx turbo test", runner: "turbo test", category: "test" },
  { cmd: "npx nx test api", runner: "nx test", category: "test" },
  { cmd: "npx nx run-many -t lint", runner: "nx lint", category: "lint" },
  { cmd: "npx nx run api:build", runner: "nx build", category: "build" },
  { cmd: "go test ./...", runner: "go test", category: "test", scope: "all" },
  { cmd: "go test ./pkg/holds", runner: "go test", scope: "subset" },
  { cmd: "go test -run TestExpiry ./...", runner: "go test", scope: "subset" },
  { cmd: "go test -list . ./...", runner: "go test", notRun: "list" },
  { cmd: "go build ./...", runner: "go build", category: "build" },
  { cmd: "go vet ./...", runner: "go vet", category: "lint" },
  { cmd: "golangci-lint run", runner: "golangci-lint", category: "lint" },
  { cmd: "cargo test", runner: "cargo test", category: "test", scope: "all" },
  { cmd: "cargo test --workspace", runner: "cargo test", scope: "all" },
  { cmd: "cargo test expiry", runner: "cargo test", scope: "subset" },
  { cmd: "cargo test -p holds", runner: "cargo test", scope: "subset" },
  { cmd: "cargo test --no-run", runner: "cargo test", notRun: "list" },
  { cmd: "cargo nextest run", runner: "cargo nextest", category: "test" },
  { cmd: "cargo build --release", runner: "cargo build", category: "build" },
  { cmd: "cargo check", runner: "cargo check", category: "typecheck" },
  { cmd: "cargo clippy -- -D warnings", runner: "cargo clippy", category: "lint" },
  { cmd: "cargo fmt --check", runner: "cargo fmt", category: "lint", notRun: null },
  { cmd: "cargo fmt", runner: "cargo fmt", notRun: "format" },
  { cmd: "cargo watch -x test", runner: "cargo watch", notRun: "watch" },
  { cmd: "cargo run", runner: null },
  { cmd: "dotnet test", runner: "dotnet test", category: "test" },
  { cmd: "dotnet test --filter Category=Unit", runner: "dotnet test", scope: "subset" },
  { cmd: "dotnet build", runner: "dotnet build", category: "build" },
  { cmd: "mvn test", runner: "mvn test", category: "test" },
  { cmd: "mvn -q -Dtest=HoldTest test", runner: "mvn test", scope: "subset" },
  { cmd: "mvn package -DskipTests", runner: "mvn package", category: "build" },
  { cmd: "./gradlew test", runner: "gradlew test", category: "test" },
  { cmd: "./gradlew test --tests HoldTest", runner: "gradlew test", scope: "subset" },
  { cmd: "./gradlew build", runner: "gradlew build", category: "build" },
  { cmd: "gradle assembleDebug", runner: "gradle build", category: "build" },
  { cmd: "bundle exec rspec", runner: "rspec", category: "test", scope: "all" },
  { cmd: "bundle exec rspec spec/hold_spec.rb:22", runner: "rspec", scope: "subset" },
  { cmd: "bundle exec rubocop", runner: "rubocop", category: "lint" },
  { cmd: "bin/rails test", runner: "rails test", category: "test" },
  { cmd: "vendor/bin/phpunit", runner: "phpunit", category: "test" },
  { cmd: "./vendor/bin/phpunit --filter HoldTest", runner: "phpunit", scope: "subset" },
  { cmd: "php artisan test", runner: "artisan test", category: "test" },
  { cmd: "vendor/bin/phpstan analyse", runner: "phpstan", category: "typecheck" },
  { cmd: "mix test", runner: "mix test", category: "test" },
  { cmd: "mix test test/hold_test.exs", runner: "mix test", scope: "subset" },
  { cmd: "mix compile --warnings-as-errors", runner: "mix compile", category: "build" },
  { cmd: "mix credo --strict", runner: "mix credo", category: "lint" },
  { cmd: "swift test", runner: "swift test", category: "test" },
  { cmd: "swift build", runner: "swift build", category: "build" },
  { cmd: "xcodebuild test -scheme Holds", runner: "xcodebuild test", category: "test" },
  { cmd: "flutter test", runner: "flutter test", category: "test" },
  { cmd: "dart analyze", runner: "dart analyze", category: "lint" },
  { cmd: "make", runner: "make", category: "build" },
  { cmd: "make build", runner: "make build", category: "build" },
  { cmd: "make test", runner: "make test", category: "test" },
  { cmd: "make -j4 test", runner: "make test", category: "test" },
  { cmd: "make lint", runner: "make lint", category: "lint" },
  { cmd: "make typecheck", runner: "make typecheck", category: "typecheck" },
  { cmd: "make check", runner: null },
  { cmd: "make -n test", runner: "make test", notRun: "dry-run" },
  { cmd: "make clean", runner: null },
  { cmd: "ctest --output-on-failure", runner: "ctest", category: "test" },
  { cmd: "cmake --build build", runner: "cmake --build", category: "build" },
  { cmd: "bazel test //...", runner: "bazel test", category: "test", scope: "all" },
  { cmd: "docker build -t holds .", runner: "docker build", category: "build" },
  { cmd: "shellcheck scripts/*.sh", runner: "shellcheck", category: "lint" },
  // wrappers, env prefixes and directories
  { cmd: "CI=true npm test", runner: "npm test", category: "test" },
  { cmd: "NODE_ENV=test FORCE_COLOR=0 npx vitest run", runner: "vitest" },
  { cmd: "cd packages/api && pnpm test", runner: "pnpm test", cd: "packages/api" },
  { cmd: "cd packages/api; pnpm test", runner: "pnpm test", cd: "packages/api" },
  { cmd: "cd packages/api && cd ../web && npm run build", runner: "npm run build", cd: "packages/api/../web" },
  { cmd: "pnpm -C packages/api test", runner: "pnpm test", cd: "packages/api" },
  { cmd: "make -C build test", runner: "make test", cd: "build" },
  { cmd: "npm --prefix web run build", runner: "npm run build", cd: "web" },
  { cmd: "timeout 300 pytest -q", runner: "pytest" },
  { cmd: "timeout -k 5 120s npm test", runner: "npm test" },
  { cmd: "time cargo test", runner: "cargo test" },
  { cmd: "sudo make test", runner: "make test", sudo: true },
  { cmd: "env CI=1 go test ./...", runner: "go test" },
  { cmd: "cross-env NODE_ENV=test jest", runner: "jest" },
  { cmd: "dotenv -e .env.test -- vitest run", runner: "vitest" },
  { cmd: "nyc mocha", runner: "mocha" },
  { cmd: "c8 --reporter=text node --test", runner: "node --test" },
  { cmd: "coverage run -m pytest", runner: "pytest" },
  { cmd: "bash -c 'cd api && pytest -q'", runner: "pytest", cd: "api", nested: true },
  { cmd: 'sh -c "npm test"', runner: "npm test", nested: true },
  { cmd: "(cd pkg && pytest)", runner: "pytest", cd: "pkg" },
  { cmd: "pytest -q 2>&1 | tail -20", runner: "pytest" },
  { cmd: "npm run lint && npm test", runner: "npm run lint", category: "lint" },
  // not runners
  { cmd: "git status", runner: null },
  { cmd: "ls -la", runner: null },
  { cmd: "cat README.md", runner: null },
  { cmd: "grep -rn 'test' src", runner: null },
  { cmd: "echo 'all tests pass'", runner: null },
  { cmd: "python script.py", runner: null },
  { cmd: "node scripts/build-docs.js", runner: null },
  { cmd: "npm run test:watch -- --coverage", runner: "npm run test:watch", notRun: "watch" },
  { cmd: "pytest --help", runner: "pytest", notRun: "help" },
  { cmd: "", runner: null },
];

describe("detect", () => {
  for (const c of cases) {
    it(JSON.stringify(c.cmd), () => {
      const all = detectAll(c.cmd);
      const d = all[0] ?? null;
      if (c.runner === null) {
        expect(d, `expected no runner, got ${d?.runner}`).toBeNull();
        return;
      }
      expect(d, "expected a runner").not.toBeNull();
      expect(d!.runner).toBe(c.runner);
      if (c.category) expect(d!.category).toBe(c.category);
      if (c.scope) expect(d!.scope).toBe(c.scope);
      if (c.notRun !== undefined) expect(d!.notRun).toBe(c.notRun);
      if (c.cd !== undefined) expect(d!.cd).toBe(c.cd);
      if (c.sudo !== undefined) expect(d!.sudo).toBe(c.sudo);
      if (c.nested !== undefined) expect(d!.nested).toBe(c.nested);
    });
  }

  it("returns every runner in a compound command", () => {
    const all = detectAll("npm run lint && npm run typecheck && npm test");
    expect(all.map((d) => d.category)).toEqual(["lint", "typecheck", "test"]);
    expect(all.map((d) => d.segmentIndex)).toEqual([0, 1, 2]);
  });

  it("skips non-run invocations when asked for the first real run", () => {
    expect(detect("pytest --collect-only && pytest -q")?.segmentIndex).toBe(1);
    expect(detect("npx vitest --watch")).toBeNull();
  });

  it("strips wrappers down to the runner words", () => {
    expect(stripWrappers(["CI=true", "timeout", "60", "npx", "--yes", "vitest", "run"]).words).toEqual(["vitest", "run"]);
    expect(stripWrappers(["sudo", "-E", "make", "test"])).toMatchObject({ words: ["make", "test"], sudo: true });
    expect(stripWrappers(["bash", "-lc", "pytest"]).nested).toBe("pytest");
  });

  it("maps package script names to categories", () => {
    expect(scriptCategory("test")).toEqual({ category: "test", watch: false });
    expect(scriptCategory("test:watch")).toEqual({ category: "test", watch: true });
    expect(scriptCategory("build")).toEqual({ category: "build", watch: false });
    expect(scriptCategory("lint:fix")).toEqual({ category: "lint", watch: false });
    expect(scriptCategory("typecheck")).toEqual({ category: "typecheck", watch: false });
    expect(scriptCategory("dev")).toBeNull();
    expect(scriptCategory("start")).toBeNull();
    expect(scriptCategory("deploy")).toBeNull();
    expect(classify(["pnpm", "check"])).toBeNull();
  });
});
