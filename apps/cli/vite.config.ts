import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/bootstrap.ts"],
    deps: {
      alwaysBundle: ["@btca/server", "@mariozechner/pi-agent-core", "@mariozechner/pi-ai"],
      onlyBundle: false,
    },
    dts: {
      tsgo: true,
    },
  },
  lint: {
    ignorePatterns: ["dist/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: ["dist/**"],
  },
});
