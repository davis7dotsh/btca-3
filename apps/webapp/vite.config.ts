import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { defineConfig } from "vite";

const appRoot = import.meta.dirname;
const workspaceRoot = path.resolve(appRoot, "../..");

export default defineConfig({
  envDir: workspaceRoot,
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
