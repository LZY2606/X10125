import { join } from "node:path";
import { BlobStore } from "./blob-store.js";
import { canonicalBytes } from "./canonical.js";
import { sha256Hex, sha256Id } from "./crypto.js";
import { fail } from "./errors.js";
import { runId, planId } from "./id.js";
import { redactParams } from "./secret.js";
import { LedgerStore } from "./store.js";
import type {
  BlobRecord,
  GcEntry,
  GcPlanRecord,
  JsonValue,
  LedgerState,
  RunRecord,
  RunStatus
} from "./types.js";

export interface PreparedInput {
  blobId: string;
  alias?: string;
  role?: string;
}

export interface PreparedOutput {
  blobId: string;
  role?: string;
  mediaType?: string;
  size?: number;
}

export interface PrepareOptions {
  inputs?: PreparedInput[];
  outputs?: PreparedOutput[];
  params?: JsonValue;
  toolVersions?: Record<string, string>;
  note?: string;
}

export interface GraphView {
  nodes: Array<{ id: string; kind: "blob" | "run"; label: string; status?: RunStatus }>;
  edges: Array<{ from: string; to: string; label?: string }>;
}

export interface ProofStep {
  kind: "run";
  runId: string;
  from: string[];
  to: string[];
  params: JsonValue;
  toolVersions: Record<string, string>;
  fingerprint: string;
}

export interface ProofChain {
  source: string;
  target: string;
  steps: ProofStep[];
  path: string[];
  found: boolean;
}

interface GraphNode {
  outputs: string[];
}

export class Ledger {
  private constructor(
    readonly dataDir: string,
    readonly store: LedgerStore,
    readonly blobs: BlobStore
  ) {}

  static async open(dataDir: string): Promise<Ledger> {
    const store = await LedgerStore.open(dataDir);
    const blobStore = new BlobStore(join(dataDir, "blobs"));
    return new Ledger(dataDir, store, blobStore);
  }

  private get state(): LedgerState {
    return this.store.get();
  }

  private now(): string {
    return new Date().toISOString();
  }

  private save(): Promise<void> {
    return this.store.save();
  }

  snapshot(): LedgerState {
    return this.store.snapshot();
  }

  async resetForTests(): Promise<void> {
    await this.store.resetForTests();
  }

  async replaceStateForImport(state: LedgerState): Promise<void> {
    await this.store.replaceAll(state);
  }

  async addBlob(data: Uint8Array): Promise<{ blobId: string; reused: boolean; size: number }> {
    const { blobId, reused, size } = await this.blobs.put(data);
    if (!this.state.blobs[blobId]) {
      const record: BlobRecord = { id: blobId, size, createdAt: this.now() };
      this.state.blobs[blobId] = record;
      await this.save();
    }
    return { blobId, reused, size };
  }

  async bindAlias(name: string, blobId: string): Promise<void> {
    this.requireBlob(blobId);
    if (!(await this.blobs.has(blobId))) {
      fail("BLOB_MISSING", `blob 内容缺失: ${blobId}`);
    }
    const existing = this.state.aliases[name];
    if (existing && existing.blobId !== blobId && !existing.revoked) {
      fail("ALIAS_CONFLICT", `别名 ${name} 已绑定到其它 blob，需先撤销`);
    }
    this.state.aliases[name] = { name, blobId, createdAt: this.now(), revoked: false };
    await this.save();
  }

  async revokeAlias(name: string): Promise<void> {
    const alias = this.state.aliases[name];
    if (!alias) {
      fail("NOT_FOUND", `别名不存在: ${name}`);
    }
    alias.revoked = true;
    await this.save();
  }

  private requireBlob(blobId: string): BlobRecord {
    const blob = this.state.blobs[blobId];
    if (!blob) {
      fail("UNKNOWN_BLOB", `未登记的 blob: ${blobId}`);
    }
    return blob;
  }

  private requireRun(id: string): RunRecord {
    const run = this.state.runs[id];
    if (!run) {
      fail("UNKNOWN_RUN", `运行不存在: ${id}`);
    }
    return run;
  }

  private validateJsonLike(value: unknown, path = "$"): void {
    const type = typeof value;
    if (value === null) return;
    if (type === "string" || type === "number" || type === "boolean") return;
    if (type === "bigint" || type === "function" || type === "symbol" || type === "undefined") {
      fail("BAD_PARAMS", `参数在 ${path} 处不是 JSON 兼容类型`);
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => this.validateJsonLike(item, `${path}[${index}]`));
      return;
    }
    if (type === "object") {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        this.validateJsonLike(item, `${path}.${key}`);
      }
    }
  }

  private buildFingerprint(
    inputs: Record<string, { alias?: string; role?: string }>,
    outputs: Record<string, { size: number; role?: string; mediaType?: string }>,
    params: JsonValue,
    toolVersions: Record<string, string>
  ): string {
    const inputFingerprint = Object.keys(inputs)
      .sort()
      .map((key) => ({ name: key, ...inputs[key] }));
    const outputFingerprint = Object.keys(outputs)
      .sort()
      .map((key) => ({ name: key, blobId: key, ...outputs[key] }));
    const payload: JsonValue = {
      v: 1,
      inputs: inputFingerprint as unknown as JsonValue,
      outputs: outputFingerprint as unknown as JsonValue,
      params,
      toolVersions: toolVersions as unknown as JsonValue
    };
    return sha256Id("fp", canonicalBytes(payload));
  }

  async prepareRun(options: PrepareOptions): Promise<RunRecord> {
    const inputMap: RunRecord["inputs"] = {};
    for (const input of options.inputs ?? []) {
      this.requireBlob(input.blobId);
      if (!(await this.blobs.has(input.blobId))) {
        fail("BLOB_MISSING", `输入 blob 内容缺失: ${input.blobId}`);
      }
      inputMap[input.blobId] = { alias: input.alias, role: input.role };
    }

    const outputMap: RunRecord["outputs"] = {};
    for (const output of options.outputs ?? []) {
      if (!/^blob-[0-9a-f]{64}$/.test(output.blobId)) {
        fail("INVALID_BLOB_ID", `非法输出 blob 标识: ${output.blobId}`);
      }
      if (outputMap[output.blobId]) {
        fail("BAD_OUTPUT", `同一运行的输出不能重复声明: ${output.blobId}`);
      }
      if (inputMap[output.blobId]) {
        fail("BAD_OUTPUT", `blob 不能同时作为同一运行的输入和输出: ${output.blobId}`);
      }
      const known = this.state.blobs[output.blobId];
      outputMap[output.blobId] = {
        role: output.role,
        mediaType: output.mediaType,
        size: output.size ?? known?.size ?? 0
      };
    }

    const params = (options.params ?? {}) as JsonValue;
    this.validateJsonLike(params);
    const redacted = redactParams(params);
    const toolVersions: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.toolVersions ?? {})) {
      toolVersions[key] = String(value);
    }

    const record: RunRecord = {
      id: runId(),
      status: "prepared",
      createdAt: this.now(),
      inputs: inputMap,
      outputs: outputMap,
      params: redacted,
      toolVersions,
      fingerprint: this.buildFingerprint(inputMap, outputMap, redacted, toolVersions),
      note: options.note
    };
    this.state.runs[record.id] = record;
    await this.save();
    return structuredClone(record);
  }

  private nodeGraph(): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    const add = (from: string, to: string): void => {
      const list = graph.get(from) ?? [];
      if (!list.includes(to)) list.push(to);
      graph.set(from, list);
    };
    for (const run of Object.values(this.state.runs)) {
      if (run.status !== "committed") continue;
      for (const inputId of Object.keys(run.inputs)) {
        add(inputId, run.id);
      }
      for (const outputId of Object.keys(run.outputs)) {
        add(run.id, outputId);
      }
    }
    return graph;
  }

  private findPath(graph: Map<string, string[]>, from: string, to: string): string[] | null {
    const queue: Array<{ id: string; path: string[] }> = [{ id: from, path: [from] }];
    const seen = new Set<string>([from]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of graph.get(current.id) ?? []) {
        if (seen.has(next)) continue;
        const path = [...current.path, next];
        if (next === to) return path;
        seen.add(next);
        queue.push({ id: next, path });
      }
    }
    return null;
  }

  private findRunCycle(newRun: RunRecord): string[] | null {
    const graph = this.nodeGraph();
    for (const outputId of Object.keys(newRun.outputs)) {
      for (const inputId of Object.keys(newRun.inputs)) {
        if (outputId === inputId) return [outputId, newRun.id, outputId];
        const path = this.findPath(graph, outputId, inputId);
        if (path) return [...path, newRun.id, outputId];
      }
    }
    return null;
  }

  async commitRun(id: string): Promise<RunRecord> {
    const run = this.requireRun(id);
    if (run.status !== "prepared") {
      fail("BAD_STATUS", `运行 ${id} 当前状态为 ${run.status}，无法 commit`, { status: run.status });
    }
    for (const blobId of Object.keys(run.outputs)) {
      if (!this.state.blobs[blobId] || !(await this.blobs.has(blobId))) {
        fail("OUTPUT_MISSING", `输出 blob 尚未提供，无法 commit: ${blobId}`, { recoverable: true });
      }
    }
    const cycle = this.findRunCycle(run);
    if (cycle) {
      fail("CYCLE_DETECTED", `提交将形成环路: ${cycle.join(" -> ")}`, { path: cycle });
    }
    run.status = "committed";
    run.committedAt = this.now();
    run.endedAt = run.committedAt;
    await this.save();
    return structuredClone(run);
  }

  async abortRun(id: string, reason?: string): Promise<RunRecord> {
    const run = this.requireRun(id);
    if (run.status !== "prepared") {
      fail("BAD_STATUS", `运行 ${id} 当前状态为 ${run.status}，无法 abort`, { status: run.status });
    }
    run.status = "aborted";
    run.endedAt = this.now();
    if (reason) run.note = run.note ? `${run.note} | abort: ${reason}` : `abort: ${reason}`;
    await this.save();
    return structuredClone(run);
  }

  async revokeRun(id: string): Promise<RunRecord> {
    const run = this.requireRun(id);
    if (run.status === "revoked") {
      fail("BAD_STATUS", `运行 ${id} 已撤销`, { status: run.status });
    }
    run.status = "revoked";
    run.endedAt = this.now();
    await this.save();
    return structuredClone(run);
  }

  listRuns(): RunRecord[] {
    return Object.values(this.state.runs)
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((run) => structuredClone(run));
  }

  listPrepared(): RunRecord[] {
    return this.listRuns().filter((run) => run.status === "prepared");
  }

  getRun(id: string): RunRecord {
    return structuredClone(this.requireRun(id));
  }

  async listBlobs(): Promise<Array<BlobRecord & { present: boolean }>> {
    return Promise.all(
      Object.values(this.state.blobs).map(async (blob) => ({
        ...structuredClone(blob),
        present: await this.blobs.has(blob.id)
      }))
    );
  }

  graph(): GraphView {
    const nodes = new Map<string, GraphView["nodes"][number]>();
    const edges: GraphView["edges"] = [];
    const labelFor = (blobId: string): string => {
      const alias = Object.values(this.state.aliases).find((item) => !item.revoked && item.blobId === blobId);
      return alias ? alias.name : blobId.slice(0, 13);
    };
    for (const run of Object.values(this.state.runs)) {
      if (run.status !== "committed") continue;
      nodes.set(run.id, { id: run.id, kind: "run", label: run.id.slice(0, 10), status: run.status });
      for (const blobId of Object.keys(run.inputs)) {
        if (!nodes.has(blobId)) nodes.set(blobId, { id: blobId, kind: "blob", label: labelFor(blobId) });
        edges.push({ from: blobId, to: run.id });
      }
      for (const blobId of Object.keys(run.outputs)) {
        if (!nodes.has(blobId)) nodes.set(blobId, { id: blobId, kind: "blob", label: labelFor(blobId) });
        edges.push({ from: run.id, to: blobId });
      }
    }
    for (const alias of Object.values(this.state.aliases)) {
      if (alias.revoked) continue;
      if (!nodes.has(alias.blobId)) {
        nodes.set(alias.blobId, { id: alias.blobId, kind: "blob", label: alias.name });
      }
    }
    const sortedNodes = [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const sortedEdges = edges
      .slice()
      .sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) : a.from < b.from ? -1 : 1));
    return { nodes: sortedNodes, edges: sortedEdges };
  }

  proof(source: string, target: string): ProofChain {
    this.requireBlob(source);
    this.requireBlob(target);
    const runs = Object.values(this.state.runs).filter((run) => run.status === "committed");
    interface Step {
      runId: string;
      run: RunRecord;
    }
    const queue: Array<{ blob: string; steps: Step[]; path: string[] }> = [
      { blob: source, steps: [], path: [source] }
    ];
    const seen = new Set<string>([source]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.blob === target) {
        return {
          source,
          target,
          found: true,
          path: current.path,
          steps: current.steps.map(({ runId, run }) => ({
            kind: "run" as const,
            runId,
            from: Object.keys(run.inputs),
            to: Object.keys(run.outputs),
            params: structuredClone(run.params),
            toolVersions: { ...run.toolVersions },
            fingerprint: run.fingerprint
          }))
        };
      }
      for (const run of runs) {
        if (!run.inputs[current.blob]) continue;
        for (const outputId of Object.keys(run.outputs)) {
          if (!seen.has(outputId)) {
            seen.add(outputId);
            queue.push({
              blob: outputId,
              steps: [...current.steps, { runId: run.id, run }],
              path: [...current.path, run.id, outputId]
            });
          }
        }
      }
    }
    return { source, target, found: false, steps: [], path: [] };
  }

  reachableBlobIds(): Set<string> {
    const reachable = new Set<string>();
    for (const alias of Object.values(this.state.aliases)) {
      if (!alias.revoked && this.state.blobs[alias.blobId]) reachable.add(alias.blobId);
    }
    const preparedInputs = (run: RunRecord): void => {
      for (const blobId of Object.keys(run.inputs)) reachable.add(blobId);
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const run of Object.values(this.state.runs)) {
        if (run.status === "aborted" || run.status === "revoked") continue;
        if (run.status === "prepared") {
          const before = reachable.size;
          preparedInputs(run);
          if (reachable.size !== before) changed = true;
          continue;
      }
        const hasReachableInput = Object.keys(run.inputs).some((blobId) => reachable.has(blobId));
        if (hasReachableInput) {
          for (const blobId of Object.keys(run.outputs)) {
            if (!reachable.has(blobId)) {
              reachable.add(blobId);
              changed = true;
            }
          }
        }
      }
    }
    return reachable;
  }

  async gcPlan(): Promise<{ plan: GcPlanRecord; entries: GcEntry[] }> {
    const reachable = this.reachableBlobIds();
    const entries: GcEntry[] = [];
    const alreadyTargeted = new Set<string>();
    for (const plan of Object.values(this.state.gcPlans)) {
      if (plan.status === "pending") {
        for (const entry of plan.entries) alreadyTargeted.add(entry.blobId);
      }
    }
    for (const blob of Object.values(this.state.blobs)) {
      if (reachable.has(blob.id) || alreadyTargeted.has(blob.id)) continue;
      const present = await this.blobs.has(blob.id);
      if (!present) continue;
      entries.push({ blobId: blob.id, size: blob.size, reason: "不可从任何存活别名或谱系边到达" });
    }
    const plan: GcPlanRecord = {
      id: planId(),
      createdAt: this.now(),
      entries,
      status: "pending",
      deleted: [],
      missing: []
    };
    this.state.gcPlans[plan.id] = plan;
    await this.save();
    return { plan: structuredClone(plan), entries };
  }

  listGcPlans(): GcPlanRecord[] {
    return Object.values(this.state.gcPlans)
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((plan) => structuredClone(plan));
  }

  async executeGcPlan(id: string): Promise<GcPlanRecord> {
    const plan = this.state.gcPlans[id];
    if (!plan) {
      fail("UNKNOWN_PLAN", `回收计划不存在: ${id}`);
    }
    if (plan.status === "executed") {
      return structuredClone(plan);
    }
    for (const entry of plan.entries) {
      if (this.reachableBlobIds().has(entry.blobId)) {
        plan.missing.push(entry.blobId);
        continue;
      }
      const removed = await this.blobs.delete(entry.blobId);
      if (removed) {
        plan.deleted.push(entry.blobId);
      } else {
        plan.missing.push(entry.blobId);
      }
    }
    plan.status = "executed";
    plan.executedAt = this.now();
    await this.save();
    return structuredClone(plan);
  }

  async verifyBlob(blobId: string): Promise<{ ok: boolean; expected: string; actual: string; size: number }> {
    this.requireBlob(blobId);
    return this.blobs.verify(blobId);
  }

  async readBlob(blobId: string): Promise<Buffer> {
    this.requireBlob(blobId);
    return this.blobs.read(blobId);
  }

  hasBlobContent(blobId: string): Promise<boolean> {
    return this.blobs.has(blobId);
  }
}
