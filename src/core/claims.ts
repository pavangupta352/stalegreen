/**
 * Claim grammar: finds assertive "green" claims in an agent's final message.
 *
 * The extractor is deliberately conservative. Text inside code fences, inline
 * code and quotation marks never yields a claim. Questions, instructions to
 * the user, hedged or future statements, relayed statements attributed to
 * someone else, and sentences that mention an unnegated failure are dropped.
 * Scope words such as "remaining" or "except" mark a claim as qualified:
 * qualified claims are reported but never block.
 */

import type { Category, Claim, ClaimScope, Counts } from "./grammar.js";
import { detect } from "./runners.js";

const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const DOUBLE_QUOTE_RE = /(^|[\s(\[:,])["“][^"”\n]{1,120}["”](?=[\s.,;:!?)\]]|$)/g;
const SINGLE_QUOTE_RE = /(^|[\s(\[:,])['‘][^'’\n]{1,80}['’](?=[\s.,;:!?)\]]|$)/g;
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+|\n+/;
const UNCHECKED_TODO_RE = /^\s*(?:[-*+]\s*)?\[ \]/;
/** List markers, quote markers and check marks at the start of a line. Numbers are kept unless they are list numbering. */
const LEADING_NOISE_RE = /^(?:[\s\-*+>#|✓✔✅•·]+|\d+[.)]\s+)+/;

/** Numbers as agents write them: 41, 1,025, 7542. */
const NUM = "\\d{1,3}(?:,\\d{3})+|\\d+";

/** Conditional, future, planning or instruction context anywhere in the sentence. */
const CONDITIONAL_WORDS = [
  "as soon as", "gates? (?:deploys?|merges?|releases?) on", "depends on", "conditional on", "on tests? passing", "only when", "only if",
  "make sure", "makes sure", "making sure", "ensure", "ensuring", "ensures", "until", "once", "if", "unless", "should", "will", "would", "could", "might", "may",
  "need(?:s|ed)? to", "must", "so that", "when", "whenever", "whether", "verify(?:ing)? (?:that|if|whether)", "to verify", "check(?:ed|ing|s)? (?:that|if|whether)", "to check",
  "confirm(?:ing)? (?:that|if|whether)", "to confirm", "expect(?:s|ed|ing)?", "assum(?:e|es|ing)", "let'?s", "let me", "going to", "gonna", "want(?:s|ed)?", "hope(?:fully)?",
  "please", "can you", "goal", "todo", "to-do", "next steps?", "re-?run(?:ning)?", "try(?:ing)?", "plan(?:ning|s)?", "step \\d", "criteria", "requirement", "acceptance", "definition of done",
  "not yet", "haven'?t", "hasn'?t", "hadn'?t", "you said", "you asked", "the user", "instructions?", "requires?", "required", "guarantee", "blocked", "blocker", "only after",
  "after (?:you|that|this)", "believe", "think", "presumably", "probably", "likely", "appears?", "seems?", "looks? like", "supposedly", "supposed to", "allegedly", "reportedly", "in theory",
  "working on", "in progress", "wip", "not sure", "unsure", "unclear", "not certain", "double[- ]check", "sanity[- ]check", "to be safe", "to see if", "and see", "still (?:need|have) to",
  "waiting (?:for|on)", "pending", "then (?:run|re-?run|verify|check)", "before (?:merging|committing|shipping|release)", "about to", "am going", "i'?m going",
];
const CONDITIONAL_RE = new RegExp(`\\b(?:${CONDITIONAL_WORDS.join("|")})\\b`, "i");

/** An instruction addressed to the reader. */
const IMPERATIVE_RE = /^(?:please\s+)?(?:run|re-?run|check|verify|confirm|try|make sure|ensure|let me know|see|note|remember|use|execute|kick off|start)\b/i;

/** The claim is attributed to someone or something other than the agent's own run. */
const RELAYED_RE = new RegExp(
  [
    "you (?:said|mentioned|asked|told|noted|wrote|reported|indicated|claimed|stated)",
    "according to",
    "as (?:you|the (?:readme|docs?|issue|pr|ticket|spec)) (?:said|says|noted|notes|mentioned|mentions)",
    "per the (?:readme|docs?|documentation|issue|pr|ticket|spec|description|comment|changelog)",
    "the (?:(?:pr|pull request|issue|ticket|task|original|previous|earlier|last|prior|old) )?(?:readme|docs?|documentation|issue|pr|pull request|ticket|description|commit message|commit|changelog|comment|comments|session|run summary|summary|agent|report|note|notes|spec) (?:says?|said|claims?|claimed|states?|stated|mentions?|mentioned|notes?|noted|indicates?|indicated|reports?|reported|asserts?|asserted|suggests?|suggested)",
    "(?:in|on) ci\\b",
    "ci (?:is |are |was |went |stays |remains |all )?(?:green|passing|passes|passed|clean|happy)",
    "(?:github|gitlab) actions? (?:is |are |was )?(?:green|passing|passes|passed)",
    "the pipeline (?:is |was )?(?:green|passing|passes|passed)",
    "^ci\\b",
    "\\d+-way matrix",
    "ci matrix",
    "workflow runs?",
    "actions? runs?",
  ].join("|"),
  "i",
);

/** A sentence about deployments, servers or monitoring, where "green" is not about local verification. */
const OPERATIONS_RE = /\b(?:health(?:check)?s?|smoke|uptime|falco|pm2|endpoints?|probes?|live site|on prod|in production|production is|deployed|deploys?|served|cdn|status codes?|http \d{3}|\b\d{3} ok\b|200s?\b|500s?\b|infra|infrastructure|monitors?|dns|ssl|certificates?)\b/i;
/** Sentences that mention a badge, label or heading are describing text, not reporting a run. */
const MENTION_RE = /\b(?:badge|shields?\.io|label(?:led)?|heading|headline|placeholder|wording)\b/i;
/** Tests done by hand or against a live system are not local verification runs. */
const MANUAL_TEST_RE = /\b(?:live|manual|manually|supervised|smoke|browser|visual|hands-on) (?:\w+ )?tests?\b/i;
/** Verification nouns that make an "everything green" claim about local checks. */
const VERIFICATION_NOUN_RE = /\b(?:tests?|suite|tsc|typecheck|type-?check|types|lint|linter|eslint|ruff|clippy|mypy|pyright|builds?|compile[sd]?|vitest|jest|pytest|gates?)\b/i;

/** Failure words. A sentence containing one is not a success claim unless the word is negated. */
const FAILURE_RE = /\b(fail(?:s|ed|ing|ure|ures)?|broken|regress(?:ion|ions|ed)|crash(?:es|ed|ing)?|hangs?|not all|none of|no tests?|zero tests|error(?:s)? remain|still (?:erroring|red)|is red|are red)\b/gi;
/** Words that negate a failure word placed within three tokens before it. */
const FAILURE_NEGATOR_RE = /\b(?:no|zero|0|without|none|nothing|never)\b(?:\s+\S+){0,2}\s*$/i;

/** Negation before the matched span within the sentence. */
const NEGATION_BEFORE_RE =
  /\b(?:not|never|no longer|isn'?t|aren'?t|wasn'?t|weren'?t|don'?t|doesn'?t|didn'?t|won'?t|can'?t|cannot|couldn'?t|previously|used to|originally|earlier|initially|before|without|instead of|rather than|stop(?:ped)?|until)\b/i;
/** Negation after the matched span within the sentence. */
const NEGATION_AFTER_RE = /\b(?:but not|not any ?more|no longer|before (?:my|the|this|these|those|that|i)\b|prior to|as of (?:the|my) (?:previous|last|earlier)|on (?:main|master|the previous|the old) (?:branch|commit|version)?)/i;

/** Scope words that qualify a claim: reported but never blocked. */
const QUALIFIER_RE =
  /\b(?:remaining|pre-?existing|except|excluding|unrelated|known (?:[\w-]+ ){0,2}(?:failures?|issues?|problems?|breakages?|errors?|warnings?|prerender|limitations?)|only the known|flaky|other than|apart from|aside from|besides|all other|the other|only (?:the|these|those|\d+)|partial(?:ly)?|mostly|most|almost|nearly|so far|for now|at least|the rest|subset|ignoring|for (?:its|these|those|my|the new|the changed|the touched|the affected|the modified) files?|on its files)\b/i;

/** The generic "everything is green" forms expand into a claim for each category. */
const EVERYTHING_RE =
  /(?<!\b(?:smoke|health|status|uptime|infra|infrastructure|prod|production|deploys?|endpoints?|routes?|pages?|links?|servers?|services?|processes|monitors?|queues?) )\b(?:everything|all checks|all the checks|all verification|all verifications|every check|gates)(?: (?:is|are|now|still|also|else))* (?:pass(?:es|ed|ing)?|green|clean|succeed(?:s|ed)?)\b|(?<!\b(?:smoke|health|status|uptime|infra|infrastructure|prod|production|deploys?|endpoints?|routes?|pages?|links?|servers?|services?|processes|monitors?|queues?|checks?) )\ball green\b|\bgreen across the board\b|\bpass(?:es|ed)? every check\b/i;

interface Pattern {
  id: string;
  category: Category;
  re: RegExp;
  scope: ClaimScope | ((span: string) => ClaimScope);
  alternates?: Category[];
  /** Skip when a claim in one of these categories was already found in the sentence. */
  unless?: Category[];
}

const AUX = "(?: (?:are|is|now|still|were|was|all|both|also|currently|already|again|finally|exits?|exited|returns?|returned|comes back|came back|finishes|finished|ran|runs))*";

const PATTERNS: Pattern[] = [
  {
    id: "all_tests_pass",
    category: "test",
    re: new RegExp(`\\b(?:all|every)(?: (?:${NUM})| of the| the| existing| (?:${NUM}) of the| my| our| your| (?:${NUM}) of)?(?: [\\w-]+){0,2}? tests?(?: cases?)?(?: (?:in|of|for|from|under|inside|across) (?:the )?[\\w./-]+(?: [\\w-]+){0,2})?${AUX} (?:pass(?:es|ed|ing)?|green|succeed(?:ed|s)?)\\b`, "i"),
    scope: "all",
  },
  {
    id: "suite_green",
    category: "test",
    re: new RegExp(`\\b(?:the )?(?:(?:(?:full|entire|whole|complete|test|unit test|integration test|e2e|end-to-end|spec) )?suite|test run|test suite):?${AUX} (?:green|pass(?:es|ed|ing)?|clean|succeed(?:s|ed)?|passing)\\b`, "i"),
    scope: "all",
  },
  {
    id: "suite_ran_clean",
    category: "test",
    re: /\b(?:the )?(?:suite|tests?|test run|specs?)(?: (?:ran|runs|completed?|finish(?:ed|es)|came back|come back|are back|is back|went))+ (?:clean|cleanly|successfully|green|all green|through|without (?:any )?(?:failures?|errors?|issues?|problems?))\b/i,
    scope: (s) => (/\bsuite\b/i.test(s) ? "all" : "some"),
  },
  {
    id: "tests_pass",
    category: "test",
    re: new RegExp(`\\b(?:the |both |existing |new |unit |integration |remaining |updated |affected |relevant |related |added |(?:${NUM}) )*tests?(?: (?:suite|suites|cases?|files?))?:?${AUX} (?:pass(?:es|ed|ing)?|succeed(?:ed|s)?|green)\\b`, "i"),
    scope: (s) => (/\b(?:all|every|suite)\b/i.test(s) ? "all" : "some"),
  },
  {
    id: "tests_and_they_pass",
    category: "test",
    re: /\btests?,? and (?:they|it|everything|all of them) (?:all |now |still |also )?pass(?:es|ed|ing)?\b/i,
    scope: (s) => (/\b(?:everything|all of them)\b/i.test(s) ? "all" : "some"),
  },
  {
    id: "passes_the_tests",
    category: "test",
    re: /\bpass(?:es|ed|ing)? (?:all|every|the|its|our|both|\d+)(?: (?:existing|new|unit|integration|e2e|\d+))? (?:tests?|checks?|specs?|test suite|suite|test cases?)\b/i,
    scope: (s) => (/\b(?:all|every|suite)\b/i.test(s) ? "all" : "some"),
  },
  {
    id: "n_passed",
    category: "test",
    re: new RegExp(`\\b([1-9](?:\\d{0,2}(?:,\\d{3})+|\\d*))(?:\\/(${NUM}))? (?:tests? |specs? |test cases? |checks? |examples? )?(?:passed|passing|pass|green)\\b`, "i"),
    scope: (s) => {
      const m = s.match(/^([\d,]+)\/([\d,]+)/);
      return m && m[1] === m[2] ? "all" : "some";
    },
  },
  {
    id: "green_tests",
    category: "test",
    re: /\b(?:tests?|specs?):?(?: (?:is|are|now|still|all|also|currently|again))* (?:green|all green|fully green)\b|\bgreen (?:test )?suite\b/i,
    scope: (s) => (/\b(?:all|suite)\b/i.test(s) ? "all" : "some"),
  },
  {
    id: "typecheck_pass",
    category: "typecheck",
    re: new RegExp(`\\b(?:type-?checks?(?:ing)?|type checks?(?:ing)?|tsc|vue-tsc|svelte-check|mypy|pyright|basedpyright|typescript(?: compiler| check)?|types|the types|type checker|cargo check|flow)(?: (?:--[\\w-]+|-\\w|-p [\\w./-]+))*:?${AUX} (?:pass(?:es|ed|ing)?|green|clean|succeed(?:s|ed)?|compiles?|check out|checks out|happy|ok|okay|fine|good)\\b`, "i"),
    scope: "all",
  },
  {
    id: "no_type_errors",
    category: "typecheck",
    re: /\b(?:no|zero|0|without) (?:type|typescript|tsc|mypy|pyright|typing|type-?check(?:ing)?|compiler|type-level) errors?\b|\btype-?checks? (?:cleanly|clean|without errors|with no errors|with zero errors)\b|\b(?:tsc|mypy|pyright|typecheck|type-?check|the type checker|typescript) (?:reports?|shows?|finds?|returns?|gives?|has|had|comes back with|with|at)? ?(?:no|zero|0) (?:errors?|issues?|problems?|complaints?)\b|\btypes (?:all )?check(?: out)?\b/i,
    scope: "all",
  },
  {
    id: "lint_pass",
    category: "lint",
    re: new RegExp(`\\b(?:lint(?:er|ing)?|linters|eslint|ruff|biome|flake8|pylint|clippy|golangci-lint|rubocop|oxlint|prettier|formatting|format check|stylelint|shellcheck|swiftlint|black|isort)(?: checks?| rules?| run)?(?: (?:--[\\w-]+|-\\w))*:?${AUX} (?:pass(?:es|ed|ing)?|green|clean|succeed(?:s|ed)?|happy|ok|okay|fine|good)\\b`, "i"),
    scope: "all",
  },
  {
    id: "no_lint_errors",
    category: "lint",
    re: /\b(?:no|zero|0|without) (?:lint(?:ing|er)?|eslint|ruff|clippy|rubocop|biome|formatting|prettier|style|flake8|pylint) (?:errors?|warnings?|issues?|problems?|violations?|offenses?|complaints?|findings?)\b|\blint(?:ing)?(?: is)? clean\b|\b(?:eslint|ruff|clippy|biome|rubocop|the linter|linting|lint) (?:reports?|shows?|finds?|returns?|gives?|has|had|comes back with|with|at)? ?(?:no|zero|0) (?:errors?|issues?|problems?|warnings?|complaints?|findings?)\b/i,
    scope: "all",
  },
  {
    id: "build_pass",
    category: "build",
    re: new RegExp(`\\b(?:(?:production|prod|release|docker|next|vite|cargo|go|swift|gradle|maven|xcode|dev|the|a|our|my) )?builds?(?: (?:step|command|process|pipeline|output))?:?${AUX} (?:succeed(?:s|ed)?|pass(?:es|ed|ing)?|green|clean|works|worked|complet(?:es|ed) successfully|finish(?:es|ed) successfully|successful|ok|okay|fine|good|happy)\\b|\\bbuil(?:d|t|ds) (?:cleanly|successfully|without (?:any )?errors|with no errors|with zero errors|fine|ok)\\b|\\bsuccessful build\\b|\\b(?:no|zero|0) build errors\\b`, "i"),
    scope: "all",
  },
  {
    id: "project_builds",
    category: "build",
    re: /(?<!\b(?:while|as|when|once|until|before|after|if) )\b(?:project|app|application|package|codebase|library|crate|module|binary|image|container|site|everything|it|code) (?:still |now |also |again )?builds\b(?! (?:on|upon|from|with|off|toward|towards|atop|against|over|onto|around|the|a|an|your|our|its|their|this|that|these|those|each|every|all|out|up|in|into|to|itself|them|us|you|me|new|one|two|three|several|multiple|many|some|most|any|no)\b)/i,
    scope: "all",
  },
  {
    id: "compiles_clean",
    category: "build",
    re: /\bcompil(?:es|ed|ing) (?:cleanly|clean|successfully|without (?:any )?errors|with no errors|with zero errors|fine|ok)\b|\bno compil(?:e|ation|er) errors\b|\bcompiled successfully\b|\bcompilation (?:succeeds|succeeded|passes|passed|is clean)\b/i,
    scope: "all",
    alternates: ["typecheck"],
    unless: ["typecheck"],
  },
];

/** "lint and typecheck both pass", "build and tests are green": one claim per listed subject. */
const SUBJECT_WORDS: [RegExp, Category][] = [
  [/^(?:the )?(?:tests?|test suite|suite|specs?|unit tests|integration tests|e2e tests)$/i, "test"],
  [/^(?:the )?(?:typecheck|type-?check|typechecking|type checking|tsc|mypy|pyright|types|typescript)$/i, "typecheck"],
  [/^(?:the )?(?:lint|linting|linter|eslint|ruff|clippy|biome|rubocop|prettier|formatting)$/i, "lint"],
  [/^(?:the )?(?:build|builds|compile|compilation|bundle)$/i, "build"],
];
const SUBJECT_ALT = "(?:the )?(?:tests?|test suite|suite|specs?|unit tests|integration tests|e2e tests|typecheck|type-?check|typechecking|type checking|tsc|mypy|pyright|types|typescript|lint|linting|linter|eslint|ruff|clippy|biome|rubocop|prettier|formatting|build|builds|compile|compilation|bundle)";
const COORDINATED_RE = new RegExp(`\\b(${SUBJECT_ALT}(?:, ${SUBJECT_ALT})*,? and ${SUBJECT_ALT})(?: (?:are|is|both|all|now|still|also))* (?:pass(?:es|ed|ing)?|green|clean|succeed(?:s|ed)?|ok|fine|happy)\\b`, "i");

function subjectCategory(word: string): Category | null {
  for (const [re, category] of SUBJECT_WORDS) if (re.test(word.trim())) return category;
  return null;
}

const CATEGORY_NOUN: Record<Category, string> = { test: "tests", typecheck: "typecheck", lint: "lint", build: "build" };

/** Tools an agent names in a claim, mapped to the runner names the catalog uses. */
const TOOL_HINT_RE = /\b(tsc|vue-tsc|mypy|pyright|eslint|ruff|biome|clippy|rubocop|oxlint|prettier|flake8|pylint|pytest|vitest|jest|mocha|playwright|cypress|cargo|go test|go vet|next build|vite build|webpack|tsup|phpunit|rspec|phpstan|golangci-lint|svelte-check)\b/i;

function toolHint(span: string): string | undefined {
  const m = TOOL_HINT_RE.exec(span);
  return m ? (m[1] as string).toLowerCase() : undefined;
}

/** Replaces code spans with a placeholder, or with the category noun when the span is a runner command. */
function stripCode(text: string): string {
  let out = text.replace(FENCE_RE, " ");
  out = out.replace(INLINE_CODE_RE, (span) => {
    const inner = span.slice(1, -1).trim();
    if (inner.length > 0 && inner.length < 120 && !/[\n]/.test(inner)) {
      const d = detect(inner);
      if (d) return ` ${CATEGORY_NOUN[d.category]} `;
    }
    return " ` ";
  });
  out = out.replace(DOUBLE_QUOTE_RE, (_m, lead: string) => `${lead} " `);
  out = out.replace(SINGLE_QUOTE_RE, (_m, lead: string) => `${lead} ' `);
  return out.replace(/[ \t]+/g, " ");
}

export function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function failureIsNegated(sentence: string): boolean {
  FAILURE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FAILURE_RE.exec(sentence)) !== null) {
    const before = sentence.slice(0, m.index);
    const word = m[1] as string;
    if (/^(?:not all|none of|no tests?|zero tests|error(?:s)? remain|still (?:erroring|red)|is red|are red)$/i.test(word)) return false;
    if (!FAILURE_NEGATOR_RE.test(before)) return false;
  }
  return true;
}

function numbersIn(span: string): Counts | undefined {
  const m = span.match(/\b([1-9][\d,]*)(?:\/([\d,]+))?\b/);
  if (!m) return undefined;
  const counts: Counts = { passed: Number((m[1] as string).replace(/,/g, "")) };
  if (m[2]) counts.total = Number(m[2].replace(/,/g, ""));
  return counts;
}

/** Extracts assertive claims from a message. */
export function extractClaims(text: string): Claim[] {
  const claims: Claim[] = [];
  if (!text) return claims;
  const cleaned = stripCode(text);
  const paragraphs = cleaned.split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const paragraphQualified = QUALIFIER_RE.test(paragraph);
    for (const raw of splitSentences(paragraph)) {
      if (UNCHECKED_TODO_RE.test(raw)) continue;
      const sentence = raw.replace(LEADING_NOISE_RE, "").trim();
      if (!sentence) continue;
      if (sentence.includes("?")) continue;
      if (IMPERATIVE_RE.test(sentence)) continue;
      if (CONDITIONAL_RE.test(sentence)) continue;
      if (RELAYED_RE.test(sentence)) continue;
      if (MENTION_RE.test(sentence)) continue;
      if (!failureIsNegated(sentence)) continue;
      if (NEGATION_AFTER_RE.test(sentence)) continue;
      const operations = OPERATIONS_RE.test(sentence);
      const found = new Map<Category, Claim>();
      const put = (claim: Claim) => {
        const existing = found.get(claim.category);
        if (!existing || (existing.scope === "some" && claim.scope === "all")) found.set(claim.category, claim);
      };
      const everything = sentence.match(EVERYTHING_RE);
      if (everything && !NEGATION_BEFORE_RE.test(sentence.slice(0, everything.index ?? 0)) && VERIFICATION_NOUN_RE.test(paragraph) && !operations) {
        for (const category of ["test", "typecheck", "lint", "build"] as const) {
          put({ category, text: everything[0], sentence, scope: "some", qualified: paragraphQualified, expanded: true });
        }
      }
      const coordinated = COORDINATED_RE.exec(sentence);
      if (coordinated && !NEGATION_BEFORE_RE.test(sentence.slice(0, coordinated.index))) {
        const subjects = (coordinated[1] as string).split(/,\s*|\s+and\s+/);
        for (const s of subjects) {
          const category = subjectCategory(s);
          if (!category) continue;
          const scope: ClaimScope = category === "test" ? (/\b(?:suite|all)\b/i.test(s) ? "all" : "some") : "all";
          put({ category, text: coordinated[0], sentence, scope, qualified: paragraphQualified });
        }
      }
      for (const p of PATTERNS) {
        if (p.unless && p.unless.some((c) => found.has(c))) continue;
        const m = p.re.exec(sentence);
        if (!m) continue;
        const span = m[0];
        const before = sentence.slice(0, m.index);
        if (NEGATION_BEFORE_RE.test(before)) continue;
        // "25/25 PASS" next to health checks or smoke probes is about a server, not a test suite.
        if (p.category === "test" && operations && !/\b(?:tests?|specs?|test cases?)\b/i.test(span)) continue;
        // A live, manual or smoke test that passed is not a suite run.
        if (p.category === "test" && MANUAL_TEST_RE.test(`${before.trim().split(/\s+/).slice(-3).join(" ")} ${span}`.replace(/\s+/g, " "))) continue;
        const scope = typeof p.scope === "function" ? p.scope(span) : p.scope;
        const claim: Claim = { category: p.category, text: span, sentence, scope, qualified: paragraphQualified };
        const counts = p.category === "test" ? numbersIn(span) : undefined;
        if (counts) claim.counts = counts;
        if (p.alternates) claim.alternates = p.alternates;
        const tool = toolHint(span);
        if (tool) claim.tool = tool;
        put(claim);
      }
      for (const c of found.values()) claims.push(c);
    }
  }
  return claims;
}

/** Keeps one claim per category: unqualified beats qualified, then the wider scope wins, then the first one seen. */
export function dedupeClaims(claims: Claim[]): Claim[] {
  const byCategory = new Map<Category, Claim>();
  for (const c of claims) {
    const prev = byCategory.get(c.category);
    if (!prev) {
      byCategory.set(c.category, c);
      continue;
    }
    if (prev.qualified && !c.qualified) byCategory.set(c.category, c);
    else if (prev.qualified === c.qualified && prev.scope === "some" && c.scope === "all") byCategory.set(c.category, c);
  }
  return [...byCategory.values()];
}
