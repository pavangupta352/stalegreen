# stalegreen

[![ci](https://github.com/pavangupta352/stalegreen/actions/workflows/ci.yml/badge.svg)](https://github.com/pavangupta352/stalegreen/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Hooks that keep a coding agent's green claims honest: every verification run is recorded unmasked, and "done" is blocked when the evidence is stale, failed or masked.

Zero tokens, zero network, zero telemetry. Every verdict is deterministic and cites a receipt.

> Status: pre-release. The engine, the Claude Code hooks and the freshness gate are complete and tested. The npm package, the plugin manifests and the Codex adapter land over the next weeks. Until then, build from source (see below).

## The problem

Coding agents say "all tests pass" a lot. Two things go wrong with that sentence, both measured on real session logs:

1. **Stale green.** The test run the agent is quoting happened before its own later edits. Nothing was rerun.
2. **Masked results.** The agent piped the runner through `tail -5`, `grep`, `|| true` or `; echo done`, so the exit status and the summary line never reached the transcript. The run looked fine because nothing could look wrong.

Outright contradictions, where the last run failed and the agent still reported green, are rare. Stale and masked evidence is not. stalegreen is evidence hygiene, not a lie detector.

## What it does

**Unmask.** Before a verification command runs (`pytest`, `pnpm test`, `tsc`, `eslint`, `cargo test`, `go test`, `next build` and about eighty others), the PreToolUse hook rewrites it so the full output is captured to a log, the last lines are shown to the agent, an explicit `[stalegreen] exit=<code> receipt=<id>` line is printed, and the exit status is preserved. Result-eating pipes and suffixes can no longer hide a failure. Commands that cannot be wrapped safely (heredocs, backgrounding, process substitution, `sudo`, existing redirects, watch modes) are left untouched.

**Receipt.** After the command finishes, the runner's own summary line and the exit status become a receipt: command, runner, category, pass or fail, counts, timestamp and a working-tree fingerprint. Every file edit after that is an edit event.

**Freshness gate.** When the agent tries to end its turn with a claim such as "all 41 tests pass", "tsc is clean", "lint passes" or "the build succeeds", the Stop hook looks up the latest receipt for that category:

| Evidence | Verdict | Action |
| --- | --- | --- |
| Passing run, working tree unchanged since | FRESH | allow |
| Passing run, files changed since | STALE | block once, ask for a rerun |
| Failing run | FAILED | block once |
| Run whose result was not recorded (masked) | MASKED | block once, ask for an unmasked rerun |
| No run at all | NONE | allow (block in strict mode) |
| Background run still in flight | DEFERRED | allow |

A block looks like this:

```
stalegreen: "all 41 tests pass" is stale. Receipt r-0017 (`pnpm test`, vitest, 41 passed, 14:02:11) predates 3 later edits:
  src/routes/pay.ts (14:05:40), src/lib/hold.ts (14:06:02), src/lib/hold.test.ts (14:06:31)
Rerun `pnpm test` and report the result, or state explicitly that the tests were not rerun after these edits.
```

The same category is blocked at most once per turn. A second stop is allowed and recorded, so the agent can never get stuck.

## Install

Until the first npm release, build from source and register the hooks:

```sh
git clone https://github.com/pavangupta352/stalegreen
cd stalegreen && npm install && npm run build
node dist/cli.js install --claude
node dist/cli.js doctor
```

`install --claude` copies the compiled hook to `~/.stalegreen/bin/hook.js` and registers PreToolUse, PostToolUse, Stop and SubagentStop in `~/.claude/settings.json` (add `--project` for the repository's `.claude/settings.json`, `--advisory` to record verdicts without blocking). `uninstall --claude` removes them. The plugin manifests for `/plugin marketplace add` are next; see the changelog.

Permissions stay yours: the hook returns an `allow` decision for a wrapped command only when your own permission rules already allow the original one, so it never widens what Claude Code may run. Set `"permission": "allow"` in the config to skip prompts for every verification run, or `"ask"` to never return a decision.

## How freshness is decided

The fingerprint is a hash of the content of every tracked and untracked file in the repository, read from the git index for unchanged files and from disk for modified ones, with documentation and other non-code paths excluded. It changes when any file content changes and it does not change on `git add` or `git commit`, so committing never turns fresh evidence stale. Edits made through heredocs, `sed -i`, subagents or anything else the transcript does not show are still caught. When the fingerprint is unavailable (outside git, or over its 150 ms budget) the gate falls back to edit events recorded after the receipt.

## What counts as masking

A recognised verification command is masked when its runner segment is:

- piped into `tail`, `head`, `grep`, `wc`, `cut`, `awk`, `sed`, `less`, `cat` or `tee` (without `set -o pipefail` the exit status is lost; `tail` keeps the summary, the filters do not),
- followed by `|| true`, `|| echo ...`, `; echo done` or any `;` chain,
- sent to `/dev/null` or to a file,
- prefixed with `!`.

Quiet flags (`-q`, `--silent`, `--reporter=dot`) are recorded but do not mask on their own.

## Runner catalog

| Category | Recognised runners |
| --- | --- |
| test | pytest, unittest, manage.py test, jest, vitest, mocha, ava, node --test, bun test, deno test, playwright, cypress, jasmine, tap, go test, cargo test, cargo nextest, dotnet test, mvn test, gradle test, sbt test, rspec, minitest, rails test, phpunit, pest, artisan test, mix test, swift test, xcodebuild test, flutter test, dart test, ctest, bazel test, elm-test, npm/pnpm/yarn/bun test scripts, make test |
| typecheck | tsc, vue-tsc, svelte-check, astro check, mypy, pyright, pyre, flow, cargo check, deno check, phpstan, psalm, sorbet, mix dialyzer, typecheck scripts |
| lint | eslint, biome, oxlint, stylelint, prettier --check, ruff, flake8, pylint, black --check, isort --check, golangci-lint, go vet, cargo clippy, cargo fmt --check, rubocop, phpcs, mix credo, swiftlint, dart analyze, shellcheck, hadolint, yamllint, ktlint, detekt, lint scripts |
| build | next build, vite build, webpack, rollup, esbuild, tsup, parcel, turbo, nx, cargo build, go build, make, gradle, maven, dotnet build, xcodebuild, swift build, docker build, cmake, ninja, mix compile, python -m build, elm make, build scripts |

Rules that keep verdicts honest:

- A run is `pass` only with the runner's own positive summary and a known exit status of 0. `fail` needs a fail signal or a known non-zero exit. Everything else is `inconclusive`, never `fail`.
- `0 failed`, `0 errors` and `No issues found` are passes.
- Subset runs (`-k`, `-t`, a single file path, `-p` in a workspace) satisfy "tests pass" but not "all tests pass".
- `--collect-only`, `--list`, `--help`, dry runs and watch modes are not verification runs.
- Compound commands are split on `&&`, `||`, `;` and `|` outside quotes; the directory of a leading `cd` is recorded so a failing `tsc` in one package cannot go stale-check a claim about another.

## What is a claim

The gate reads only the final assistant message. Text inside code fences, inline code and quotation marks is never a claim. Questions, instructions to the user, hedged and future statements, and statements attributed to someone else are ignored:

| Sentence | Treated as |
| --- | --- |
| All 41 tests pass. | claim, test, all |
| `tsc --noEmit` is clean. | claim, typecheck |
| Lint and typecheck both pass. | two claims |
| The tests should pass now. | hedged, ignored |
| Let me run the tests to confirm they pass. | future, ignored |
| 40 passed, 1 failed. | negated, ignored |
| According to the README, all tests pass. | relayed, ignored |
| Apart from the flaky snapshot test, all tests pass. | qualified, reported but never blocked |
| Do all tests pass? | question, ignored |

The extractor is tested against a labelled corpus of 350 sentences and must stay at or above 0.98 precision and 0.90 recall on assertive claims.

## Configuration

`~/.stalegreen/config.json`, overridable per repository in `.stalegreen.json`:

```json
{
  "policy": "block",
  "mode": "rewrite",
  "strictNoEvidence": false,
  "tailLines": 40,
  "categories": { "test": true, "typecheck": true, "lint": true, "build": true },
  "ignoreCommands": ["make lint-fast"],
  "extraRunners": [{ "match": "^make check", "category": "test", "pass": "^OK", "fail": "FAILED" }],
  "fingerprintIgnore": ["*.md", "docs/**"],
  "prune": "30d"
}
```

- `policy`: `block` (default) or `advisory`, which records verdicts without blocking.
- `mode`: `rewrite` (default), `strict` (masked commands that cannot be wrapped are denied with a rerun instruction) or `off` (no rewriting).
- `strictNoEvidence`: block claims that have no run at all.

## Output grammar

Every verdict, from the hooks and from the CLI, serialises to the same shape so other tools can consume it:

```json
{
  "claim": { "category": "test", "text": "all 41 tests pass", "scope": "all", "qualified": false },
  "evidence": { "receipt": "r-0017", "cmd": "pnpm test", "runner": "vitest", "verdict": "pass", "counts": { "passed": 41 }, "ts": "2026-09-02T14:02:11.318Z", "cwd": "/repo", "scope": "all", "masked": false },
  "freshness": { "fingerprintMatch": false, "editsAfter": [{ "path": "src/lib/hold.ts", "ts": "2026-09-02T14:06:02.000Z", "kind": "Edit" }] },
  "verdict": "STALE",
  "action": "blocked"
}
```

Receipts, edit events and verdicts live under `~/.stalegreen/sessions/<session>/` as append-only JSONL, one file per session, plus a log per run.

## CLI

```
stalegreen check [--session <id>] [--json]   claims and evidence for the current or last session
stalegreen receipt <id>                      a run's receipt and the tail of its log
stalegreen doctor                            store health and the last verdicts
```

## Principles

- **Deterministic and cited.** Every message names the receipt id, the command, the time and the files edited afterwards.
- **Fail open.** A hook crash, timeout or parse failure never breaks the agent. The failure is counted and the action is allowed.
- **Conservative.** Unrecognised commands are untouched. Unparseable output is inconclusive, never a failure. A category is blocked at most once per turn.
- **Fast.** Hook process start to exit is measured in CI; the whole engine is one compiled file with no runtime dependencies.

## What this is not

- Not a lie detector. It never judges intent and never scores anything; it checks whether the evidence behind a claim is fresh and complete.
- Not a session analyzer or dashboard.
- Not a file-existence checker. Heredoc and `sed -i` edits are invisible in transcripts, so freshness comes from the working tree, not from what the agent said it edited.

## Prior art

- [backcheck](https://github.com/VectorInstitute/backcheck) (Vector Institute, Apache-2.0): a retroactive auditor for Claude Code with a large set of runner parsers, hedge lists and test-integrity checks. The closest engine to this one; its hedge lists and false-alarm cases informed the claim grammar here.
- tycho (Apache-2.0): a deterministic cross-harness completion hook with an attestation trailer. The closest live gate.
- red-handed, nuhuh, truthguard, redpen, groundtruth, verify-gate and proof: Stop-hook gates and audits for Claude Code that attack the same pain from the "did the agent lie" angle.
- superpowers' verification-before-completion rule: no completion claims without fresh evidence. stalegreen is the deterministic layer that makes that rule checkable.
- Claude Code `/goal` and `/verify`, Codex `/goal` and Guardian, Grok Build's verifier: model-judged completion checks. They trust what lands in the transcript; stalegreen makes sure what lands there is real and fresh.
- @letta-ai/trajectory: transcript readers for many harnesses.

## License

MIT. Copyright (c) 2026 Pavan Gupta.
