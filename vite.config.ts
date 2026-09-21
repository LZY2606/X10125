import { defineConfig } from "vite";
import { lineageApiPlugin } from "./src/server/plugin.js";

export default defineConfig({
  plugins: [lineageApiPlugin()],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    pool: "forks"
  }
});
