import { describe, it, expect } from "vitest";
import { createLedger, addBlob } from "./helpers.js";
import { exportArchive, importArchive, isEmptyState } from "../src/core/archive.js";
import { Ledger } from "../src/core/ledger.js";
import { LedgerError } from "../src/core/errors.js";

async function populated() {
  const created = await createLedger();
  const source = await addBlob(created.ledger, "archive-source");
  const middle = await addBlob(created.ledger, "archive-middle");
  const target = await addBlob(created.ledger, "archive-target");
  await created.ledger.bindAlias("src", source);
  const run1 = await created.ledger.prepareRun({
    inputs: [{ blobId: source, role: "data" }],
    outputs: [{ blobId: middle }],
    params: { k: { b: 2, a: 1 } },
    toolVersions: { tool: "1.0" }
  });
  await created.ledger.commitRun(run1.id);
  const run2 = await created.ledger.prepareRun({ inputs: [{ blobId: middle }], outputs: [{ blobId: target }] });
  await created.ledger.commitRun(run2.id);
  const preparedInput = await addBlob(created.ledger, "dangling-prepared-input");
  const preparedOutput = await addBlob(created.ledger, "dangling-prepared-output");
  const dangling = await created.ledger.prepareRun({
    inputs: [{ blobId: preparedInput }],
    outputs: [{ blobId: preparedOutput }],
    params: { secret: { __secret__: "hunter2hunter2" } }
  });
  const { plan: gcPlan } = await created.ledger.gcPlan();
  return { ...created, source, middle, target, dangling, gcPlanId: gcPlan.id };
}

describe("可移植归档", () => {
  it("导入空实例后哈希、边与运行状态保持不变", async () => {
    const created = await populated();
    const targetDir = await createLedger();
    try {
      const { data, info } = await exportArchive(created.ledger);
      expect(info.blobCount).toBe(5);

      const importedInfo = await importArchive(targetDir.ledger, data);
      expect(importedInfo.stateHash).toBe(info.stateHash);

      const before = created.ledger.snapshot();
      const after = targetDir.ledger.snapshot();
      expect(after).toEqual(before);

      expect(created.ledger.listPrepared().map((run) => run.id)).toEqual(
        targetDir.ledger.listPrepared().map((run) => run.id)
      );
      expect(targetDir.ledger.listPrepared()[0]?.status).toBe("prepared");

      for (const blobId of Object.keys(after.blobs)) {
        const verify = await targetDir.ledger.verifyBlob(blobId);
        expect(verify.ok).toBe(true);
      }

      const proofBefore = created.ledger.proof(created.source, created.target);
      const proofAfter = targetDir.ledger.proof(created.source, created.target);
      expect(proofAfter.found).toBe(true);
      expect(proofAfter.path).toEqual(proofBefore.path);
      expect(proofAfter.steps.map((step) => step.fingerprint)).toEqual(
        proofBefore.steps.map((step) => step.fingerprint)
      );

      expect(targetDir.ledger.graph()).toEqual(created.ledger.graph());
      expect(isEmptyState(targetDir.ledger.snapshot())).toBe(false);
    } finally {
      await created.cleanup();
      await targetDir.cleanup();
    }
  });

  it("非空实例拒绝导入", async () => {
    const created = await populated();
    const other = await createLedger();
    try {
      await addBlob(other.ledger, "existing");
      const { data } = await exportArchive(created.ledger);
      await expect(importArchive(other.ledger, data)).rejects.toBeInstanceOf(LedgerError);
    } finally {
      await created.cleanup();
      await other.cleanup();
    }
  });

  it("篡改 blob 内容的归档被拒绝", async () => {
    const created = await populated();
    const targetDir = await createLedger();
    try {
      const { data } = await exportArchive(created.ledger);
      const copy = new Uint8Array(data);
      copy[copy.length - 30] = (copy[copy.length - 30] ?? 0) ^ 0xff;
      await expect(importArchive(targetDir.ledger, copy)).rejects.toThrow();
    } finally {
      await created.cleanup();
      await targetDir.cleanup();
    }
  });

  it("归档跨全新目录打开后悬空运行仍可恢复 commit", async () => {
    const created = await populated();
    const targetDir = await createLedger();
    try {
      const { data } = await exportArchive(created.ledger);
      await importArchive(targetDir.ledger, data);
      const reopened = await Ledger.open(targetDir.dir);
      const committed = await reopened.commitRun(created.dangling.id);
      expect(committed.status).toBe("committed");
    } finally {
      await created.cleanup();
      await targetDir.cleanup();
    }
  });
});
