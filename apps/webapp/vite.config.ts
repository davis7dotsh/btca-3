import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { defineConfig } from "vite-plus";

const appRoot = import.meta.dirname;
const workspaceRoot = path.resolve(appRoot, "../..");

export default defineConfig({
  envDir: workspaceRoot,
  fmt: {
    ignorePatterns: [".svelte-kit/**", "build/**"],
  },
  lint: {
    ignorePatterns: [".svelte-kit/**", "build/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  root: appRoot,
  plugins: [tailwindcss(), sveltekit()],
  resolve: {
    alias: {
      "@": path.resolve(appRoot, "./src"),
    },
  },
  server: {
    fs: {
      allow: [workspaceRoot],
    },
  },
});
