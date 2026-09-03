# stalegreen plugin for Claude Code

This directory is the Claude Code plugin: the manifest, the hook registration
and the compiled hook (`hook.js`, built from `../src` by `npm run build`).
It sits in its own directory so that installing the plugin never triggers a
dependency install; the hook has no dependencies.

Install from the repository's marketplace:

```
/plugin marketplace add pavangupta352/stalegreen
/plugin install stalegreen@stalegreen
```

The hooks registered are PreToolUse (unmask verification commands),
PostToolUse (receipts and edit events), Stop and SubagentStop (the freshness
gate). Configuration, the CLI and the full documentation are in the
repository README.
