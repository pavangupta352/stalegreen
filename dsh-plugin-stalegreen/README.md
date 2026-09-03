# dsh-plugin-stalegreen

English | [中文](README.zh.md)

The [stalegreen](https://github.com/pavangupta352/stalegreen) freshness gate as a DeepSeek Harness plugin. Verification runs (`pytest`, `pnpm test`, `tsc`, `eslint`, `cargo test`, `next build` and about eighty others) become receipts, file edits become edit events, and when the agent ends a turn with "all tests pass", "tsc is clean" or "the build succeeds", the claim is checked against the latest receipt of that category:

| Evidence | Verdict | What happens |
| --- | --- | --- |
| Passing run, no edits since | FRESH | the turn ends |
| Passing run, files changed since | STALE | one more step, with the receipt and the edited files |
| Failing run | FAILED | one more step |
| Run whose result was hidden by a pipe or a suffix | MASKED | one more step, asking for an unmasked rerun |
| No run at all | NONE | the turn ends (strict mode: one more step) |

DeepSeek Harness's own goal system says it has no independent evaluator. This plugin is one: deterministic, local, and citing a receipt for every verdict. Zero tokens, zero network, zero telemetry.

## Install

```sh
dsh plugin add dsh-plugin-stalegreen
```

The bundle inserts one plugin row, `stalegreen`, into the profile. Options go on that row in the profile's `cordis.patch.yml`:

```yaml
- id: stalegreen
  config:
    policy: advisory   # record verdicts, never steer
    mode: strict       # deny masked verification commands
```

The receipts, edit events and verdicts live under `~/.stalegreen/sessions/<session id>/`, the same store the `stalegreen` CLI reads: `npx stalegreen check` shows the last session's claims and evidence, `npx stalegreen receipt r-0017` a run's receipt and log tail.

## How it hooks in

- `tools/pre-execute`: a verification command gets a pending receipt; in strict mode a masked one (`| tail -5`, `|| true`, `2>/dev/null`) is denied with the instruction to run it without the pipe. The harness's pre-execute waterfall cannot rewrite a call, so unlike the Claude Code and Codex hooks nothing is rewritten here; the bash tool keeps the full output of a long run in a file, which limits what a pipe can hide.
- `tools/post-execute`: the bash tool's output becomes a receipt, using the runner's own summary line and the `[exit code: N]` marker; `edit`, `write` and `str_replace_editor` calls become edit events.
- `agent/turn-stopping`: the last assistant message is read for green claims. A stale, failed or masked claim steers one more step with a message such as:

```
stalegreen: "all tests pass" is stale. Receipt r-0017 (`pnpm test`, 41 passed, 14:02:11) predates 3 later edits:
  src/routes/pay.ts (14:05:40), src/lib/hold.ts (14:06:02), src/lib/hold.test.ts (14:06:31)
Rerun `pnpm test` and report the result, or state explicitly that the tests were not rerun after these edits.
```

A category is steered at most once per turn, so the agent can never be trapped.

## What it is not

Not a lie detector: it never judges intent, it checks whether the evidence behind a claim is fresh and complete. Not a replacement for the runner's judgement: a pass is the runner's own summary, never an inference from silence alone.

## License

MIT. Copyright (c) 2026 Pavan Gupta.
