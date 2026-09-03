import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  define: { __STALEGREEN_VERSION__: JSON.stringify(pkg.version) },
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});
