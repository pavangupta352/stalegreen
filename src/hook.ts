/**
 * Hook entry point: `node dist/hook.js <harness> <event>` with the harness
 * payload on stdin. Any failure exits 0 so the agent is never broken by us.
 */

import { writeSync } from "node:fs";
import * as nodeModule from "node:module";
import { recordError } from "./core/store.js";
import { runClaudeHook, type HookOutcome } from "./harness/claude/hooks.js";
import { runCodexHook } from "./harness/codex/hooks.js";

// Node 22.1 and later can cache compiled code between runs, which trims the cold start.
try {
  const enable = (nodeModule as unknown as { enableCompileCache?: () => unknown }).enableCompileCache;
  if (typeof enable === "function") enable();
} catch {
  // best effort only
}

const STDIN_TIMEOUT_MS = 3000;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.resume();
  });
}

function emit(outcome: HookOutcome): never {
  if (outcome.stdout) writeSync(1, outcome.stdout);
  if (outcome.stderr) writeSync(2, outcome.stderr.endsWith("\n") ? outcome.stderr : `${outcome.stderr}\n`);
  process.exit(outcome.exit);
}

async function main(): Promise<void> {
  const harness = process.argv[2] ?? "";
  const event = process.argv[3] ?? "";
  let payload: unknown = null;
  try {
    const text = await readStdin();
    payload = text.trim() ? JSON.parse(text) : null;
  } catch (err) {
    recordError(`${harness}:${event}:stdin`, err);
    emit({ exit: 0 });
  }
  if (payload === null) emit({ exit: 0 });
  try {
    if (harness === "claude") emit(runClaudeHook(event, payload));
    if (harness === "codex") emit(runCodexHook(event, payload));
    emit({ exit: 0 });
  } catch (err) {
    recordError(`${harness}:${event}`, err);
    emit({ exit: 0 });
  }
}

void main();
