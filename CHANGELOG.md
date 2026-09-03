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
