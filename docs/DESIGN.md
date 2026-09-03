# Design

This document explains how stalegreen decides things and why. The README says
what it does; this says how the pieces fit, which choices were deliberate, and
which rules came out of reading real sessions rather than from first
principles. Everything here is deterministic. No model is consulted at any
point, nothing leaves the machine, and every verdict can be traced back to a
receipt on disk.

## The problem, precisely

An agent's "all tests pass" is a claim about the past. Two things make such a
claim wrong more often than an outright contradiction does:

1. **Stale evidence.** The run that produced the green summary happened before
   the agent's own later edits. Nothing was rerun. In the author's own
   sessions this is a quarter of all green claims.
2. **Masked evidence.** The run went through `| tail -5`, `| grep`,
   `2>/dev/null`, `|| true` or a `; echo done` chain, so the exit status never
   reached the transcript and, often, neither did the summary line. Almost
   every verification run in the same sessions was piped like this.

Contradictions, where the last run failed and the agent still said green,
exist but are rare. stalegreen is built for the common case, which is
evidence hygiene, not deception.

## The three behaviours

```
PreToolUse   verification command  ->  wrapped so its full output is logged,
                                        the tail is shown, and an explicit
                                        [stalegreen] exit=N receipt=r-0017 line
                                        is printed
PostToolUse  command output        ->  a receipt (pass, fail, inconclusive)
             file tools            ->  an edit event
Stop         final message         ->  claims, each matched to the latest
                                        receipt of its category and judged
                                        FRESH, STALE, FAILED, MASKED, NONE
                                        or DEFERRED
```

A block is a message naming the receipt, the command, the counts, the time
and the files edited afterwards, followed by exactly what to do. A category is
blocked at most once per turn; the second stop is allowed and recorded, so the
agent can never be trapped.

## Module map

| Module | Owns |
| --- | --- |
| `core/shell.ts` | A POSIX shell splitter: segments on `&&`, `\|\|`, `;`, `\|`, `&` outside quotes, with words, env assignments, redirects, heredocs and process substitutions. Never executes anything. |
| `core/runners.ts` | The runner catalog. `classify(words)` names the runner and category; `parseOutput(category, output, opts)` turns output plus exit status into a verdict, counts and the signal that decided it. |
| `core/masking.ts` | For one runner segment inside a compound command: is the exit status preserved, is the end of the output visible, is it filtered, is it counted, is it backgrounded. |
| `core/rewrite.ts` | The wrapped command, and every reason not to wrap. |
| `core/receipts.ts` | Receipts from output: attribution of compound output to segments, exit recovery from the agent's own echoes, the silent-success rules, log read-back, the store. |
| `core/edits.ts` | Edit events from the file tools and from shell commands, judged by their output where it matters. |
| `core/fingerprint.ts` | A content hash of the working tree. |
| `core/claims.ts` | The claim grammar. |
| `core/freshness.ts` | Receipt selection and the verdict. |
| `harness/hooks.ts` | The three handlers, shared. A small adapter per harness supplies the turn id, the shell output shape, the edit tools, the allow decision and the block format. |
| `harness/claude`, `harness/codex` | The adapters, the permission mirror for Claude Code, and the transcript readers behind `history` and `stats`. |

The hook binary is one file with no dependencies. Cold start is measured in
CI against a bare `node -e 0` and must stay under 50 ms at p95 above it.

## The rewrite

Only a recognised verification command is touched, and only its own segment.
`cd pkg && pnpm test | tail -5` becomes, in POSIX sh:

```sh
{ __sg_log=/home/me/.stalegreen/sessions/<root>/runs/r-0017.log; mkdir -p "${__sg_log%/*}";
  { cd pkg && pnpm test ; } > "$__sg_log" 2>&1; __sg_rc=$?;
  tail -n 20 "$__sg_log";
  printf '\n[stalegreen] exit=%s receipt=r-0017 lines=%s log=%s\n' "$__sg_rc" "$(wc -l < "$__sg_log" | tr -d ' ')" "$__sg_log";
  (exit "$__sg_rc"); }
```

Rules that fell out of testing 210 commands under sh, bash and zsh:

- The agent's own `tail -n K` is kept but raised to at least 20; otherwise 40
  lines are shown. Filter pipes (`grep`, `head`, `wc`, `cut`, `awk`, `sed`)
  are dropped because they eat the summary; `tee` targets are kept by copying
  the log to them afterwards.
- The exit status is restored with `(exit "$__sg_rc")`, never with a bare
  `exit`, because the tool shell may be persistent.
- Not wrapped, ever: heredocs, `&` backgrounding, process substitution,
  `sudo`, nested shells (`bash -c`), an existing redirect of stdout to a file,
  stdin redirects, negated commands, watch and list modes, and anything the
  splitter is not confident about. The pending record says why.
- The receipt id exists before the command runs, so the output can be joined
  to it even when the marker line is cut off. Compound commands with two
  runners get one marker each.

**Permissions.** On Claude Code the hook returns an `allow` decision for the
wrapped command only when the user's own permission rules already allow the
original one (the unfiltered form, without the dropped pipes). The mirror in
`harness/claude/permissions.ts` follows Claude Code's matching: split on the
compound operators, `Bash(x *)` and `Bash(x:*)` prefixes, wrappers such as
`timeout` and `nice` stripped, safe environment assignments stripped, built-in
read-only commands needing no rule. In `bypassPermissions`, `auto` and `plan`
modes no decision is returned. `permission: allow` in the config skips the
mirror; `permission: ask` never returns a decision. Codex accepts a rewrite
only together with an allow decision, so there the decision covers the
verification command itself and nothing else, and `ask` turns the rewrite off.

## Receipts

A receipt records what the runner said and how the command ended:

```json
{
  "id": "r-0017", "ts": "2026-09-02T14:02:11.318Z", "harness": "claude",
  "session": "5f1c...", "agent": null, "cwd": "/repo/packages/api",
  "cmd": "pnpm test", "source": "cd packages/api && pnpm test | tail -5",
  "runner": "pnpm test", "via": "vitest run", "category": "test", "scope": "all",
  "exit": 1, "verdict": "fail", "counts": { "passed": 41, "failed": 1 },
  "signal": "vitest-failed", "masked": false, "wrapped": true,
  "fingerprint": { "head": "a1b2c3", "tree": "9f...", "available": true, "ms": 12 },
  "log": "/home/me/.stalegreen/sessions/5f1c.../runs/r-0017.log"
}
```

`verdict` is decided by `parseOutput` with these rules, in this order:

1. Interrupted: inconclusive.
2. A known non-zero exit: fail. A harness that says "failed" without a number
   (Codex) counts the same.
3. A "not run" signal (no tests collected, no files matched): inconclusive.
4. Exit unknown: a fail marker in the output means fail. Otherwise, if the
   end of the output is visible (a `tail`, `cat`, `tee`, `|| true` or `;`
   chain), the runner's own summary decides (`summary-only`). A
   silent-success tool (typecheck, lint, build) with empty output through a
   visible pipe passes (`silent-through-pipe`). A trusted one-line summary
   survives a filter (`summary-line`). Anything else is `exit-unknown`.
5. Exit 0: a positive summary is a pass; a test run without a summary is
   `no-summary`; a fail-only or mixed signal is inconclusive rather than pass.

`pass` therefore needs the runner's own words or a known zero exit with
nothing negative; `fail` needs a fail marker or a known non-zero exit. A
receipt built from a masked, unwrapped run that says neither is
`inconclusive` and `masked`, which is what MASKED at Stop means.

### Rules learned from real sessions

The first replay of the author's sessions showed that the literal reading of
"masked can never pass" would have blocked almost every claim, because nearly
every verification run was piped. The rules below came from reviewing every
STALE, FAILED and MASKED verdict of a 180 day replay, and each is tested:

- **Attribution.** Output of a compound command is split between its runner
  segments at the anchors the command itself creates: the agent's `echo ===
  build ===` separators, package script banners (`> app@1.0 test`), and the
  runners' own headers. Test counts never attach to a typecheck receipt.
- **Exit recovery.** `pnpm test | tail -20; echo "exit: ${PIPESTATUS[0]}"`
  prints the exit status the pipe would have hidden; the receipt takes it.
  `$?` is only trusted when there is no pipe. Those status lines are stripped
  before the silence rule looks at the output, and an empty value (zsh has no
  `PIPESTATUS`) is tolerated.
- **Error searches.** `tsc 2>&1 | grep -c error` printing `0`, or `eslint . |
  grep error` printing nothing, is a result for typecheck, lint and build
  (`count-zero`, `count-nonzero`, `grep-empty`); a `grep -v error` is not.
  A `head` of at least three lines with no error line passes a typecheck or
  lint (`head-no-errors`), because those tools print findings first.
- **Read-back.** A run redirected to a file, followed in the same command or
  a later one by `cat`, `tail`, `head` or `grep` of that file, is visible
  after all; the read produces a derived receipt (`log-read`).
- **Short tails.** `tail -1` and `tail -2` can cut a multi-line summary in
  half, so they count as filters, where only one-line summaries survive.
- **Counts per category.** Comma numbers (`1,025 tests`) parse; a
  `25/25 PASS` next to health-check words is not a test count.

## Edit events

Edits come from the file tools (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`,
Codex `apply_patch` with one event per file in the patch) and from shell
commands. The shell side is judged by output where output matters:

- `sed -i`, `perl -pi`, `tee`, `mv`, `cp`, `rsync`, `rm`, `touch`, `ln`,
  `patch`, and redirects to anything but `/dev/null` are edits by shape.
- `git pull`, `merge`, `checkout`, `stash`, `rebase`, `cherry-pick` and
  `reset --hard` are edits only when their output says the tree changed;
  "Already up to date" and silence are not, and a negative marker wins over a
  positive one, because a compound command can carry a remote pull's
  "Fast-forward" text next to a local one that did nothing. `checkout -b`,
  `switch -c` and a plain `reset` never are.
- Formatters (`prettier --write`, `ruff format`, `black`) count when they say
  they reformatted something.
- Heredoc scripts count only when they visibly write files, and the paths
  they mention are recorded.
- Paths must look like code. Logs, `.out` and `.txt` files, temp and scratch
  directories, and anything under `~/.claude` never count unless inside the
  project.

## The fingerprint

The fingerprint is a content hash: the blob ids of every tracked file from
the git index, plus a fresh git blob hash of every modified or untracked
file, with documentation and other non-code paths excluded. It changes when
file content changes and it does not change on `git add` or `git commit`. The
original plan hashed `HEAD` plus the status and diff text; that turned fresh
evidence stale on every commit, which is the one moment an agent is most
likely to say "done".

It is computed at receipt time and again at Stop, inside the run's directory,
under a 150 ms budget (configurable); over budget, or outside git, it is
marked unavailable and the gate falls back to edit events after the receipt.
`compareFingerprints` yields `same`, `different` or `unknown`; only
`different` makes a claim stale, and `unknown` defers to edit events.

## The claim grammar

Input is the final assistant message. Fenced code, inline code and quoted
spans are never claims, except that a runner command in inline code becomes
its category noun so that "`npm test` passes" is still seen. Sentences are
then filtered:

- questions, imperatives addressed to the user, and anything with a
  conditional, future or planning marker (`should`, `will`, `once`, `let me`,
  `going to`, `need to`, `not yet`, `try`, `about to`, and a long list of
  their relatives);
- relayed statements ("according to", "CI is green", "the badge says", a
  matrix run elsewhere) since their evidence is not a local run;
- manual, supervised, smoke, browser and visual tests;
- negations and failure words unless negated themselves ("no failures");
- transitive or temporal uses of "builds" ("it builds the invoice", "while it
  builds").

What remains is matched per category, with the span, the sentence, the
scope (`all` for "all tests pass", `some` otherwise), any counts, and a tool
hint when the sentence names one ("ruff is clean" prefers ruff receipts).
Qualifiers in the same paragraph (`remaining`, `pre-existing`, `except`,
`only the known ... error`) mark the claim `qualified`: reported, never
blocked. "Everything is green" is an expanded claim held only to the
categories that were verified since the last edit, and only when the
paragraph talks about verification at all.

The extractor is measured against a labelled corpus of about 400 sentences
in ten forms and must stay at or above 0.98 precision and 0.90 recall on the
assertive ones; it currently scores 1.0 on both. Every false positive found
in a real session becomes a corpus entry.

## The gate

```
claims = extract(last_assistant_message)                       none -> allow
for each claim:
  r = latest receipt of that category (tool hint and scope respected)
  if none:                                    NONE     -> allow (strict: block)
  elif a background run is in flight:         DEFERRED -> allow
  elif r failed:                              FAILED   -> block
  elif r inconclusive and masked:             MASKED   -> block
  elif fingerprint differs, or edits after r
       when the fingerprint is unknown:       STALE    -> block
  else:                                       FRESH    -> allow
```

Receipt selection prefers the newest receipt, but an `all` claim is not
satisfied by a subset run, a newer failing subset contradicts an older full
pass, and a tool named in the claim narrows the candidates. A qualified claim
never blocks. In `advisory` policy every verdict is recorded and nothing is
blocked. The loop guard is keyed by the turn id (`prompt_id` on Claude Code,
`turn_id` on Codex) with `stop_hook_active` as the fallback.

Sessions are keyed by the root session id, with subagent transcripts joined
to their parent, so a subagent's test run is evidence for the parent's claim
and a subagent's own stop is judged under its own turn state.

## Harness adapters

| | Claude Code | Codex |
| --- | --- | --- |
| Shell tool | `Bash`, `tool_response` with `stdout`, `stderr`, `exit_code` | `Bash`, `tool_response` is the model-facing text, sometimes with a `Script completed` or `Exit code: N` header, usually without any exit status |
| Edit tools | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | `apply_patch` with the patch in `tool_input.command` |
| Background | `run_in_background`, resolved through `TaskOutput` or `BashOutput` | `Script running with cell ID N`, resolved through the `wait` tool |
| Rewrite | `updatedInput`, allow only when the permission mirror agrees | `updatedInput` requires `permissionDecision: allow` |
| Block | exit 2 with the message on stderr | `{"decision": "block", "reason": ...}` on stdout |
| Turn id | `prompt_id` | `turn_id` |
| Registration | `settings.json` or the plugin's `hooks/hooks.json` | `hooks.json`, trusted once through `/hooks` |

The transcript readers behind `history` and `stats` follow the same
shapes. Codex rollouts hold the shell commands inside JavaScript exec cells
(`await tools.exec_command({ cmd: "..." })`); the reader digs them out, and
because a cell completing says nothing about the command's exit, the exit is
unknown unless the cell printed it. Child threads are merged into their root.

## What was measured

`stalegreen stats` replays sessions through the exact same code path as the
live hooks, with the fingerprint marked unavailable, so its numbers describe
what the gate would have said. The README carries the output for the author's
own 180 days of sessions. Every STALE, FAILED and MASKED verdict behind those
numbers was read by hand; the rules in this document are what that review
produced.

## Non-goals

- Judging intent. Nothing here scores an agent or passes judgement on what it said.
- Replacing the runner's judgement. A pass is the runner's own summary, never
  an inference from silence alone, except for tools that are silent on
  success and only when the exit or the visible output supports it.
- Reading transcripts live. The transcript can lag the conversation at Stop,
  so the hooks rely on their own store and the readers are for retrospection.
- Network, telemetry, or any model call. The hook is one file, and the only
  process it starts is `git`.
