# Security

stalegreen runs as a hook inside coding agents and rewrites shell commands
before they execute, so its own behaviour deserves scrutiny. Here is what it
does and does not do.

- It never makes network calls and sends no telemetry.
- It only rewrites commands it recognises as verification runners, and the
  rewrite wraps the original command text unchanged inside a POSIX group. It
  never adds `sudo`, never changes arguments, and never runs when it cannot
  read the command with confidence.
- It never widens permissions. A wrapped command gets an `allow` decision only
  when the user's own permission rules already allow the original command.
- It writes only under `~/.stalegreen/` (or `$STALEGREEN_HOME`): receipts,
  edit events, verdicts and run logs. Run logs contain the output of your own
  test, lint, typecheck and build commands, so treat that directory like any
  other local log directory.

## Reporting a vulnerability

Email pavan.gupta.352@gmail.com with a description and, if you can, a
reproduction. Please do not open a public issue for anything that could let a
command escape the wrapper, escalate permissions, or read files it should not.
You will get a reply within three days and a fix or a plan within two weeks.

Supported versions: the latest minor release.
