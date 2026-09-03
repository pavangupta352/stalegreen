#!/usr/bin/env bash
# Plays the README demo: a real stalegreen store, real hook calls, a scripted
# agent. Run from the repository root after `npm run build`; docs/assets/demo.tape
# records it with vhs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/dist/hook.js"
WORK="$(mktemp -d)"
export STALEGREEN_HOME="$WORK/home"
REPO="$WORK/app"
mkdir -p "$REPO/src"
cd "$REPO"
git init -q
printf 'export const remaining = 1;\n' > src/hold.ts
printf 'node_modules\n' > .gitignore
git add -A && git -c user.name=demo -c user.email=demo@example.com commit -q -m init
printf '{ "fingerprintBudgetMs": 5000 }\n' > .stalegreen.json

SESSION="demo-session"
ts() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
say() { printf '%s\n' "$1"; }
agent() { printf '\033[1;36magent\033[0m  %s\n' "$1"; sleep "${2:-0.9}"; }
cmd() { printf '\033[2m$\033[0m %s\n' "$1"; sleep 0.5; }
hook() {
  local event="$1"
  local payload="$2"
  printf '%s' "$payload" | node "$HOOK" claude "$event" 2>"$WORK/err" || true
}
stop() {
  local message="$1"
  local promptId="$2"
  printf '%s' "{\"session_id\":\"$SESSION\",\"prompt_id\":\"$promptId\",\"cwd\":\"$REPO\",\"hook_event_name\":\"Stop\",\"stop_hook_active\":false,\"last_assistant_message\":$(printf '%s' "$message" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify(d)))')}" \
    | node "$HOOK" claude Stop 2>"$WORK/stop.err" && return 0
  printf '\033[1;31m'
  cat "$WORK/stop.err"
  printf '\033[0m'
  return 2
}
post_bash() {
  local command="$1" stdout="$2" exit="$3"
  local json
  json=$(S="$SESSION" R="$REPO" node -e '
    const [command, stdout, exit] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ session_id: process.env.S, prompt_id: "p1", cwd: process.env.R, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t" + Date.now(), tool_input: { command }, tool_response: { stdout, stderr: "", interrupted: false, exit_code: Number(exit) } }));
  ' "$command" "$stdout" "$exit")
  hook PostToolUse "$json"
}
post_edit() {
  local file="$1"
  hook PostToolUse "{\"session_id\":\"$SESSION\",\"prompt_id\":\"p1\",\"cwd\":\"$REPO\",\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Edit\",\"tool_use_id\":\"e1\",\"tool_input\":{\"file_path\":\"$file\",\"old_string\":\"1\",\"new_string\":\"0\"},\"tool_response\":{\"filePath\":\"$file\"}}"
}

PASS=$'\n RUN  v3.2.7 /app\n\n \xe2\x9c\x93 src/hold.test.ts (2 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)\n   Duration  312ms\n'
FAIL=$'\n RUN  v3.2.7 /app\n\n \xe2\x9d\xaf src/hold.test.ts (2 tests | 1 failed) 6ms\n   \xc3\x97 keeps the hold\n     AssertionError: expected 0 to be 1\n\n Test Files  1 failed (1)\n      Tests  1 failed | 1 passed (2)\n   Duration  330ms\n'

clear
agent "Running the tests first." 0.6
cmd "pnpm test"
printf '%s\n' "$PASS"
post_bash "pnpm test" "$PASS" 0
sleep 0.8
agent "Green. Now the change to the expiry logic."
cmd "edit src/hold.ts"
printf 'export const remaining = 0;\n' > src/hold.ts
post_edit "$REPO/src/hold.ts"
say '  - export const remaining = 1;'
say '  + export const remaining = 0;'
sleep 0.9
agent "Done. All tests pass." 0.4
printf '\n'
if ! stop "Done. All tests pass." "p1"; then :; fi
sleep 2.2
printf '\n'
agent "Rerunning." 0.5
cmd "pnpm test"
printf '%s\n' "$FAIL"
post_bash "pnpm test" "$FAIL" 1
sleep 0.9
agent "The hold test expects 1. Fixing the test to match the new expiry."
cmd "edit src/hold.test.ts"
printf 'export const expected = 0;\n' > src/hold.test.ts
post_edit "$REPO/src/hold.test.ts"
sleep 0.6
cmd "pnpm test"
printf '%s\n' "$PASS"
post_bash "pnpm test" "$PASS" 0
sleep 0.6
agent "All tests pass." 0.3
if stop "All tests pass." "p2"; then
  printf '\033[1;32m\xe2\x9c\x93 stalegreen: evidence is fresh, turn ends\033[0m\n'
fi
sleep 2.5
rm -rf "$WORK"
