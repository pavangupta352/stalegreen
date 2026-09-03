import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dedupeClaims, extractClaims } from "../src/core/claims.js";
import type { Category } from "../src/core/grammar.js";

type Label = "assertive" | "hedged" | "future" | "negated" | "quoted" | "relayed" | "scoped" | "question" | "code" | "none";

interface Entry {
  text: string;
  label: Label;
  categories?: Category[];
  scope?: "all" | "some";
}

const corpus = JSON.parse(readFileSync(join(__dirname, "fixtures", "claims", "corpus.json"), "utf8")) as Entry[];

describe("claim corpus", () => {
  it("has at least 300 labelled sentences across every form", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(300);
    const labels = new Set(corpus.map((e) => e.label));
    for (const l of ["assertive", "hedged", "future", "negated", "quoted", "relayed", "scoped", "question", "code", "none"]) {
      expect(labels.has(l as Label), `label ${l} present`).toBe(true);
    }
  });

  it("detects assertive claims with precision >= 0.98 and recall >= 0.90", () => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    const falsePositives: string[] = [];
    const falseNegatives: string[] = [];
    for (const e of corpus) {
      const claims = extractClaims(e.text);
      const blocking = claims.filter((c) => !c.qualified);
      const isAssertive = e.label === "assertive";
      if (isAssertive) {
        if (blocking.length > 0) tp++;
        else {
          fn++;
          falseNegatives.push(e.text);
        }
      } else if (e.label === "scoped") {
        // Scoped sentences may yield qualified claims only.
        if (blocking.length > 0) {
          fp++;
          falsePositives.push(`${e.text} => ${blocking.map((c) => c.text).join(" | ")}`);
        }
      } else if (claims.length > 0) {
        fp++;
        falsePositives.push(`${e.text} => ${claims.map((c) => c.text).join(" | ")}`);
      }
    }
    const precision = tp / (tp + fp);
    const recall = tp / (tp + fn);
    const summary = `precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} tp=${tp} fp=${fp} fn=${fn}`;
    // eslint-disable-next-line no-console
    console.log(`claim extractor: ${summary}`);
    if (falsePositives.length) console.log("false positives:\n  " + falsePositives.join("\n  "));
    if (falseNegatives.length) console.log("false negatives:\n  " + falseNegatives.join("\n  "));
    expect(precision, summary).toBeGreaterThanOrEqual(0.98);
    expect(recall, summary).toBeGreaterThanOrEqual(0.9);
  });

  it("assigns the expected categories and scope to detected assertive claims", () => {
    const wrong: string[] = [];
    for (const e of corpus) {
      if (e.label !== "assertive" || !e.categories) continue;
      const claims = dedupeClaims(extractClaims(e.text));
      if (claims.length === 0) continue;
      const got = claims.map((c) => c.category).sort();
      const want = [...e.categories].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${e.text}: categories ${got.join(",")} (want ${want.join(",")})`);
      if (e.scope && e.categories.length === 1) {
        const c = claims[0]!;
        if (c.scope !== e.scope) wrong.push(`${e.text}: scope ${c.scope} (want ${e.scope}) span "${c.text}"`);
      }
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("marks scoped sentences as qualified claims", () => {
    for (const e of corpus) {
      if (e.label !== "scoped" || !e.categories) continue;
      const claims = extractClaims(e.text);
      expect(claims.length, `${e.text} yields a claim`).toBeGreaterThan(0);
      expect(claims.every((c) => c.qualified), `${e.text} is qualified`).toBe(true);
      const cats = new Set(claims.map((c) => c.category));
      for (const c of e.categories) expect(cats.has(c), `${e.text} has ${c}`).toBe(true);
    }
  });

  it("never yields claims from code fences or inline code", () => {
    expect(extractClaims("```\nall tests pass\n```")).toEqual([]);
    expect(extractClaims("`all 41 tests pass`")).toEqual([]);
    expect(extractClaims("Here is the output:\n```\nTests: 41 passed, 41 total\nBuild succeeded.\n```\n")).toEqual([]);
  });

  it("maps a runner command in inline code to its category noun", () => {
    const claims = extractClaims("`npm test` passes and `tsc --noEmit` is clean.");
    expect(claims.map((c) => c.category).sort()).toEqual(["test", "typecheck"]);
  });

  it("reads numbers out of numeric claims", () => {
    const [c] = extractClaims("All 41 tests pass.");
    expect(c).toMatchObject({ category: "test", scope: "all", counts: { passed: 41 } });
    const [d] = extractClaims("41/41 passing.");
    expect(d).toMatchObject({ scope: "all", counts: { passed: 41, total: 41 } });
    const [e] = extractClaims("39/41 passing.");
    expect(e).toMatchObject({ scope: "some" });
  });

  it("dedupes to one claim per category preferring unqualified and all-scope claims", () => {
    const claims = extractClaims("Tests pass.\n\nAll tests pass.\n\nThe build is green.");
    const deduped = dedupeClaims(claims);
    expect(deduped.map((c) => `${c.category}:${c.scope}`).sort()).toEqual(["build:all", "test:all"]);
  });

  it("expands 'everything passes' into one claim per category", () => {
    const claims = extractClaims("Everything passes.");
    expect(claims.map((c) => c.category).sort()).toEqual(["build", "lint", "test", "typecheck"]);
  });

  it("handles a realistic final message", () => {
    const message = [
      "I fixed the expiry calculation in `src/lib/hold.ts` and added two tests.",
      "",
      "Summary:",
      "- All 43 tests pass (`pnpm test`).",
      "- `tsc --noEmit` is clean.",
      "- Lint passes.",
      "",
      "Let me know if you want me to also run the e2e suite.",
    ].join("\n");
    const claims = dedupeClaims(extractClaims(message));
    expect(claims.map((c) => `${c.category}:${c.scope}`).sort()).toEqual(["lint:all", "test:all", "typecheck:all"]);
  });
});
