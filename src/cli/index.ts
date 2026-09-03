/**
 * The stalegreen command line.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stalegreenHome } from "../core/config.js";
import type { Verdict } from "../core/grammar.js";
import { describeCounts, readReceipts, readVerdicts, runLogPath } from "../core/receipts.js";
import { listSessions, readJsonl } from "../core/store.js";
import { VERSION } from "../version.js";
import { DEFAULT_HISTORY, runHistory } from "./history.js";
import { HOOK_EVENTS, hookStatus, installHooks, uninstallHooks, type HarnessName } from "./install.js";
import { parseHarnessChoice } from "./sessions.js";
import { DEFAULT_STATS, runStats } from "./stats.js";

const HELP = `stalegreen ${VERSION}

Keeps a coding agent's green claims honest: verification runs are recorded
unmasked, and "done" is blocked when the evidence is stale, failed or masked.

Usage:
  stalegreen install --claude|--codex|--all [--project] [--advisory]
                                                         register the hooks (Claude Code settings, Codex hooks.json)
  stalegreen uninstall --claude|--codex|--all [--project] remove them
  stalegreen check [--session <id>] [--json]             claims and evidence for the current or last session
  stalegreen receipt <id> [--session <id>]               a run's receipt and the tail of its log
  stalegreen history [--since 30d] [--harness claude|codex|all] [--include-none] [--all-messages] [--explain] [--json] [--limit N]
                                                         replay past sessions: stale, failed and masked claims
  stalegreen stats [--since 90d] [--harness claude|codex|all] [--json]
                                                         stale, failed, masked and unbacked claim rates and the
                                                         hidden-exit rate of verification runs, per harness and model
  stalegreen doctor                                      hooks, node, store health and the last verdicts
  stalegreen --version
  stalegreen --help

Store: ${stalegreenHome()}
`;

interface Args {
  command: string | null;
  positional: string[];
  flags: Map<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(["json", "help", "version", "prune", "advisory", "all", "include-none", "include-fresh", "all-messages", "explain", "claude", "codex", "dsh", "project", "user"]);

function parseArgs(argv: string[]): Args {
  const args: Args = { command: null, positional: [], flags: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) args.flags.set(name, a.slice(eq + 1));
      else if (!BOOLEAN_FLAGS.has(name) && argv[i + 1] && !(argv[i + 1] as string).startsWith("-")) {
        args.flags.set(name, argv[i + 1] as string);
        i++;
      } else args.flags.set(name, true);
    } else if (a.startsWith("-") && a.length === 2) {
      args.flags.set(a.slice(1), true);
    } else if (args.command === null) args.command = a;
    else args.positional.push(a);
  }
  return args;
}

function resolveSession(flag: string | true | undefined): string | null {
  if (typeof flag === "string" && flag.length > 0) return flag;
  const sessions = listSessions();
  return sessions[0]?.root ?? null;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function clock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatVerdict(v: Verdict): string {
  const e = v.evidence;
  const evidence = e ? `${e.receipt} \`${e.cmd}\` ${e.verdict}${describeCounts(e.counts) ? ` (${describeCounts(e.counts)})` : ""} ${clock(e.ts)}` : "no receipt";
  const extra = v.freshness.editsAfter.length > 0 ? ` +${v.freshness.editsAfter.length} edit${v.freshness.editsAfter.length === 1 ? "" : "s"} after` : "";
  return `${pad(v.verdict, 9)} ${pad(v.action, 9)} ${pad(v.claim.category, 10)} "${v.claim.text}"  <-  ${evidence}${extra}${v.note ? `  [${v.note}]` : ""}`;
}

function cmdCheck(args: Args): number {
  const root = resolveSession(args.flags.get("session"));
  if (!root) {
    console.log("No sessions recorded yet. Install the hooks and run a verification command first.");
    return 0;
  }
  const receipts = readReceipts(root);
  const verdicts = readVerdicts(root);
  if (args.flags.get("json")) {
    console.log(JSON.stringify({ session: root, receipts, verdicts }, null, 2));
    return 0;
  }
  console.log(`Session ${root}`);
  console.log("");
  console.log(`Receipts (${receipts.length}):`);
  for (const r of receipts.slice(-20)) {
    const how = r.masked ? "masked " : r.wrapped ? "wrapped" : "plain  ";
    console.log(`  ${pad(r.id, 7)} ${clock(r.ts)} ${pad(r.category, 10)} ${pad(r.verdict, 13)} ${pad(r.scope, 7)} ${how} \`${r.cmd}\`${describeCounts(r.counts) ? `  ${describeCounts(r.counts)}` : ""}`);
  }
  if (receipts.length === 0) console.log("  none");
  console.log("");
  const last = verdicts.slice(-5);
  console.log(`Verdicts (last ${last.length} of ${verdicts.length}):`);
  for (const rec of last) {
    console.log(`  ${clock(rec.ts)} ${rec.event}${rec.agent ? ` [${rec.agent}]` : ""} ${rec.blocked ? "BLOCKED" : "allowed"}`);
    for (const v of rec.verdicts) console.log(`    ${formatVerdict(v)}`);
  }
  if (verdicts.length === 0) console.log("  none");
  return 0;
}

function cmdReceipt(args: Args): number {
  const id = args.positional[0];
  if (!id) {
    console.error("usage: stalegreen receipt <id> [--session <id>]");
    return 2;
  }
  const root = resolveSession(args.flags.get("session"));
  if (!root) {
    console.error("No sessions recorded yet.");
    return 1;
  }
  const receipt = readReceipts(root).find((r) => r.id === id);
  if (!receipt) {
    console.error(`No receipt ${id} in session ${root}.`);
    return 1;
  }
  console.log(JSON.stringify(receipt, null, 2));
  const log = receipt.log ?? runLogPath(root, id);
  if (existsSync(log)) {
    const lines = readFileSync(log, "utf8").split("\n");
    console.log("");
    console.log(`Log tail (${log}):`);
    for (const l of lines.slice(-40)) console.log(`  ${l}`);
  }
  return 0;
}

function cmdDoctor(): number {
  const home = stalegreenHome();
  let problems = 0;
  console.log(`stalegreen ${VERSION}`);
  console.log(`node ${process.version}${Number(process.versions.node.split(".")[0]) >= 20 ? "" : "  (needs 20 or newer)"}`);
  console.log(`store ${home}${existsSync(home) ? "" : " (not created yet)"}`);
  for (const harness of ["claude", "codex"] as const) {
    for (const scope of ["user", "project"] as const) {
      const s = hookStatus(harness, scope, process.cwd());
      const events = HOOK_EVENTS[harness];
      const present = events.filter((e) => s.events[e.event]).map((e) => e.event);
      if (present.length === 0) {
        console.log(`${harness} ${scope} hooks: not installed (${s.settingsFile})`);
        continue;
      }
      const missing = events.filter((e) => !s.events[e.event]).map((e) => e.event);
      console.log(`${harness} ${scope} hooks: ${present.join(", ")}${missing.length ? `  missing: ${missing.join(", ")}` : ""} (${s.settingsFile})`);
      if (missing.length) problems++;
      if (!s.hookExists) {
        console.log(`  hook file missing: ${s.hookPath ?? "?"}  (run \`stalegreen install --${harness}\`)`);
        problems++;
      } else if (s.installedVersion && s.installedVersion !== VERSION) {
        console.log(`  hook file is version ${s.installedVersion}, CLI is ${VERSION}  (run \`stalegreen install --${harness}\` to update)`);
      }
    }
  }
  const errors = readJsonl<{ ts: string; event: string; error: string }>(join(home, "errors.jsonl"));
  console.log(`hook errors recorded: ${errors.length}`);
  for (const e of errors.slice(-3)) console.log(`  ${e.ts} ${e.event}: ${e.error}`);
  const sessions = listSessions();
  console.log(`sessions: ${sessions.length}`);
  const latest = sessions[0];
  if (latest) {
    const receipts = readReceipts(latest.root);
    const verdicts = readVerdicts(latest.root);
    console.log(`latest session ${latest.root}: ${receipts.length} receipts, ${verdicts.length} stop verdicts`);
    for (const rec of verdicts.slice(-5)) for (const v of rec.verdicts) console.log(`  ${clock(rec.ts)} ${formatVerdict(v)}`);
  }
  return problems > 0 ? 1 : 0;
}

function cmdInstall(args: Args, remove: boolean): number {
  const harnesses: HarnessName[] = [];
  if (args.flags.has("claude") || args.flags.has("all")) harnesses.push("claude");
  if (args.flags.has("codex") || args.flags.has("all")) harnesses.push("codex");
  if (harnesses.length === 0) {
    console.error(`usage: stalegreen ${remove ? "uninstall" : "install"} --claude|--codex|--all [--project]${remove ? "" : " [--advisory]"}`);
    return 2;
  }
  const scope = args.flags.has("project") ? "project" : "user";
  try {
    for (const harness of harnesses) {
      if (remove) {
        const r = uninstallHooks(harness, { scope, cwd: process.cwd() });
        console.log(r.removed > 0 ? `Removed ${r.removed} stalegreen hook entries from ${r.settingsFile}` : `No stalegreen hooks in ${r.settingsFile}`);
        continue;
      }
      const r = installHooks(harness, { scope, cwd: process.cwd() });
      console.log(`Hook installed at ${r.hookPath}`);
      console.log(`Registered PreToolUse, PostToolUse, Stop and SubagentStop in ${r.settingsFile}${r.replaced ? ` (replaced ${r.replaced} older entries)` : ""}`);
      if (harness === "claude") {
        console.log("New Claude Code sessions pick this up automatically; a running session reloads hooks when its settings change.");
      } else {
        console.log("Codex asks you to review new hooks once: open Codex, run /hooks and trust the stalegreen entries.");
        console.log("For `codex exec`, pass --dangerously-bypass-hook-trust or trust them from an interactive session first.");
      }
    }
    if (remove) return 0;
    if (args.flags.has("advisory")) {
      const file = join(stalegreenHome(), "config.json");
      let cfg: Record<string, unknown> = {};
      try {
        if (existsSync(file)) cfg = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      } catch {
        cfg = {};
      }
      cfg.policy = "advisory";
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
      console.log(`Policy set to advisory in ${file} (verdicts are recorded, nothing is blocked).`);
    }
    console.log("Run `stalegreen doctor` to confirm, and `stalegreen check` after your next verification run.");
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function cmdHistory(args: Args): Promise<number> {
  const since = args.flags.get("since");
  const limit = args.flags.get("limit");
  const session = args.flags.get("session");
  const harness = parseHarnessChoice(args.flags.get("harness"));
  if (args.flags.has("harness") && harness === null) {
    console.error("--harness takes claude, codex or all");
    return Promise.resolve(2);
  }
  return runHistory({
    ...DEFAULT_HISTORY,
    harness: harness ?? DEFAULT_HISTORY.harness,
    since: typeof since === "string" ? since : DEFAULT_HISTORY.since,
    includeNone: args.flags.has("include-none"),
    includeFresh: args.flags.has("include-fresh") || args.flags.has("all"),
    allMessages: args.flags.has("all-messages"),
    json: args.flags.has("json"),
    explain: args.flags.has("explain"),
    limit: typeof limit === "string" ? Number(limit) || 0 : 0,
    session: typeof session === "string" ? session : null,
  });
}

function cmdStats(args: Args): Promise<number> {
  const since = args.flags.get("since");
  const limit = args.flags.get("limit");
  const harness = parseHarnessChoice(args.flags.get("harness"));
  if (args.flags.has("harness") && harness === null) {
    console.error("--harness takes claude, codex or all");
    return Promise.resolve(2);
  }
  return runStats({
    ...DEFAULT_STATS,
    harness: harness ?? DEFAULT_STATS.harness,
    since: typeof since === "string" ? since : DEFAULT_STATS.since,
    json: args.flags.has("json"),
    allMessages: args.flags.has("all-messages"),
    limit: typeof limit === "string" ? Number(limit) || 0 : 0,
  });
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.has("version") || args.flags.has("v")) {
    console.log(VERSION);
    return 0;
  }
  if (args.command === null || args.flags.has("help") || args.flags.has("h") || args.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  switch (args.command) {
    case "check":
      return cmdCheck(args);
    case "receipt":
      return cmdReceipt(args);
    case "history":
      return cmdHistory(args);
    case "stats":
      return cmdStats(args);
    case "doctor":
      return cmdDoctor();
    case "install":
      return cmdInstall(args, false);
    case "uninstall":
      return cmdInstall(args, true);
    default:
      console.error(`Unknown command: ${args.command}`);
      process.stdout.write(HELP);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
