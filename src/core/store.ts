import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LedgerState } from "./types.js";
import { fail } from "./errors.js";

export const EMPTY_STATE: LedgerState = {
  version: 1,
  blobs: {},
  aliases: {},
  runs: {},
  gcPlans: {}
};

export class LedgerStore {
  readonly dataDir: string;
  readonly stateFile: string;
  private state: LedgerState;

  private constructor(dataDir: string, state: LedgerState) {
    this.dataDir = dataDir;
    this.stateFile = join(dataDir, "ledger.json");
    this.state = state;
  }

  static async open(dataDir: string): Promise<LedgerStore> {
    await mkdir(dataDir, { recursive: true });
    const stateFile = join(dataDir, "ledger.json");
    let state: LedgerState;
    try {
      const raw = await readFile(stateFile, "utf8");
      state = JSON.parse(raw) as LedgerState;
      if (state.version !== 1) {
        fail("BAD_STATE", `不支持的账本版本: ${String(state.version)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        state = structuredClone(EMPTY_STATE);
        await writeFile(stateFile, JSON.stringify(state));
      } else {
        throw error;
      }
    }
    return new LedgerStore(dataDir, state);
  }

  get(): LedgerState {
    return this.state;
  }

  snapshot(): LedgerState {
    return structuredClone(this.state);
  }

  async save(): Promise<void> {
    const tmp = join(dirname(this.stateFile), `.ledger.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(tmp, JSON.stringify(this.state));
    await rename(tmp, this.stateFile);
  }

  async replaceAll(state: LedgerState): Promise<void> {
    this.state = structuredClone(state);
    await this.save();
  }

  async resetForTests(): Promise<void> {
    this.state = structuredClone(EMPTY_STATE);
    await this.save();
  }
}
