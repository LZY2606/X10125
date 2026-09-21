import { createReadStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fail } from "./errors.js";

export class BlobStore {
  constructor(private readonly root: string) {}

  private pathFor(blobId: string): string {
    const suffix = blobId.replace(/^blob-/, "");
    if (!/^[0-9a-f]{64}$/.test(suffix)) {
      fail("INVALID_BLOB_ID", `非法 blob 标识: ${blobId}`);
    }
    return join(this.root, suffix.slice(0, 2), suffix.slice(2, 4), suffix);
  }

  blobPath(blobId: string): string {
    return this.pathFor(blobId);
  }

  async has(blobId: string): Promise<boolean> {
    try {
      await stat(this.pathFor(blobId));
      return true;
    } catch {
      return false;
    }
  }

  async size(blobId: string): Promise<number> {
    try {
      return (await stat(this.pathFor(blobId))).size;
    } catch {
      fail("BLOB_MISSING", `blob 内容缺失: ${blobId}`);
    }
  }

  async put(buffer: Uint8Array): Promise<{ blobId: string; size: number; reused: boolean }> {
    const hash = createHash("sha256").update(buffer).digest("hex");
    const blobId = `blob-${hash}`;
    const target = this.pathFor(blobId);
    const existed = await this.has(blobId);
    if (existed) {
      return { blobId, size: buffer.byteLength, reused: true };
    }
    await mkdir(dirname(target), { recursive: true });
    const tmp = join(dirname(target), `.tmp-${process.pid}-${hash}-${Math.random().toString(36).slice(2)}`);
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    await import("node:fs/promises").then((fs) => fs.writeFile(tmp, bytes));
    await rename(tmp, target);
    return { blobId, size: bytes.byteLength, reused: false };
  }

  async verify(blobId: string): Promise<{ ok: boolean; expected: string; actual: string; size: number }> {
    const target = this.pathFor(blobId);
    const expected = blobId.replace(/^blob-/, "");
    const hash = createHash("sha256");
    let size = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(target);
        stream.on("data", (chunk: Buffer | string) => {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          size += bytes.byteLength;
          hash.update(bytes);
        });
        stream.on("end", () => resolve());
        stream.on("error", reject);
      });
    } catch {
      fail("BLOB_MISSING", `blob 内容缺失: ${blobId}`);
    }
    const actual = hash.digest("hex");
    return { ok: actual === expected, expected, actual, size };
  }

  async read(blobId: string): Promise<Buffer> {
    const fs = await import("node:fs/promises");
    try {
      return await fs.readFile(this.pathFor(blobId));
    } catch {
      fail("BLOB_MISSING", `blob 内容缺失: ${blobId}`);
    }
  }

  async delete(blobId: string): Promise<boolean> {
    const fs = await import("node:fs/promises");
    try {
      await fs.unlink(this.pathFor(blobId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  createReadStream(blobId: string): Readable {
    return createReadStream(this.pathFor(blobId));
  }
}
