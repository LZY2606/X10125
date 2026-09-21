import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/core/ledger.js";

export async function createLedger(): Promise<{ ledger: Ledger; dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "lineage-ledger-"));
  const ledger = await Ledger.open(dir);
  return {
    ledger,
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

export function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export async function addBlob(ledger: Ledger, text: string): Promise<string> {
  return (await ledger.addBlob(bytes(text))).blobId;
}
