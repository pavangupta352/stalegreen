# Contributing to stalegreen

Thanks for looking at this. Bug reports with a redacted session, new runner
fixtures and harness adapters are the most useful contributions.

## Set up

```sh
git clone https://github.com/pavangupta352/stalegreen
cd stalegreen
npm install
npm run build
npm test
```

Node 20 or newer. The suite runs the compiled hook as a real process and
exercises the rewrite under `sh`, `bash` and `zsh`, so those shells need to be
on your PATH (macOS and Ubuntu have them).

## What a good change looks like

- **A runner.** Add the detection rule in `src/core/runners.ts` (`classify`),
  the pass and fail signals in `SIGNALS`, and one pass plus one fail fixture in
  `test/fixtures/runner-output/` with an entry in `index.json`. Fixtures are
  synthetic: never paste output from a real session. The fixture test fails
  loudly if a runner has no fail case.
- **A claim form.** Add sentences to `test/fixtures/claims/corpus.json` with
  the right label before touching `src/core/claims.ts`. Precision must stay at
  or above 0.98 and recall at or above 0.90 on assertive claims.
- **A masking pattern.** Extend `src/core/masking.ts` and the property test in
  `test/rewrite.test.ts`, which checks that the wrapped command's exit status
  equals the original's for every command in its corpus.
- **A harness adapter.** Mirror `src/harness/claude/`: hook handlers, a
  transcript reader, contract fixtures under `test/fixtures/hook-input/<harness>/`
  named by the harness version, and an end-to-end test that blocks a stale
  claim. Hook payload shapes drift between releases; the contract test must
  say which version it was recorded against.

## Rules that keep the tool honest

- Fail open. Nothing a hook does may break the agent; catch, count, allow.
- Every verdict cites a receipt. No heuristics that block without one.
- Unparseable output is `inconclusive`, never `fail`.
- No network calls, no telemetry, no runtime dependencies.
- Never print transcript content in tests, fixtures or logs.
- The README never uses the words lie, catch, bust or fraud. This is evidence
  hygiene, not a lie detector.

## Before you open a pull request

```sh
npm run typecheck
npm run build
npm test
```

Keep commits small and their messages plain. A change to a verdict rule
should come with a sentence in the pull request explaining which real-world
pattern motivated it.

## Reporting a false block

Run `stalegreen check --json` in the session that was blocked and attach the
output to the issue after removing anything private, or use
`stalegreen redact <session>` once it ships. The verdict record names the
receipt, the command and the edits that made the evidence stale, which is
usually enough to reproduce the decision without the transcript.
