# Changelog

All notable changes to stalegreen are recorded here. The format follows
Keep a Changelog, and the project uses semantic versioning.

## 0.1.0 (2026-09-03)

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
- `stalegreen check`, `stalegreen receipt` and `stalegreen doctor`, with
  `doctor --prune` removing sessions older than the configured window.
- `stalegreen history`: replays past Claude Code sessions (main transcript
  and subagents, streamed) through the receipt builder and the gate and lists
  the claims whose evidence was stale, failed or masked, with `--explain` for
  the receipt, the command and the sentence behind each one.
- `stalegreen stats`: stale, failed, masked and unbacked claim rates and the
  hidden-exit rate of verification runs over a window, per harness, per
  model and per session kind. Sessions without tool calls are excluded and a
  status line repeated word for word within a session is counted once per
  verdict.
- Codex support: `install --codex` writes the same four hooks to
  `~/.codex/hooks.json` (or the repository's `.codex/hooks.json`). The Codex
  adapter reads the `Bash` and `apply_patch` tools, the `Script completed`,
  `Script failed` and `Script running with cell ID` headers, finishes a
  still-running command from the `wait` tool's output, returns the rewrite
  with the allow decision Codex requires, and blocks at Stop with
  `{"decision":"block","reason":...}`. The rollout reader behind `history`
  and `stats` merges child threads into their parent and reads the shell
  commands out of Codex's JavaScript exec cells.
- The hook handlers are shared across harnesses through a small adapter
  (turn id, shell output shape, edit tools, allow decision, block format).
- DeepSeek Harness support: a `dsh` adapter (`runDshHook`) that reads the
  bash tool's `[exit code: N]` marker and the `edit`, `write` and
  `str_replace_editor` tools, and `dsh-plugin-stalegreen`, a Cordis plugin
  package in this repository that mounts the gate on `tools/pre-execute`,
  `tools/post-execute` and `agent/turn-stopping` and steers one correction
  step when a claim is stale, failed or masked.
- `stalegreen redact`: a shareable copy of a session (receipts, edits,
  verdicts, pending and deferred runs, the tail of each log) with paths
  shortened, secrets masked and the agent's prose replaced by the matched
  claim. The false-block issue template asks for it.
- A release workflow that publishes to npm through trusted publishing on a
  version tag and creates the GitHub release. CI runs the suite on Ubuntu and
  macOS with Node 20 and 22, and the pure-logic tests on Windows, where hook
  paths and report paths are written with forward slashes.
- Claude Code plugin packaging: `plugin/` holds the manifest, the hook
  registration (`${CLAUDE_PLUGIN_ROOT}/hook.js`) and a copy of the compiled
  hook that `npm run build` refreshes and a test keeps identical to the
  build; `.claude-plugin/marketplace.json` at the repository root serves it
  through `/plugin marketplace add pavangupta352/stalegreen`. The plugin
  lives in its own directory so that installing it never triggers a
  dependency install.
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
