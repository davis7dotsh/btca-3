import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    outDir: "dist",
    ssr: "src/index.ts",
    target: "node22",
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
