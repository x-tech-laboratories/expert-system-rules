import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: {
        autoUpdate: (new_threshold: number) => Math.floor(new_threshold),
        lines: 99,
        statements: 98,
        functions: 100,
        branches: 93,
      },
    },
  },
});
