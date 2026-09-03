import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureBuilt, hookJs, repoRoot } from "./helpers.js";

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string; files: string[] };
const manifest = JSON.parse(readFileSync(join(repoRoot, "plugin", ".claude-plugin", "plugin.json"), "utf8")) as Record<string, unknown>;
const hooks = JSON.parse(readFileSync(join(repoRoot, "plugin", "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, HookEntry[]> };
const marketplace = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8")) as { name: string; owner: { name: string }; plugins: { name: string; version?: string; source: unknown }[] };

describe("Claude Code plugin packaging", () => {
  it("has a manifest whose name and version match the package", () => {
    expect(manifest.name).toBe("stalegreen");
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.license).toBe("MIT");
    expect((manifest.author as { name: string }).name).toBe("Pavan Gupta");
    expect(typeof manifest.description).toBe("string");
    expect((manifest.description as string).length).toBeGreaterThan(40);
  });

  it("registers the four events against the bundled hook through CLAUDE_PLUGIN_ROOT", () => {
    expect(Object.keys(hooks.hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "Stop", "SubagentStop"]);
    for (const [event, entries] of Object.entries(hooks.hooks)) {
      expect(entries).toHaveLength(1);
      const entry = entries[0] as HookEntry;
      expect(entry.hooks).toHaveLength(1);
      const h = entry.hooks[0]!;
      expect(h.type).toBe("command");
      expect(h.command).toBe(`node "\${CLAUDE_PLUGIN_ROOT}/hook.js" claude ${event}`);
      expect(h.timeout).toBeGreaterThanOrEqual(10);
    }
    expect(hooks.hooks.PreToolUse?.[0]?.matcher).toBe("Bash");
    expect(hooks.hooks.PostToolUse?.[0]?.matcher).toContain("Bash");
    expect(hooks.hooks.PostToolUse?.[0]?.matcher).toContain("Edit");
    expect(hooks.hooks.Stop?.[0]?.matcher).toBeUndefined();
  });

  it("ships a hook identical to the current build, so the plugin never lags the source", () => {
    ensureBuilt();
    const built = readFileSync(hookJs, "utf8");
    const shipped = readFileSync(join(repoRoot, "plugin", "hook.js"), "utf8");
    expect(shipped.length).toBeGreaterThan(10_000);
    expect(shipped === built, "plugin/hook.js differs from dist/hook.js: run `npm run build` and commit plugin/hook.js").toBe(true);
    expect(shipped.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("keeps the plugin directory free of anything that would trigger a dependency install", () => {
    for (const name of ["package.json", "package-lock.json", "bun.lock", "bun.lockb", "npm-shrinkwrap.json"]) {
      expect(() => readFileSync(join(repoRoot, "plugin", name))).toThrow();
    }
    expect(readFileSync(join(repoRoot, "plugin", "LICENSE"), "utf8")).toContain("MIT");
  });

  it("publishes the plugin from the repository marketplace by a relative path", () => {
    expect(marketplace.name).toBe("stalegreen");
    expect(marketplace.owner.name).toBe("Pavan Gupta");
    expect(marketplace.plugins).toHaveLength(1);
    const p = marketplace.plugins[0]!;
    expect(p.name).toBe("stalegreen");
    expect(p.version).toBe(pkg.version);
    expect(p.source).toBe("./plugin");
  });

  it("keeps the npm tarball to the CLI, the library and the docs", () => {
    expect(pkg.files).toEqual(["dist/*.js", "dist/*.cjs", "dist/*.d.ts", "dist/*.d.cts", "README.md", "LICENSE"]);
  });
});
