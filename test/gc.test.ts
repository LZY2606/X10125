import { describe, it, expect } from "vitest";
import { createLedger, addBlob } from "./helpers.js";

async function commitPair(ledger: Awaited<ReturnType<typeof createLedger>>["ledger"], input: string, output: string) {
  const run = await ledger.prepareRun({ inputs: [{ blobId: input }], outputs: [{ blobId: output }] });
  await ledger.commitRun(run.id);
  return run;
}

describe("垃圾回收引用与计划幂等", () => {
  it("被可达节点引用的内容不得回收，孤立内容进入计划", async () => {
    const created = await createLedger();
    try {
      const source = await addBlob(created.ledger, "kept-source");
      await created.ledger.bindAlias("model:latest", source);
      const out1 = await addBlob(created.ledger, "derived-out");
      await commitPair(created.ledger, source, out1);

      const orphan = await addBlob(created.ledger, "nobody-needs-me");
      const reachable = created.ledger.reachableBlobIds();
      expect(reachable.has(source)).toBe(true);
      expect(reachable.has(out1)).toBe(true);
      expect(reachable.has(orphan)).toBe(false);

      const { plan } = await created.ledger.gcPlan();
      expect(plan.entries.map((entry) => entry.blobId)).toEqual([orphan]);

      const executed = await created.ledger.executeGcPlan(plan.id);
      expect(executed.deleted).toEqual([orphan]);
      expect(await created.ledger.hasBlobContent(orphan)).toBe(false);
      expect(await created.ledger.hasBlobContent(source)).toBe(true);
      expect(await created.ledger.hasBlobContent(out1)).toBe(true);
    } finally {
      await created.cleanup();
    }
  });

  it("撤销别名后衍生内容仍由链路保留；再撤销运行才被回收", async () => {
    const created = await createLedger();
    try {
      const source = await addBlob(created.ledger, "g1");
      await created.ledger.bindAlias("g", source);
      const out = await addBlob(created.ledger, "g2");
      const run = await commitPair(created.ledger, source, out);
      await created.ledger.revokeAlias("g");
      expect(created.ledger.reachableBlobIds().has(out)).toBe(false);

      const { plan } = await created.ledger.gcPlan();
      expect(plan.entries.some((entry) => entry.blobId === out)).toBe(true);

      // 重新绑定别名让内容再次可达，再执行旧计划时不得删除它（引用保护）。
      await created.ledger.bindAlias("g2-alias", out);
      const reachableAfterRebind = created.ledger.reachableBlobIds();
      expect(reachableAfterRebind.has(out)).toBe(true);
      const guarded = await created.ledger.executeGcPlan(plan.id);
      expect(guarded.deleted).not.toContain(out);
      expect(await created.ledger.hasBlobContent(out)).toBe(true);

      await created.ledger.revokeAlias("g2-alias");
      await created.ledger.revokeRun(run.id);
      const next = await created.ledger.gcPlan();
      expect(next.plan.entries.some((entry) => entry.blobId === out)).toBe(true);
      const executed = await created.ledger.executeGcPlan(next.plan.id);
      expect(executed.deleted).toContain(out);
      expect(await created.ledger.hasBlobContent(out)).toBe(false);
    } finally {
      await created.cleanup();
    }
  });

  it("重复执行同一计划不会多删", async () => {
    const created = await createLedger();
    try {
      const orphan = await addBlob(created.ledger, "orphan");
      const { plan } = await created.ledger.gcPlan();
      const first = await created.ledger.executeGcPlan(plan.id);
      const second = await created.ledger.executeGcPlan(plan.id);
      const third = await created.ledger.executeGcPlan(plan.id);
      expect(first.deleted).toEqual([orphan]);
      expect(second.deleted).toEqual([orphan]);
      expect(third.deleted).toEqual([orphan]);
      expect(second.missing).toEqual([]);
      expect(third.status).toBe("executed");
      expect(await created.ledger.hasBlobContent(orphan)).toBe(false);
    } finally {
      await created.cleanup();
    }
  });

  it("prepared 运行的输入预留引用受保护", async () => {
    const created = await createLedger();
    try {
      const reserved = await addBlob(created.ledger, "reserved-input");
      const out = await addBlob(created.ledger, "reserved-output");
      await created.ledger.prepareRun({ inputs: [{ blobId: reserved }], outputs: [{ blobId: out }] });
      const reachable = created.ledger.reachableBlobIds();
      expect(reachable.has(reserved)).toBe(true);
      const { plan } = await created.ledger.gcPlan();
      expect(plan.entries.some((entry) => entry.blobId === reserved)).toBe(false);
    } finally {
      await created.cleanup();
    }
  });
});
