import { describe, it, expect } from "vitest";
import { Ledger } from "../src/core/ledger.js";
import { createLedger, addBlob } from "./helpers.js";

describe("prepare 后崩溃再重启", () => {
  it("悬空运行在重启后展示为可恢复，而不是被删除或当作成功", async () => {
    const created = await createLedger();
    try {
      const input = await addBlob(created.ledger, "source");
      const output = await addBlob(created.ledger, "future-output");
      const dangling = await created.ledger.prepareRun({
        inputs: [{ blobId: input }],
        outputs: [{ blobId: output }],
        params: { step: 1 },
        note: "进程即将退出"
      });

      const reopened = await Ledger.open(created.dir);
      const prepared = reopened.listPrepared();
      expect(prepared.map((run) => run.id)).toContain(dangling.id);
      expect(prepared[0]?.status).toBe("prepared");
      expect(prepared[0]?.fingerprint).toBe(dangling.fingerprint);

      const graph = reopened.graph();
      expect(graph.nodes.some((node) => node.id === dangling.id)).toBe(false);

      const committed = await reopened.commitRun(dangling.id);
      expect(committed.status).toBe("committed");
      const after = await Ledger.open(created.dir);
      expect(after.listPrepared()).toHaveLength(0);
    } finally {
      await created.cleanup();
    }
  });

  it("输出尚未上传时 commit 被拒绝，重启后仍可 abort", async () => {
    const created = await createLedger();
    try {
      const input = await addBlob(created.ledger, "only-input");
      const declaredOutput = `blob-${"f".repeat(64)}`;
      const dangling = await created.ledger.prepareRun({
        inputs: [{ blobId: input }],
        outputs: [{ blobId: declaredOutput, size: 10 }]
      });

      const reopened = await Ledger.open(created.dir);
      await expect(reopened.commitRun(dangling.id)).rejects.toMatchObject({ code: "OUTPUT_MISSING" });
      expect(reopened.listPrepared().map((run) => run.id)).toContain(dangling.id);

      const aborted = await reopened.abortRun(dangling.id, "输出未提供");
      expect(aborted.status).toBe("aborted");
      expect(reopened.listPrepared()).toHaveLength(0);
    } finally {
      await created.cleanup();
    }
  });
});
