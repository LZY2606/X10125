import { describe, it, expect, afterEach } from "vitest";
import { stat } from "node:fs/promises";
import { createLedger, bytes } from "./helpers.js";

const contexts: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of contexts.splice(0)) await cleanup();
});

describe("内容寻址去重", () => {
  it("同一内容再次上传不复制存储", async () => {
    const { ledger, cleanup } = await createLedger();
    contexts.push(cleanup);
    const first = await ledger.addBlob(bytes("hello world"));
    expect(first.reused).toBe(false);
    const second = await ledger.addBlob(bytes("hello world"));
    expect(second.blobId).toBe(first.blobId);
    expect(second.reused).toBe(true);
    expect(second.size).toBe(first.size);

    const path = ledger.blobs.blobPath(first.blobId);
    const info = await stat(path);
    expect(info.size).toBe(first.size);
    const blobs = await ledger.listBlobs();
    expect(blobs).toHaveLength(1);
  });

  it("不同内容得到不同 blob", async () => {
    const { ledger, cleanup } = await createLedger();
    contexts.push(cleanup);
    const a = await ledger.addBlob(bytes("aaa"));
    const b = await ledger.addBlob(bytes("bbb"));
    expect(a.blobId).not.toBe(b.blobId);
  });
});
