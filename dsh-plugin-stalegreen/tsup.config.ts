import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  outDir: "lib",
  dts: true,
  clean: true,
  target: "node20",
  external: ["stalegreen", "@deepseek-ai/cordis", "@deepseek-ai/dsh-llm"],
  sourcemap: false,
});
