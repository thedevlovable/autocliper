import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests in a Node environment (no browser DOM needed)
    environment: "node",
    // Each test file gets its own isolated module registry so vi.mock() works correctly
    isolate: true,
    // Inline source maps for readable stack traces
    includeSource: ["src/**/*.ts"],
  },
});
