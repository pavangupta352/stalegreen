# Changelog

All notable changes to stalegreen are recorded here. The format follows
Keep a Changelog, and the project uses semantic versioning.

## Unreleased

### Added

- Runner catalog covering test, typecheck, lint and build commands for the
  JavaScript, Python, Go, Rust, JVM, .NET, Ruby, PHP, Elixir, Swift, Dart and
  C/C++ ecosystems, with pass and fail fixtures for every runner.
- Claim grammar with a labelled corpus of 350 sentences; assertive claims are
  matched to a category and a scope, hedged, future, negated, quoted, relayed
  and question forms are ignored, and scoped claims are reported but never
  blocked.
- Receipts for every verification run, with counts, exit status, masking
  analysis and a working-tree fingerprint that survives `git commit`.
- Edit events from the file tools and from shell commands that change files.
- Freshness gate for Claude Code (Stop and SubagentStop) that blocks a green
  claim when its evidence is stale, failed or masked, with a loop guard so a
  claim is blocked at most once per turn.
- `stalegreen check`, `stalegreen receipt` and `stalegreen doctor`.
- `stalegreen history`: replays past Claude Code sessions (main transcript
  and subagents, streamed) through the receipt builder and the gate and lists
  the claims whose evidence was stale, failed or masked, with `--explain` for
  the receipt, the command and the sentence behind each one.
- `stalegreen stats`: stale, failed, masked and unbacked claim rates and the
  hidden-exit rate of verification runs over a window, per model and per
  session kind. Sessions without tool calls are excluded and a status line
  repeated word for word within a session is counted once per verdict.
- The unmask rewrite: the PreToolUse hook wraps verification commands in
  POSIX sh so the full output is logged, the tail is shown, an explicit
  `[stalegreen] exit=<code> receipt=<id>` marker is printed and the exit
  status is preserved. Filter pipes such as `| tail -5` and `| grep` are
  dropped, `tee` targets are kept, and heredocs, backgrounding, process
  substitution, `sudo`, nested shells, redirects and watch modes are left
  untouched. Tested against 210 commands under sh, bash and zsh.
- Permission-aware rewriting: the hook returns `permissionDecision: "allow"`
  only when the user's own Claude Code rules already allow the original
  command, so wrapping never widens permissions (`permission` setting:
  `inherit`, `allow` or `ask`).
- `stalegreen install --claude` and `uninstall --claude`, with `--project`
  and `--advisory`; `doctor` reports the registered hooks.
