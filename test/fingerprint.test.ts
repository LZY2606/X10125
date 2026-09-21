import { describe, it, expect } from "vitest";
import { createLedger, addBlob, bytes, createLedger as ctx } from "./helpers.js";
import { LedgerError } from "../src/core/errors.js";

void ctx;

async function env() {
  const created = await createLedger();
  const input = await addBlob(created.ledger, "input-data");
  const output = await created.ledger.addBlob(bytes("output-data"));
  return { ...created, input, outputBlobId: output.blobId };
}

describe("规范化指纹与秘密掩码", () => {
  it("键顺序不同但内容一致时指纹相同", async () => {
    const a = await env();
    const b = await env();
    try {
      const runA = await a.ledger.prepareRun({
        inputs: [{ blobId: a.input }],
        outputs: [{ blobId: a.outputBlobId }],
        params: { a: 1, nested: { x: 1, y: 2 } }
      });
      const runB = await b.ledger.prepareRun({
        inputs: [{ blobId: b.input }],
        outputs: [{ blobId: b.outputBlobId }],
        params: { nested: { y: 2, x: 1 }, a: 1 }
      });
      expect(runB.fingerprint).toBe(runA.fingerprint);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it("参数值不同时指纹不同", async () => {
    const a = await env();
    const b = await env();
    try {
      const runA = await a.ledger.prepareRun({
        inputs: [{ blobId: a.input }],
        outputs: [{ blobId: a.outputBlobId }],
        params: { temperature: 0.1 }
      });
      const runB = await b.ledger.prepareRun({
        inputs: [{ blobId: b.input }],
        outputs: [{ blobId: b.outputBlobId }],
        params: { temperature: 0.9 }
      });
      expect(runB.fingerprint).not.toBe(runA.fingerprint);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it("秘密只保留哈希与展示掩码", async () => {
    const created = await env();
    try {
      const secret = "sk-secret-1234567890";
      const run = await created.ledger.prepareRun({
        inputs: [{ blobId: created.input }],
        outputs: [{ blobId: created.outputBlobId }],
        params: { token: { __secret__: secret }, other: "ok" }
      });
      const stored = JSON.stringify(run.params);
      expect(stored).not.toContain(secret);
      const token = (run.params as { token: { hash: string; mask: string; __secret__: boolean } }).token;
      expect(token.__secret__).toBe(true);
      expect(token.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(token.mask).toBe("s***90");
    } finally {
      await created.cleanup();
    }
  });

  it("两个不同秘密产生不同哈希，掩码不泄露全文", async () => {
    const a = await env();
    const b = await env();
    try {
      const runA = await a.ledger.prepareRun({
        inputs: [{ blobId: a.input }],
        outputs: [{ blobId: a.outputBlobId }],
        params: { token: { __secret__: "secret-alpha-value" } }
      });
      const runB = await b.ledger.prepareRun({
        inputs: [{ blobId: b.input }],
        outputs: [{ blobId: b.outputBlobId }],
        params: { token: { __secret__: "secret-beta-value" } }
      });
      const pa = (runA.params as { token: Record<string, unknown> }).token as { hash: string; mask: string };
      const pb = (runB.params as { token: Record<string, unknown> }).token as { hash: string; mask: string };
      expect(pa.hash).not.toBe(pb.hash);
      expect(pa.mask).not.toContain("alpha");
      expect(pb.mask).not.toContain("beta");
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it("相同秘密的指纹一致", async () => {
    const a = await env();
    const b = await env();
    try {
      const runA = await a.ledger.prepareRun({
        inputs: [{ blobId: a.input }],
        outputs: [{ blobId: a.outputBlobId }],
        params: { token: { __secret__: "same-secret" } }
      });
      const runB = await b.ledger.prepareRun({
        inputs: [{ blobId: b.input }],
        outputs: [{ blobId: b.outputBlobId }],
        params: { token: { __secret__: "same-secret" } }
      });
      expect(runA.fingerprint).toBe(runB.fingerprint);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it("非法 JSON 参数被拒绝", async () => {
    const created = await env();
    try {
      await expect(
        created.ledger.prepareRun({
          inputs: [{ blobId: created.input }],
          outputs: [{ blobId: created.outputBlobId }],
          params: { bad: 1n } as never
        })
      ).rejects.toBeInstanceOf(LedgerError);
    } finally {
      await created.cleanup();
    }
  });
});
