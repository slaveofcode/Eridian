import { defineConfig } from "vitest/config";

// Frontend unit tests. Coverage is measured over LOGIC modules only (see the
// test-coverage plan) — presentational components, wiring (App/main) and the
// thin Tauri invoke layer (api.ts) are excluded from the gate.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: [
        "src/lib/format.ts",
        "src/lib/hooks.ts",
        "src/lib/catalogUi.ts",
        "src/lib/navStack.ts",
        "src/lib/timelineFilter.ts",
        "src/lib/commandsUi.ts",
        "src/lib/virtualList.ts",
        "src/lib/palette.ts",
        "src/components/CodeView.tsx",
        "src/components/DiffView.tsx",
        "src/components/Markdown.tsx",
        "src/components/XmlView.tsx",
      ],
      thresholds: { lines: 90, functions: 90, branches: 85 },
      reporter: ["text-summary"],
    },
  },
});
