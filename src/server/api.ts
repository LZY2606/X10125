import type { IncomingMessage, ServerResponse } from "node:http";
import { LedgerStore, CycleError, LedgerError } from "../core/store.js";

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { params: Record<string, string>; body: any }
) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function route(method: string, pathPattern: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      pathPattern.replace(/:[^/]+/g, (m) => {
        keys.push(m.slice(1));
        return "([^/]+)";
      }) +
      "$"
  );
  return { method, pattern, keys, handler };
}

export function createLedgerApi(store: LedgerStore) {
  const routes: Route[] = [
    route("GET", "/api/state", (_req, res) => {
      json(res, 200, {
        blobs: store.listBlobs(),
        aliases: store.listAliases(),
        runs: store.listRuns(),
        dangling: store.danglingRuns(),
        gcPlans: store.listGcPlans(),
      });
    }),

    route("POST", "/api/blobs", async (req, res) => {
      const data = await readBody(req);
      const alias = req.headers["x-blob-name"];
      const { meta, deduplicated } = store.putBlob(
        data,
        typeof alias === "string" && alias.length > 0 ? decodeURIComponent(alias) : null
      );
      json(res, 200, { ...meta, deduplicated });
    }),

    route("GET", "/api/blobs/:hash/verify", (_req, res, { params }) => {
      json(res, 200, store.verifyBlob(params.hash));
    }),

    route("POST", "/api/aliases", async (req, res, { body }) => {
      json(res, 200, store.setAlias(body.name, body.hash));
    }),

    route("POST", "/api/aliases/:name/revoke", (_req, res, { params }) => {
      store.revokeAlias(decodeURIComponent(params.name));
      json(res, 200, { ok: true });
    }),

    route("POST", "/api/runs/prepare", (_req, res, { body }) => {
      json(res, 200, store.prepareRun(body));
    }),

    route("POST", "/api/runs/:id/commit", async (req, res, { params, body }) => {
      const outputs = (body.outputs ?? []).map((o: any) => ({
        data: Buffer.from(o.dataBase64, "base64"),
        alias: o.alias ?? null,
      }));
      json(res, 200, store.commitRun(params.id, outputs));
    }),

    route("POST", "/api/runs/:id/abort", (_req, res, { params }) => {
      json(res, 200, store.abortRun(params.id));
    }),

    route("POST", "/api/runs/:id/revoke", (_req, res, { params }) => {
      json(res, 200, store.revokeRun(params.id));
    }),

    route("GET", "/api/proof/:hash", (_req, res, { params }) => {
      json(res, 200, store.prove(params.hash));
    }),

    route("POST", "/api/gc/plan", (_req, res) => {
      json(res, 200, store.planGc());
    }),

    route("POST", "/api/gc/:id/execute", (_req, res, { params }) => {
      json(res, 200, store.executeGc(params.id));
    }),

    route("GET", "/api/archive", (_req, res) => {
      json(res, 200, store.exportArchive());
    }),

    route("POST", "/api/archive/import", (_req, res, { body }) => {
      json(res, 200, store.importArchive(body));
    }),

    // Simulates a process restart: state is re-read from disk, dangling
    // `prepared` runs surface as recoverable instead of vanishing.
    route("POST", "/api/debug/restart", (_req, res) => {
      store.load();
      json(res, 200, { restarted: true, dangling: store.danglingRuns() });
    }),
  ];

  return async function ledgerApiMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void
  ) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/api/")) return next();
    const method = req.method ?? "GET";
    for (const r of routes) {
      if (r.method !== method) continue;
      const match = r.pattern.exec(url.pathname);
      if (!match) continue;
      try {
        let body: any = undefined;
        if (method === "POST" && url.pathname !== "/api/blobs") {
          const raw = await readBody(req);
          body = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : {};
        }
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = match[i + 1]));
        await r.handler(req, res, { params, body });
      } catch (err) {
        if (err instanceof CycleError) {
          json(res, 409, { error: err.message, cycle: err.cyclePath });
        } else if (err instanceof LedgerError) {
          json(res, 400, { error: err.message });
        } else {
          json(res, 500, { error: String(err) });
        }
      }
      return;
    }
    json(res, 404, { error: `未知 API: ${method} ${url.pathname}` });
  };
}
