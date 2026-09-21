import { Ledger } from "../core/ledger.js";
import { LedgerError } from "../core/errors.js";
import { exportArchive, importArchive } from "../core/archive.js";
import type { LedgerState } from "../core/types.js";

export interface ApiRequest {
  method: string;
  url: string;
  headers?: Record<string, string | undefined>;
  body?: Uint8Array | null;
  query?: Record<string, string>;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

function respond(status: number, payload: unknown, headers: Record<string, string> = jsonHeaders): ApiResponse {
  return {
    status,
    headers,
    body: new TextEncoder().encode(JSON.stringify(payload))
  };
}

function respondBinary(status: number, payload: Uint8Array, headers: Record<string, string>): ApiResponse {
  return { status, headers, body: payload };
}

function parseBody(req: ApiRequest): unknown {
  if (!req.body || req.body.byteLength === 0) return {};
  const text = new TextDecoder().decode(req.body);
  try {
    return JSON.parse(text);
  } catch {
    throw new LedgerError("BAD_JSON", "请求体不是合法 JSON");
  }
}

function parseQuery(url: string): { path: string; query: URLSearchParams } {
  const index = url.indexOf("?");
  if (index === -1) return { path: url, query: new URLSearchParams() };
  return { path: url.slice(0, index), query: new URLSearchParams(url.slice(index + 1)) };
}


export async function handleApi(ledger: Ledger, req: ApiRequest): Promise<ApiResponse> {
  try {
    const { path, query } = parseQuery(req.url);
    const segments = path.split("/").filter(Boolean);
    const method = req.method.toUpperCase();

    if (method === "GET" && path === "/api/state") {
      const state = ledger.snapshot();
      const blobs = await ledger.listBlobs();
      const runs = ledger.listRuns();
      const graph = ledger.graph();
      const prepared = runs.filter((run) => run.status === "prepared");
      const reachable = [...ledger.reachableBlobIds()].sort();
      return respond(200, { state, blobs, runs, prepared, graph, reachable, gcPlans: ledger.listGcPlans() } satisfies {
        state: LedgerState;
        blobs: Awaited<ReturnType<Ledger["listBlobs"]>>;
        runs: ReturnType<Ledger["listRuns"]>;
        prepared: ReturnType<Ledger["listRuns"]>;
        graph: ReturnType<Ledger["graph"]>;
        reachable: string[];
        gcPlans: ReturnType<Ledger["listGcPlans"]>;
      });
    }

    if (method === "POST" && path === "/api/blobs") {
      const data = req.body ?? new Uint8Array();
      const result = await ledger.addBlob(data);
      const alias = typeof req.headers?.["x-alias"] === "string" ? req.headers["x-alias"] : undefined;
      if (alias) await ledger.bindAlias(alias, result.blobId);
      return respond(200, { ...result, alias });
    }

    if (method === "GET" && segments[0] === "api" && segments[1] === "blobs" && segments[2]) {
      const blobId = decodeURIComponent(segments[2]);
      if (segments[3] === "verify") {
        return respond(200, await ledger.verifyBlob(blobId));
      }
      if (segments[3] === "content") {
        const data = await ledger.readBlob(blobId);
        return respond(200, data, { "content-type": "application/octet-stream" });
      }
    }

    if (method === "POST" && path === "/api/aliases") {
      const body = parseBody(req) as { name?: string; blobId?: string };
      if (!body.name || !body.blobId) throw new LedgerError("BAD_REQUEST", "需要 name 与 blobId");
      await ledger.bindAlias(body.name, body.blobId);
      return respond(200, { ok: true });
    }

    if (method === "DELETE" && segments[0] === "api" && segments[1] === "aliases" && segments[2]) {
      await ledger.revokeAlias(decodeURIComponent(segments[2]));
      return respond(200, { ok: true });
    }

    if (method === "POST" && path === "/api/runs/prepare") {
      const body = parseBody(req) as Parameters<Ledger["prepareRun"]>[0];
      const run = await ledger.prepareRun(body);
      return respond(200, run);
    }

    if (method === "POST" && segments[0] === "api" && segments[1] === "runs" && segments[2] && segments[3] === "commit") {
      return respond(200, await ledger.commitRun(decodeURIComponent(segments[2])));
    }

    if (method === "POST" && segments[0] === "api" && segments[1] === "runs" && segments[2] && segments[3] === "abort") {
      const body = parseBody(req) as { reason?: string };
      return respond(200, await ledger.abortRun(decodeURIComponent(segments[2]), body.reason));
    }

    if (method === "POST" && segments[0] === "api" && segments[1] === "runs" && segments[2] && segments[3] === "revoke") {
      return respond(200, await ledger.revokeRun(decodeURIComponent(segments[2])));
    }

    if (method === "GET" && segments[0] === "api" && segments[1] === "proof") {
      const source = query.get("source");
      const target = query.get("target");
      if (!source || !target) throw new LedgerError("BAD_REQUEST", "需要 source 与 target 参数");
      return respond(200, ledger.proof(source, target));
    }

    if (method === "POST" && path === "/api/gc/plans") {
      return respond(200, await ledger.gcPlan());
    }

    if (method === "GET" && path === "/api/gc/plans") {
      return respond(200, { plans: ledger.listGcPlans() });
    }

    if (method === "POST" && segments[0] === "api" && segments[1] === "gc" && segments[2] === "plans" && segments[3] && segments[4] === "execute") {
      return respond(200, await ledger.executeGcPlan(decodeURIComponent(segments[3])));
    }

    if (method === "GET" && path === "/api/archive/export") {
      const { data } = await exportArchive(ledger);
      return respondBinary(200, data, {
        "content-type": "application/gzip",
        "content-disposition": 'attachment; filename="lineage-archive.tar.gz"'
      });
    }

    if (method === "POST" && path === "/api/archive/import") {
      const raw = req.body;
      if (!raw || raw.byteLength === 0) throw new LedgerError("BAD_REQUEST", "归档内容为空");
      const force = (req.headers?.["x-force"] ?? "").toLowerCase() === "true";
      const info = await importArchive(ledger, raw, { force });
      return respond(200, info);
    }

    return respond(404, { error: "NOT_FOUND", message: `未找到路由: ${method} ${path}` });
  } catch (error) {
    if (error instanceof LedgerError) {
      const status = error.code === "CYCLE_DETECTED" ? 409 : error.code.startsWith("BAD") || error.code === "NOT_EMPTY" ? 400 : 422;
      return respond(status, { error: error.code, message: error.message, details: error.details });
    }
    const message = error instanceof Error ? error.message : String(error);
    return respond(500, { error: "INTERNAL", message });
  }
}
