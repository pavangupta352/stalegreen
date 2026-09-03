/**
 * The freshness gate: matches each claim to the latest receipt in its
 * category and decides FRESH, STALE, FAILED, MASKED, NONE or DEFERRED.
 */

import type { Config } from "./config.js";
import { compareFingerprints, pathIgnorer } from "./fingerprint.js";
import type { Category, Claim, EditEvent, Fingerprint, Receipt, Verdict, VerdictAction, VerdictKind } from "./grammar.js";
import { describeCounts, type DeferredRun } from "./receipts.js";

export interface GateInput {
  claims: Claim[];
  receipts: Receipt[];
  edits: EditEvent[];
  deferred: DeferredRun[];
  now: string;
  cwd: string;
  config: Config;
  fingerprintFor: (cwd: string) => Fingerprint;
  /** Categories already blocked in this turn; a second stop is allowed and recorded. */
  blockedThisTurn: Set<Category>;
}

/** Newest first; ties (same millisecond) keep the later record first. */
function latestFirst<T extends { ts: string }>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.ts < b.item.ts ? 1 : a.item.ts > b.item.ts ? -1 : b.index - a.index))
    .map((x) => x.item);
}

function evidenceOf(r: Receipt): NonNullable<Verdict["evidence"]> {
  return { receipt: r.id, cmd: r.cmd, runner: r.runner, verdict: r.verdict, counts: r.counts, ts: r.ts, cwd: r.cwd, scope: r.scope, masked: r.masked };
}

/** Picks the receipt that answers a claim, or null. */
export function selectReceipt(claim: Claim, receipts: Receipt[]): { receipt: Receipt | null; note?: string } {
  const categories = new Set<Category>([claim.category, ...(claim.alternates ?? [])]);
  let candidates = latestFirst(receipts.filter((r) => categories.has(r.category)));
  // "ruff clean" is about ruff runs even when a JavaScript linter ran later.
  if (claim.tool) {
    const named = candidates.filter((r) => `${r.runner} ${r.cmd} ${r.via ?? ""}`.toLowerCase().includes(claim.tool as string));
    if (named.length > 0) candidates = named;
  }
  if (candidates.length === 0) return { receipt: null };
  const latest = candidates[0] as Receipt;
  if (claim.scope === "some") return { receipt: latest };
  const latestAll = candidates.find((r) => r.scope === "all") ?? null;
  if (!latestAll) return { receipt: null, note: `latest run ${latest.id} (\`${latest.cmd}\`) covers a subset, not the whole suite` };
  // A newer failing subset contradicts an "all" claim even when an older full run passed.
  if (latest !== latestAll && latest.verdict === "fail") return { receipt: latest };
  return { receipt: latestAll };
}

/** File types whose edits can change a verification result. */
const CODE_EXT_RE = /\.(?:py|pyi|ts|tsx|mts|cts|js|jsx|mjs|cjs|go|rs|java|kt|kts|swift|rb|php|c|cc|cpp|h|hpp|cs|vue|svelte|sql|prisma|json|toml|yaml|yml|ini|cfg|sh|bash|zsh|css|scss|less|html|env|lock|graphql|gql|proto|ex|exs|dart|scala|elm|hs|zig|lua|pl|pm|r|m|mm|gradle|xml|tf|ipynb|erb|hbs|ejs|njk|astro|mdx|cmake|mk|nix|wxs|csproj|sln|fs|fsx|clj|cljs|edn|jl|nim|v|sv|vhd|mod|sum|txt\.in)$/i;
/** Files without an extension that still shape a build or a test run. */
const CODE_BARE_RE = /^(?:Makefile|GNUmakefile|Dockerfile|Rakefile|Gemfile|Justfile|Procfile|Brewfile|Podfile|Vagrantfile|Jenkinsfile|Earthfile|BUILD|WORKSPACE|Pipfile|Cargo|Containerfile|\.env|\.envrc|\.gitmodules|\.npmrc|\.nvmrc|\.node-version|\.python-version|\.ruby-version|\.tool-versions|\.babelrc|\.eslintrc|\.prettierrc|\.editorconfig|\.flake8|\.pylintrc|\.mocharc|\.swcrc)$/;

/** True when an edit to `path` can affect a verification run. `cwd` is the project the run belongs to. */
export function affectsVerification(path: string | null, ignore: (p: string) => boolean, cwd?: string): boolean {
  if (path === null) return true;
  const normalized = path.replace(/\\/g, "/");
  const name = normalized.split("/").pop() ?? normalized;
  if (ignore(name) || ignore(normalized)) return false;
  if (/\.(?:out|log|txt|tmp|bak|orig|rej|swp|pid|cache|snap)$/i.test(name)) return false;
  if (normalized.startsWith("/dev/")) return false;
  // Scratch files and the agent's own notes live outside the project.
  const insideProject = cwd !== undefined && cwd.length > 1 && normalized.startsWith(cwd.replace(/\\/g, "/").replace(/\/+$/, "") + "/");
  if (!insideProject && (/^\/(?:tmp|private\/tmp|private\/var|var\/folders|var\/tmp)\//.test(normalized) || /\/\.claude\/|\/scratchpad\//.test(normalized))) return false;
  if (CODE_BARE_RE.test(name)) return true;
  if (name.startsWith(".") && /^\.[^.]+\.(?:json|js|cjs|mjs|ts|yml|yaml|toml)$/.test(name)) return true;
  return CODE_EXT_RE.test(name);
}

function editsAfter(r: Receipt, edits: EditEvent[], config: Config, cwd: string): EditEvent[] {
  const ignore = pathIgnorer(config.fingerprintIgnore);
  return edits.filter((e) => e.ts > r.ts && affectsVerification(e.path, ignore, cwd)).sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

/** Evaluates every claim against the session's evidence. */
export function evaluate(input: GateInput): Verdict[] {
  const out: Verdict[] = [];
  const ttlMs = input.config.deferredTtlMinutes * 60_000;
  const nowMs = Date.parse(input.now);
  // For "everything green" claims: the round of checks since the last code edit is what "everything" means.
  const ignoreForEdits = pathIgnorer(input.config.fingerprintIgnore);
  const lastEditTs = input.edits.filter((e) => affectsVerification(e.path, ignoreForEdits, input.cwd)).reduce((acc, e) => (e.ts > acc ? e.ts : acc), "");
  const verifiedSinceEdit = lastEditTs !== "" && input.receipts.some((r) => r.ts > lastEditTs);
  for (const claim of input.claims) {
    const header = { category: claim.category, text: claim.text, scope: claim.scope, qualified: claim.qualified };
    const decide = (kind: VerdictKind, evidence: Verdict["evidence"], freshness: Verdict["freshness"], note?: string): Verdict => {
      const blocking = kind === "STALE" || kind === "FAILED" || kind === "MASKED" || (kind === "NONE" && input.config.strictNoEvidence && !evidence);
      let action: VerdictAction = "allowed";
      let finalNote = note;
      if (blocking) {
        if (claim.qualified) finalNote = [finalNote, "qualified claim, reported only"].filter(Boolean).join("; ");
        else if (input.config.policy === "advisory") action = "advisory";
        else if (input.blockedThisTurn.has(claim.category)) finalNote = [finalNote, "allowed_after_block"].filter(Boolean).join("; ");
        else action = "blocked";
      }
      const v: Verdict = { claim: header, evidence, freshness, verdict: kind, action };
      if (finalNote) v.note = finalNote;
      return v;
    };
    const noFreshness = { fingerprintMatch: null, editsAfter: [] as EditEvent[] };

    const pendingDeferred = input.deferred.find((d) => d.category === claim.category && nowMs - Date.parse(d.ts) < ttlMs);
    if (pendingDeferred) {
      out.push(decide("DEFERRED", null, noFreshness, `background run ${pendingDeferred.id} (\`${pendingDeferred.cmd}\`) has not reported yet`));
      continue;
    }

    const { receipt: r, note } = selectReceipt(claim, input.receipts);
    if (!r) {
      out.push(decide("NONE", null, noFreshness, note ?? "no verification run recorded in this session"));
      continue;
    }
    if (claim.expanded && verifiedSinceEdit && r.ts <= lastEditTs) {
      out.push(decide("NONE", evidenceOf(r), noFreshness, `not part of the checks run since the last edit (latest ${claim.category} run ${r.id} predates it)`));
      continue;
    }
    const evidence = evidenceOf(r);
    let countsNote: string | undefined;
    if (claim.counts?.passed !== undefined && r.counts.passed !== undefined && claim.counts.passed !== r.counts.passed) {
      countsNote = `counts_match: false (claim says ${claim.counts.passed}, run reported ${r.counts.passed})`;
    }
    if (r.verdict === "fail") {
      const newerSubsets = input.receipts.filter((x) => x.category === r.category && x.ts > r.ts && x.scope === "subset" && x.verdict === "pass").length;
      const subsetNote = newerSubsets > 0 ? `${newerSubsets} later subset run${newerSubsets === 1 ? "" : "s"} passed but did not cover the whole suite` : undefined;
      out.push(decide("FAILED", evidence, noFreshness, [countsNote, subsetNote].filter(Boolean).join("; ") || undefined));
      continue;
    }
    if (r.verdict === "inconclusive") {
      if (r.masked) out.push(decide("MASKED", evidence, noFreshness, r.maskReason ? `masked by ${r.maskReason}` : "result not recorded"));
      else out.push(decide("NONE", evidence, noFreshness, `latest run ${r.id} is inconclusive (${r.signal ?? "no signal"})`));
      continue;
    }
    const now = input.fingerprintFor(r.cwd);
    const cmp = compareFingerprints(r.fingerprint, now);
    const later = editsAfter(r, input.edits, input.config, input.cwd);
    if (cmp === "different") {
      out.push(decide("STALE", evidence, { fingerprintMatch: false, editsAfter: later }, countsNote));
      continue;
    }
    if (cmp === "same") {
      out.push(decide("FRESH", evidence, { fingerprintMatch: true, editsAfter: [] }, countsNote));
      continue;
    }
    if (later.length > 0) {
      out.push(decide("STALE", evidence, { fingerprintMatch: null, editsAfter: later }, countsNote));
      continue;
    }
    out.push(decide("FRESH", evidence, { fingerprintMatch: null, editsAfter: [] }, countsNote));
  }
  return out;
}

function clock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function shortPath(path: string, cwd: string): string {
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

const CATEGORY_WORD: Record<Category, string> = { test: "the tests", typecheck: "the typecheck", lint: "the linter", build: "the build" };

function receiptLabel(v: Verdict, cwd: string): string {
  const e = v.evidence;
  if (!e) return "";
  const counts = describeCounts(e.counts);
  const where = e.cwd && e.cwd !== cwd ? ` in ${shortPath(e.cwd, cwd)}` : "";
  const parts = [`\`${e.cmd}\``, e.runner !== "unknown" && !e.cmd.includes(e.runner) ? e.runner : null, counts || null, clock(e.ts)].filter(Boolean);
  return `Receipt ${e.receipt} (${parts.join(", ")})${where}`;
}

/** Formats the message the agent sees when a stop is blocked. */
export function formatBlockMessage(verdicts: Verdict[], cwd: string): string {
  const blocks: string[] = [];
  for (const v of verdicts) {
    const claim = `"${v.claim.text}"`;
    const cmd = v.evidence?.cmd;
    const rerun = cmd ? `Rerun \`${cmd}\`` : `Run ${CATEGORY_WORD[v.claim.category]}`;
    if (v.verdict === "STALE") {
      const edits = v.freshness.editsAfter;
      const shown = edits.slice(0, 6).map((e) => `${e.path ? shortPath(e.path, cwd) : e.kind} (${clock(e.ts)})`);
      const more = edits.length > 6 ? `, and ${edits.length - 6} more` : "";
      const lines = [`stalegreen: ${claim} is stale. ${receiptLabel(v, cwd)} predates ${edits.length > 0 ? `${edits.length} later edit${edits.length === 1 ? "" : "s"}:` : "later changes to the working tree."}`];
      if (shown.length > 0) lines.push(`  ${shown.join(", ")}${more}`);
      lines.push(`${rerun} and report the result, or state explicitly that ${CATEGORY_WORD[v.claim.category].replace("the ", "the ")} were not rerun after these edits.`);
      blocks.push(lines.join("\n"));
    } else if (v.verdict === "FAILED") {
      const e = v.evidence;
      const exit = e && typeof (e as { exit?: number }).exit === "number" ? "" : "";
      blocks.push(
        [
          `stalegreen: ${claim} does not match the latest run. ${receiptLabel(v, cwd)} failed${exit}.`,
          `Fix the failure and ${rerun.charAt(0).toLowerCase() + rerun.slice(1)}, or report the failure instead of a pass.`,
        ].join("\n"),
      );
    } else if (v.verdict === "MASKED") {
      const reason = v.note?.replace(/^masked by /, "") ?? "a pipe";
      blocks.push(
        [
          `stalegreen: ${claim} has no recorded result. ${receiptLabel(v, cwd)} was run with ${describeMask(reason)}, so the exit status and summary were not recorded.`,
          `${rerun.replace(/^Rerun `(.*)`$/, "Run `$1`")} without the pipe or suffix so the result is recorded, then report it.`,
        ].join("\n"),
      );
    } else if (v.verdict === "NONE") {
      blocks.push(`stalegreen: ${claim} has no verification run in this session${v.note ? ` (${v.note})` : ""}. ${rerun} and report the result.`);
    }
  }
  return blocks.join("\n\n");
}

function describeMask(reason: string): string {
  const parts = reason.split(",").map((r) => r.trim());
  const words = parts.map((p) => {
    if (p.startsWith("pipe:")) return `a pipe into ${p.slice(5)}`;
    if (p === "or-chain") return "an `||` suffix";
    if (p === "semicolon") return "a `;` chain";
    if (p.startsWith("devnull")) return "output sent to /dev/null";
    if (p.startsWith("redirect:")) return `output redirected to ${p.slice(9)}`;
    if (p === "negated") return "a leading `!`";
    return p;
  });
  return words.join(" and ");
}
