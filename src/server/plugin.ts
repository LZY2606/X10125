import type { Plugin, ViteDevServer } from "vite";
import { Ledger } from "../core/ledger.js";
import { handleApi } from "./api.js";

export interface LineagePluginOptions {
  dataDir?: string;
}

export function lineageApiPlugin(options: LineagePluginOptions = {}): Plugin {
  let ledgerPromise: Promise<Ledger> | undefined;
  const dataDir = options.dataDir ?? new URL("../../.lineage/", import.meta.url).pathname;

  const getLedger = (): Promise<Ledger> => {
    ledgerPromise ??= Ledger.open(dataDir);
    return ledgerPromise;
  };

  return {
    name: "lineage-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/api/")) {
          next();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        }
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
        }
        const response = await handleApi(await getLedger(), {
          method: req.method ?? "GET",
          url,
          headers,
          body: body.byteLength > 0 ? new Uint8Array(body) : null
        });
        res.statusCode = response.status;
        for (const [key, value] of Object.entries(response.headers)) {
          res.setHeader(key, value);
        }
        const payload = Buffer.from(Uint8Array.from(response.body));
        res.end(payload);
      });
    }
  };
}
