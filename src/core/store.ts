import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalize, fingerprintParams } from "./canon.js";

export interface BlobMeta {
  hash: string;
  size: number;
  createdAt: string;
}

export interface Alias {
  name: string;
  hash: string;
  revoked: boolean;
  createdAt: string;
  revokedAt?: string;
}

export interface RunIo {
  hash: string;
  alias?: string | null;
}

export type RunStatus = "prepared" | "committed" | "aborted";

export interface Run {
  id: string;
  tool: { name: string; version: string };
  paramsCanonical: string;
  paramsHash: string;
  inputs: RunIo[];
  declaredOutputs: Array<{ alias?: string | null }>;
  outputs: RunIo[];
  status: RunStatus;
  revoked: boolean;
  fingerprint: string;
  createdAt: string;
  committedAt?: string;
  abortedAt?: string;
}

export interface GcPlan {
  id: string;
  createdAt: string;
  targets: string[];
  executions: Array<{ at: string; deleted: string[] }>;
}

export interface LedgerState {
  blobs: BlobMeta[];
  aliases: Alias[];
  runs: Run[];
  gcPlans: GcPlan[];
}

export class CycleError extends Error {
  constructor(public cyclePath: string[]) {
    super(`谱系成环: ${cyclePath.join(" -> ")}`);
    this.name = "CycleError";
  }
}

export class LedgerError extends Error {}

function now(): string {
  return new Date().toISOString();
}

function emptyState(): LedgerState {
  return { blobs: [], aliases: [], runs: [], gcPlans: [] };
}

export interface PrepareRunInput {
  tool: { name: string; version: string };
  params: unknown;
  inputs: RunIo[];
  declaredOutputs?: Array<{ alias?: string | null }>;
}

export interface ProofNode {
  blob: { hash: string; size: number };
  aliases: string[];
  producedBy: {
    id: string;
    tool: { name: string; version: string };
    paramsCanonical: string;
    paramsHash: string;
    fingerprint: string;
    status: RunStatus;
  } | null;
  inputs: ProofNode[];
}

export class LedgerStore {
  readonly dir: string;
  private state: LedgerState;

  constructor(dir: string) {
    this.dir = dir;
    this.state = emptyState();
    this.load();
  }

  private get blobsDir(): string {
    return path.join(this.dir, "blobs");
  }

  private get stateFile(): string {
    return path.join(this.dir, "state.json");
  }

  /** (Re)load state from disk. Simulates a process restart. */
  load(): void {
    fs.mkdirSync(this.blobsDir, { recursive: true });
    if (fs.existsSync(this.stateFile)) {
      this.state = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as LedgerState;
    } else {
      this.state = emptyState();
    }
  }

  private save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.stateFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }

  // ---------- blobs ----------

  putBlob(data: Buffer, alias?: string | null): { meta: BlobMeta; deduplicated: boolean } {
    const hash = createHash("sha256").update(data).digest("hex");
    const existing = this.state.blobs.find((b) => b.hash === hash);
    if (existing) {
      if (alias) this.setAlias(alias, hash);
      return { meta: existing, deduplicated: true };
    }
    const file = path.join(this.blobsDir, hash);
    const tmp = file + ".tmp-" + randomUUID();
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
    const meta: BlobMeta = { hash, size: data.length, createdAt: now() };
    this.state.blobs.push(meta);
    if (alias) this.setAlias(alias, hash);
    this.save();
    return { meta, deduplicated: false };
  }

  hasBlob(hash: string): boolean {
    return this.state.blobs.some((b) => b.hash === hash);
  }

  getBlob(hash: string): Buffer {
    const meta = this.state.blobs.find((b) => b.hash === hash);
    if (!meta) throw new LedgerError(`blob 不存在: ${hash}`);
    return fs.readFileSync(path.join(this.blobsDir, hash));
  }

  verifyBlob(hash: string): { hash: string; ok: boolean; actual: string } {
    const data = this.getBlob(hash);
    const actual = createHash("sha256").update(data).digest("hex");
    return { hash, ok: actual === hash, actual };
  }

  listBlobs(): BlobMeta[] {
    return [...this.state.blobs];
  }

  // ---------- aliases ----------

  setAlias(name: string, hash: string): Alias {
    if (!this.hasBlob(hash)) throw new LedgerError(`无法为不存在的 blob 设置别名: ${hash}`);
    const existing = this.state.aliases.find((a) => a.name === name);
    if (existing) {
      existing.hash = hash;
      existing.revoked = false;
      delete existing.revokedAt;
      this.save();
      return existing;
    }
    const alias: Alias = { name, hash, revoked: false, createdAt: now() };
    this.state.aliases.push(alias);
    this.save();
    return alias;
  }

  revokeAlias(name: string): void {
    const alias = this.state.aliases.find((a) => a.name === name);
    if (!alias) throw new LedgerError(`别名不存在: ${name}`);
    alias.revoked = true;
    alias.revokedAt = now();
    this.save();
  }

  listAliases(): Alias[] {
    return [...this.state.aliases];
  }

  aliasesFor(hash: string): string[] {
    return this.state.aliases.filter((a) => !a.revoked && a.hash === hash).map((a) => a.name);
  }

  // ---------- runs ----------

  prepareRun(input: PrepareRunInput): Run {
    for (const io of input.inputs) {
      if (!this.hasBlob(io.hash)) throw new LedgerError(`输入 blob 不存在: ${io.hash}`);
    }
    const { canonical, hash: paramsHash } = fingerprintParams(input.params ?? {});
    const declaredOutputs = input.declaredOutputs ?? [];
    const fingerprint = createHash("sha256")
      .update(
        canonicalize({
          tool: input.tool,
          paramsHash,
          inputs: input.inputs.map((i) => i.hash).sort(),
          declaredOutputs: declaredOutputs.map((o) => o.alias ?? null),
        })
      )
      .digest("hex");
    const run: Run = {
      id: `run-${randomUUID().slice(0, 8)}`,
      tool: input.tool,
      paramsCanonical: canonical,
      paramsHash,
      inputs: input.inputs,
      declaredOutputs,
      outputs: [],
      status: "prepared",
      revoked: false,
      fingerprint,
      createdAt: now(),
    };
    this.state.runs.push(run);
    this.save();
    return run;
  }

  commitRun(id: string, outputs: Array<{ data: Buffer; alias?: string | null }>): Run {
    const run = this.mustRun(id);
    if (run.status !== "prepared") {
      throw new LedgerError(`运行 ${id} 当前状态为 ${run.status}，无法 commit`);
    }
    const stored: RunIo[] = outputs.map((o) => {
      const { meta } = this.putBlob(o.data, null);
      return { hash: meta.hash, alias: o.alias ?? null };
    });
    this.assertAcyclic(run, stored.map((s) => s.hash));
    run.outputs = stored;
    run.status = "committed";
    run.committedAt = now();
    for (const io of stored) {
      if (io.alias) this.setAlias(io.alias, io.hash);
    }
    this.save();
    return run;
  }

  abortRun(id: string): Run {
    const run = this.mustRun(id);
    if (run.status !== "prepared") {
      throw new LedgerError(`运行 ${id} 当前状态为 ${run.status}，无法 abort`);
    }
    run.status = "aborted";
    run.abortedAt = now();
    this.save();
    return run;
  }

  revokeRun(id: string): Run {
    const run = this.mustRun(id);
    run.revoked = true;
    this.save();
    return run;
  }

  /** Runs left in `prepared` state — e.g. process died between prepare and commit. */
  danglingRuns(): Run[] {
    return this.state.runs.filter((r) => r.status === "prepared");
  }

  listRuns(): Run[] {
    return [...this.state.runs];
  }

  getRun(id: string): Run | undefined {
    return this.state.runs.find((r) => r.id === id);
  }

  private mustRun(id: string): Run {
    const run = this.getRun(id);
    if (!run) throw new LedgerError(`运行不存在: ${id}`);
    return run;
  }

  // ---------- lineage ----------

  private producingRun(hash: string): Run | undefined {
    return this.state.runs.find(
      (r) => r.status === "committed" && r.outputs.some((o) => o.hash === hash)
    );
  }

  /**
   * Ensure committing `run` with `outputHashes` cannot close a cycle:
   * none of the run's (transitive) ancestor runs may be the run itself,
   * and no input may be produced — directly or indirectly — from its outputs.
   */
  private assertAcyclic(run: Run, outputHashes: string[]): void {
    const producedByRun = new Set(outputHashes);
    // Walk ancestors of each input; if we reach `run` or anything it outputs, cycle.
    const visit = (hash: string, trail: string[]): void => {
      if (producedByRun.has(hash)) {
        throw new CycleError([...trail, `blob:${hash.slice(0, 12)}`, `run:${run.id}`]);
      }
      const producer = this.state.runs.find(
        (r) =>
          (r.status === "committed" || r.id === run.id || r.status === "prepared") &&
          r.outputs.some((o) => o.hash === hash)
      );
      if (!producer) return;
      if (producer.id === run.id) {
        throw new CycleError([...trail, `blob:${hash.slice(0, 12)}`, `run:${run.id}`]);
      }
      const next = [...trail, `blob:${hash.slice(0, 12)}`, `run:${producer.id}`];
      for (const input of producer.inputs) visit(input.hash, next);
    };
    for (const input of run.inputs) visit(input.hash, [`run:${run.id}`]);
  }

  /** Proof chain from a blob back to source inputs. */
  prove(hash: string, seen: Set<string> = new Set()): ProofNode {
    const meta = this.state.blobs.find((b) => b.hash === hash);
    if (!meta) throw new LedgerError(`blob 不存在: ${hash}`);
    const producer = this.producingRun(hash);
    const node: ProofNode = {
      blob: { hash: meta.hash, size: meta.size },
      aliases: this.aliasesFor(hash),
      producedBy: producer
        ? {
            id: producer.id,
            tool: producer.tool,
            paramsCanonical: producer.paramsCanonical,
            paramsHash: producer.paramsHash,
            fingerprint: producer.fingerprint,
            status: producer.status,
          }
        : null,
      inputs: [],
    };
    if (producer && !seen.has(producer.id)) {
      const nextSeen = new Set(seen).add(producer.id);
      node.inputs = producer.inputs.map((i) => this.prove(i.hash, nextSeen));
    }
    return node;
  }

  // ---------- garbage collection ----------

  private reachableHashes(): Set<string> {
    const reachable = new Set<string>();
    const queue: string[] = [];
    const push = (h: string) => {
      if (!reachable.has(h)) {
        reachable.add(h);
        queue.push(h);
      }
    };
    for (const alias of this.state.aliases) if (!alias.revoked) push(alias.hash);
    // Live runs root their inputs (prepared runs reserved them) and outputs.
    for (const run of this.state.runs) {
      if (run.revoked || run.status === "aborted") continue;
      for (const io of run.inputs) push(io.hash);
      for (const io of run.outputs) push(io.hash);
    }
    // A reachable committed run keeps its own inputs alive too (transitively).
    while (queue.length > 0) {
      const hash = queue.pop()!;
      const producer = this.producingRun(hash);
      if (producer && !producer.revoked) {
        for (const io of producer.inputs) push(io.hash);
        for (const io of producer.outputs) push(io.hash);
      }
    }
    return reachable;
  }

  planGc(): GcPlan {
    const reachable = this.reachableHashes();
    const targets = this.state.blobs
      .map((b) => b.hash)
      .filter((h) => !reachable.has(h))
      .sort();
    const plan: GcPlan = { id: `gc-${randomUUID().slice(0, 8)}`, createdAt: now(), targets, executions: [] };
    this.state.gcPlans.push(plan);
    this.save();
    return plan;
  }

  /** Idempotent: re-executing the same plan deletes nothing the second time. */
  executeGc(planId: string): { deleted: string[]; plan: GcPlan } {
    const plan = this.state.gcPlans.find((p) => p.id === planId);
    if (!plan) throw new LedgerError(`GC 计划不存在: ${planId}`);
    const reachable = this.reachableHashes();
    const deleted: string[] = [];
    for (const hash of plan.targets) {
      if (reachable.has(hash)) continue;
      const idx = this.state.blobs.findIndex((b) => b.hash === hash);
      if (idx === -1) continue; // already collected — idempotent
      this.state.blobs.splice(idx, 1);
      const file = path.join(this.blobsDir, hash);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      deleted.push(hash);
    }
    plan.executions.push({ at: now(), deleted });
    this.save();
    return { deleted, plan };
  }

  listGcPlans(): GcPlan[] {
    return [...this.state.gcPlans];
  }

  // ---------- archive ----------

  exportArchive(): Record<string, unknown> {
    return {
      format: "artifact-ledger-archive",
      version: 1,
      exportedAt: now(),
      state: this.state,
      blobs: this.state.blobs.map((b) => ({
        hash: b.hash,
        data: fs.readFileSync(path.join(this.blobsDir, b.hash)).toString("base64"),
      })),
    };
  }

  importArchive(archive: any): { blobs: number; runs: number } {
    if (archive?.format !== "artifact-ledger-archive") {
      throw new LedgerError("无法识别的归档格式");
    }
    if (this.state.blobs.length > 0 || this.state.runs.length > 0) {
      throw new LedgerError("目标实例非空，拒绝导入（归档只能导入空实例）");
    }
    const incoming = archive.state as LedgerState;
    for (const entry of archive.blobs as Array<{ hash: string; data: string }>) {
      const data = Buffer.from(entry.data, "base64");
      const actual = createHash("sha256").update(data).digest("hex");
      if (actual !== entry.hash) {
        throw new LedgerError(`归档内容校验失败: ${entry.hash}`);
      }
    }
    for (const entry of archive.blobs as Array<{ hash: string; data: string }>) {
      const file = path.join(this.blobsDir, entry.hash);
      if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(entry.data, "base64"));
    }
    this.state = {
      blobs: incoming.blobs ?? [],
      aliases: incoming.aliases ?? [],
      runs: incoming.runs ?? [],
      gcPlans: incoming.gcPlans ?? [],
    };
    this.save();
    return { blobs: this.state.blobs.length, runs: this.state.runs.length };
  }
}
