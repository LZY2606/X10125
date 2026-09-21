import { describe, it, expect } from "vitest";
import { createLedger, addBlob, bytes } from "./helpers.js";
import { handleApi } from "../src/server/api.js";
import type { ApiRequest } from "../src/server/api.js";

function request(partial: Partial<ApiRequest> & { url: string }): ApiRequest {
  return { method: "GET", body: null, headers: {}, ...partial };
}

async function json<T>(response: { status: number; body: Uint8Array }): Promise<T> {
  expect(response.status).toBe(200);
  return JSON.parse(new TextDecoder().decode(response.body)) as T;
}

describe("证明链与机器 API", () => {
  it("返回从源输入到目标的运行与参数；无路径时 found=false", async () => {
    const created = await createLedger();
    try {
      const source = await addBlob(created.ledger, "p-source");
      const middle = await addBlob(created.ledger, "p-middle");
      const target = await addBlob(created.ledger, "p-target");
      const prep1 = await created.ledger.prepareRun({
        inputs: [{ blobId: source }],
        outputs: [{ blobId: middle }],
        params: { op: "transform", n: 3 }
      });
      await created.ledger.commitRun(prep1.id);
      const prep2 = await created.ledger.prepareRun({
        inputs: [{ blobId: middle }],
        outputs: [{ blobId: target }],
        params: { op: "final" }
      });
      await created.ledger.commitRun(prep2.id);

      const ok = await json<{
        found: boolean;
        path: string[];
        steps: Array<{ runId: string; params: { op: string }; fingerprint: string }>;
      }>(await handleApi(created.ledger, request({ url: `/api/proof?source=${source}&target=${target}` })));
      expect(ok.found).toBe(true);
      expect(ok.path[0]).toBe(source);
      expect(ok.path[ok.path.length - 1]).toBe(target);
      expect(ok.steps).toHaveLength(2);
      expect(ok.steps[0]?.params.op).toBe("transform");
      expect(ok.steps[0]?.fingerprint).toMatch(/^fp-/);

      const missing = await json<{ found: boolean }>(
        await handleApi(created.ledger, request({ url: `/api/proof?source=${target}&target=${source}` }))
      );
      expect(missing.found).toBe(false);
    } finally {
      await created.cleanup();
    }
  });

  it("上传 API 去重并可经 x-alias 绑定别名", async () => {
    const created = await createLedger();
    try {
      const body = bytes("api-dedup");
      const first = await json<{ blobId: string; reused: boolean }>(
        await handleApi(created.ledger, request({ method: "POST", url: "/api/blobs", body, headers: { "x-alias": "v1" } }))
      );
      const second = await json<{ blobId: string; reused: boolean; alias: string }>(
        await handleApi(created.ledger, request({ method: "POST", url: "/api/blobs", body }))
      );
      expect(second.blobId).toBe(first.blobId);
      expect(second.reused).toBe(true);
      const state = await json<{ state: { aliases: Record<string, { blobId: string }> } }>(
        await handleApi(created.ledger, request({ url: "/api/state" }))
      );
      expect(state.state.aliases.v1?.blobId).toBe(first.blobId);
    } finally {
      await created.cleanup();
    }
  });

  it("环路 API 返回 409 和具体路径", async () => {
    const created = await createLedger();
    try {
      const a = await addBlob(created.ledger, "cycle-a");
      const b = await addBlob(created.ledger, "cycle-b");
      const run1 = await created.ledger.prepareRun({ inputs: [{ blobId: a }], outputs: [{ blobId: b }] });
      await created.ledger.commitRun(run1.id);
      const run2 = await created.ledger.prepareRun({ inputs: [{ blobId: b }], outputs: [{ blobId: a }] });
      const response = await handleApi(created.ledger, request({ method: "POST", url: `/api/runs/${run2.id}/commit` }));
      expect(response.status).toBe(409);
      const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
        error: string;
        details: { path: string[] };
      };
      expect(payload.error).toBe("CYCLE_DETECTED");
      expect(payload.details.path[0]).toBe(a);
      expect(payload.details.path.at(-1)).toBe(a);
    } finally {
      await created.cleanup();
    }
  });
});
