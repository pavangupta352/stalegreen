# Codex hook payloads

Synthetic payloads in the shape Codex CLI 0.146 sends to command hooks
(captured from a scratch session on 2026-09-03 and anonymised; nothing here
comes from a real project). Facts these fixtures encode:

- Every event carries `session_id`, `turn_id`, `transcript_path` (null for
  ephemeral sessions), `cwd`, `hook_event_name`, `model` and
  `permission_mode` (`default`, `acceptEdits`, `plan`, `dontAsk` or
  `bypassPermissions`).
- The shell tool is `Bash` with `tool_input.command`; `tool_use_id` looks
  like `exec-<uuid>`.
- PostToolUse `tool_response` for `Bash` is the model-facing text: the raw
  output, or a header (`Exit code: N` or `Script completed`, `Wall time`,
  `Output:`) followed by it. A non-zero exit is not reported when the header
  is absent.
- File edits are `apply_patch` with the patch text in `tool_input.command`;
  its response starts with `Exit code: 0`.
- Stop carries `stop_hook_active` and `last_assistant_message`; a hook blocks
  with `{"decision":"block","reason":"..."}` on stdout or exit 2 with stderr.
- SubagentStop adds `agent_id`, `agent_type` and `agent_transcript_path`.
