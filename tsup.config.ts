import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
const define = { __STALEGREEN_VERSION__: JSON.stringify(pkg.version) };

// Two single-file executables with no externals (hooks run on every Bash call,
// so startup time matters) plus a dual-format library entry with types.
export default defineConfig([
  {
    entry: { cli: "src/cli/index.ts", hook: "src/hook.ts" },
    format: ["esm"],
    target: "node20",
    platform: "node",
    splitting: false,
    sourcemap: true,
    minify: false,
    clean: false,
    define,
    banner: { js: "#!/usr/bin/env node" },
    esbuildOptions(options) {
      options.charset = "utf8";
    },
  },
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    target: "node20",
    platform: "node",
    splitting: false,
    sourcemap: true,
    minify: false,
    clean: false,
    dts: true,
    shims: true,
    define,
    esbuildOptions(options) {
      options.charset = "utf8";
    },
  },
]);
