import { describe, it, expect } from "vitest";
import { createLedger, addBlob } from "./helpers.js";
import { LedgerError } from "../src/core/errors.js";

async function chainBlobs() {
  const created = await createLedger();
  const a = await addBlob(created.ledger, "a");
  const b = await addBlob(created.ledger, "b");
  const c = await addBlob(created.ledger, "c");
  return { ...created, a, b, c };
}

async function commit(ledger: Awaited<ReturnType<typeof createLedger>>["ledger"], inputs: string[], outputs: string[]) {
  const prepared = await ledger.prepareRun({
    inputs: inputs.map((blobId) => ({ blobId })),
    outputs: outputs.map((blobId) => ({ blobId }))
  });
  return ledger.commitRun(prepared.id);
}

describe("谱系禁止成环", () => {
  it("检测到环时返回具体路径", async () => {
    const created = await chainBlobs();
    try {
      await commit(created.ledger, [created.a], [created.b]);
      await commit(created.ledger, [created.b], [created.c]);

      const bad = await created.ledger.prepareRun({
        inputs: [{ blobId: created.c }],
        outputs: [{ blobId: created.a }]
      });
      const error = await created.ledger.commitRun(bad.id).catch((err) => err);
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe("CYCLE_DETECTED");
      const path = (error as LedgerError).details as { path: string[] };
      expect(path.path[0]).toBe(created.a);
      expect(path.path).toContain(created.a);
      expect(path.path).toContain(created.b);
      expect(path.path).toContain(created.c);
      expect(path.path[path.path.length - 1]).toBe(created.a);
      expect(path.path.length).toBeGreaterThanOrEqual(5);
      expect(created.ledger.getRun(bad.id).status).toBe("prepared");
    } finally {
      await created.cleanup();
    }
  });

  it("blob 同时作为同一运行输入输出直接成环", async () => {
    const created = await chainBlobs();
    try {
      await expect(
        created.ledger.prepareRun({
          inputs: [{ blobId: created.a }],
          outputs: [{ blobId: created.a }]
        })
      ).rejects.toThrow(/不能同时/);
    } finally {
      await created.cleanup();
    }
  });

  it("无环提交成功；撤销挡住新边的运行后可重新连线", async () => {
    const created = await chainBlobs();
    try {
      await commit(created.ledger, [created.a], [created.b]);
      const run2 = await commit(created.ledger, [created.b], [created.c]);
      expect(run2.status).toBe("committed");
      // c -> a 原本成环（a->b->c ... a）；撤销 run2 后 c 脱离链路，不再成环。
      await created.ledger.revokeRun(run2.id);
      const run3 = await commit(created.ledger, [created.c], [created.a]);
      expect(run3.status).toBe("committed");
    } finally {
      await created.cleanup();
    }
  });
});
