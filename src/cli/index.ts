/**
 * The stalegreen command line.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stalegreenHome } from "../core/config.js";
import type { Receipt, Verdict } from "../core/grammar.js";
import { describeCounts, readReceipts, readVerdicts, runLogPath } from "../core/receipts.js";
import { listSessions, readJsonl, sessionDir } from "../core/store.js";
import { VERSION } from "../version.js";

const HELP = `stalegreen ${VERSION}

Keeps a coding agent's green claims honest: verification runs are recorded
unmasked, and "done" is blocked when the evidence is stale, failed or masked.

Usage:
  stalegreen check [--session <id>] [--json]     claims and evidence for the current or last session
  stalegreen receipt <id> [--session <id>]        print a run's receipt and the tail of its log
  stalegreen doctor                               store health and the last verdicts
  stalegreen --version
  stalegreen --help

Store: ${stalegreenHome()}
`;

interface Args {
  command: string | null;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: null, positional: [], flags: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) args.flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (argv[i + 1] && !(argv[i + 1] as string).startsWith("-") && !["json", "help", "version", "prune", "advisory", "all", "include-none"].includes(a.slice(2))) {
        args.flags.set(a.slice(2), argv[i + 1] as string);
        i++;
      } else args.flags.set(a.slice(2), true);
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
    console.log(`  ${pad(r.id, 7)} ${clock(r.ts)} ${pad(r.category, 10)} ${pad(r.verdict, 13)} ${pad(r.scope, 7)} ${r.masked ? "masked " : r.wrapped ? "wrapped" : "plain  "} \`${r.cmd}\`${describeCounts(r.counts) ? `  ${describeCounts(r.counts)}` : ""}`);
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
    const tail = lines.slice(-40);
    console.log("");
    console.log(`Log tail (${log}):`);
    for (const l of tail) console.log(`  ${l}`);
  }
  return 0;
}

function cmdDoctor(): number {
  const home = stalegreenHome();
  console.log(`stalegreen ${VERSION}`);
  console.log(`node ${process.version}`);
  console.log(`store ${home}${existsSync(home) ? "" : " (not created yet)"}`);
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
  return 0;
}

export function main(argv: string[]): number {
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
    case "doctor":
      return cmdDoctor();
    default:
      console.error(`Unknown command: ${args.command}`);
      process.stdout.write(HELP);
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
