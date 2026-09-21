import { join, posix } from "node:path";
import { createTarGz, readTarGz } from "./tar.js";
import { fail } from "./errors.js";
import { sha256Hex } from "./crypto.js";
import { canonicalBytes } from "./canonical.js";
import type { LedgerState } from "./types.js";
import type { Ledger } from "./ledger.js";

export interface ArchiveInfo {
  stateHash: string;
  blobCount: number;
  createdAt: string;
  missingBlobs?: string[];
}

export async function exportArchive(ledger: Ledger): Promise<{ data: Uint8Array; info: ArchiveInfo }> {
  const state = ledger.snapshot();
  const stateJson = canonicalBytes(state as unknown as import("./types.js").JsonValue);
  const entries: Array<{ path: string; data: Uint8Array }> = [
    { path: "ledger-state.json", data: stateJson }
  ];
  let blobCount = 0;
  const missingBlobs: string[] = [];
  for (const blobId of Object.keys(state.blobs).sort()) {
    if (!(await ledger.hasBlobContent(blobId))) {
      missingBlobs.push(blobId);
      continue;
    }
    const data = await ledger.readBlob(blobId);
    entries.push({ path: posix.join("blobs", blobId), data: new Uint8Array(data) });
    blobCount++;
  }
  const info: ArchiveInfo = {
    stateHash: sha256Hex(stateJson),
    blobCount,
    missingBlobs,
    createdAt: new Date().toISOString()
  };
  entries.push({ path: "MANIFEST.json", data: canonicalBytes(info as unknown as import("./types.js").JsonValue) });
  return { data: createTarGz(entries), info };
}

export function isEmptyState(state: LedgerState): boolean {
  return (
    Object.keys(state.blobs).length === 0 &&
    Object.keys(state.aliases).length === 0 &&
    Object.keys(state.runs).length === 0 &&
    Object.keys(state.gcPlans).length === 0
  );
}

export async function importArchive(ledger: Ledger, data: Uint8Array, options?: { force?: boolean }): Promise<ArchiveInfo> {
  const current = ledger.snapshot();
  if (!isEmptyState(current) && !options?.force) {
    fail("NOT_EMPTY", "仅允许向空实例导入归档；如需覆盖请显式指定 force");
  }
  let entries;
  try {
    entries = readTarGz(data);
  } catch (error) {
    fail("BAD_ARCHIVE", `归档不是合法的 tar.gz：${(error as Error).message}`);
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry.data]));
  const stateBytes = byPath.get("ledger-state.json");
  if (!stateBytes) {
    fail("BAD_ARCHIVE", "归档缺少 ledger-state.json");
  }
  const state = JSON.parse(new TextDecoder().decode(stateBytes)) as LedgerState;
  if (state.version !== 1) {
    fail("BAD_ARCHIVE", `归档账本版本不支持: ${String(state.version)}`);
  }
  const manifestBytes = byPath.get("MANIFEST.json");
  const declared = manifestBytes ? (JSON.parse(new TextDecoder().decode(manifestBytes)) as Partial<ArchiveInfo>) : undefined;
  const stateHash = sha256Hex(stateBytes);
  if (declared?.stateHash && declared.stateHash !== stateHash) {
    fail("ARCHIVE_HASH_MISMATCH", "状态哈希与 MANIFEST 不一致", { declared: declared.stateHash, actual: stateHash });
  }
  const fs = await import("node:fs/promises");
  const blobRoot = join(ledger.dataDir, "blobs");
  for (const blobId of Object.keys(state.blobs)) {
    const bytes = byPath.get(posix.join("blobs", blobId));
    if (!bytes) continue;
    if (`blob-${sha256Hex(bytes)}` !== blobId) {
      fail("ARCHIVE_HASH_MISMATCH", `blob 内容哈希不匹配: ${blobId}`);
    }
    const suffix = blobId.replace(/^blob-/, "");
    const target = join(blobRoot, suffix.slice(0, 2), suffix.slice(2, 4), suffix);
    await fs.mkdir(join(blobRoot, suffix.slice(0, 2), suffix.slice(2, 4)), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  await ledger.replaceStateForImport(state);
  return {
    stateHash,
    blobCount: Object.keys(state.blobs).length,
    createdAt: declared?.createdAt ?? new Date().toISOString()
  };
}
