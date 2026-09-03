/**
 * Stable shapes shared by the hooks, the CLI and the library entry.
 *
 * Every verdict serialises to the `Verdict` shape below so other tools can
 * consume it without knowing anything about how it was produced.
 */

export type Category = "test" | "typecheck" | "lint" | "build";
export const CATEGORIES: readonly Category[] = ["test", "typecheck", "lint", "build"];

export type RunVerdict = "pass" | "fail" | "inconclusive";
export type RunScope = "all" | "subset";
export type Harness = "claude" | "codex" | "dsh";

export interface Counts {
  passed?: number;
  failed?: number;
  errors?: number;
  skipped?: number;
  total?: number;
}

/** Working-tree fingerprint. `tree` is a content hash that survives commits. */
export interface Fingerprint {
  head: string | null;
  tree: string | null;
  available: boolean;
  reason?: string;
  ms?: number;
}

export interface Receipt {
  id: string;
  ts: string;
  harness: Harness;
  session: string;
  agent: string | null;
  cwd: string;
  /** The runner segment, for example `pnpm test`. */
  cmd: string;
  /** The full command as the agent issued it. */
  source: string;
  runner: string;
  category: Category;
  scope: RunScope;
  exit: number | null;
  verdict: RunVerdict;
  counts: Counts;
  /** Name of the parser signal that decided the verdict, for `--explain`. */
  signal: string | null;
  masked: boolean;
  maskReason?: string;
  wrapped: boolean;
  unwrapped?: string;
  quiet?: boolean;
  background?: boolean;
  interrupted?: boolean;
  fingerprint: Fingerprint;
  log: string | null;
  toolUseId?: string;
  /** The file a redirected run wrote to; a later read of it supplies the missing output. */
  logFile?: string;
}

export interface EditEvent {
  ts: string;
  path: string | null;
  kind: string;
  agent?: string | null;
}

export type ClaimScope = "all" | "some";

export interface Claim {
  category: Category;
  /** The matched span, for example `all 41 tests pass`. */
  text: string;
  /** The sentence the span was found in, trimmed. */
  sentence: string;
  scope: ClaimScope;
  /** Scope words such as "remaining" or "pre-existing" in the same paragraph. */
  qualified: boolean;
  counts?: Counts;
  /** Receipts in these categories also satisfy the claim, for example a typecheck receipt for "compiles cleanly". */
  alternates?: Category[];
}

export type VerdictKind = "FRESH" | "STALE" | "FAILED" | "MASKED" | "NONE" | "DEFERRED";
export type VerdictAction = "blocked" | "allowed" | "advisory";

export interface VerdictEvidence {
  receipt: string;
  cmd: string;
  runner: string;
  verdict: RunVerdict;
  counts: Counts;
  ts: string;
  cwd: string;
  scope: RunScope;
  masked: boolean;
}

export interface VerdictFreshness {
  fingerprintMatch: boolean | null;
  editsAfter: EditEvent[];
}

export interface Verdict {
  claim: { category: Category; text: string; scope: ClaimScope; qualified: boolean };
  evidence: VerdictEvidence | null;
  freshness: VerdictFreshness;
  verdict: VerdictKind;
  action: VerdictAction;
  note?: string;
}
