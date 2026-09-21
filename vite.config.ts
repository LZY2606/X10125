import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import * as path from "node:path";
import { LedgerStore } from "./src/core/store.js";
import { createLedgerApi } from "./src/server/api.js";

function ledgerPlugin(): Plugin {
  const store = new LedgerStore(path.resolve(__dirname, ".ledger"));
  const middleware = createLedgerApi(store);
  return {
    name: "artifact-ledger-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void middleware(req, res, next);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), ledgerPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5213,
  },
});
