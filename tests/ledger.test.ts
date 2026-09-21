import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LedgerStore, CycleError } from "../src/core/store.js";
import { canonicalize, fingerprintParams, scrubSecrets } from "../src/core/canon.js";

let dir: string;
let store: LedgerStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
  store = new LedgerStore(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function commitSimpleRun(
  s: LedgerStore,
  inputs: Array<{ hash: string }>,
  outputData: Buffer,
  outputAlias?: string
) {
  const run = s.prepareRun({
    tool: { name: "t", version: "1" },
    params: {},
    inputs,
    declaredOutputs: outputAlias ? [{ alias: outputAlias }] : [],
  });
  return s.commitRun(run.id, [{ data: outputData, alias: outputAlias ?? null }]);
}

describe("内容寻址与去重", () => {
  it("同一内容再次上传不会复制存储", () => {
    const data = Buffer.from("hello provenance");
    const a = store.putBlob(data, "first");
    const b = store.putBlob(Buffer.from("hello provenance"), "second");
    expect(a.meta.hash).toBe(b.meta.hash);
    expect(a.deduplicated).toBe(false);
    expect(b.deduplicated).toBe(true);
    expect(store.listBlobs()).toHaveLength(1);
    const files = fs.readdirSync(path.join(dir, "blobs"));
    expect(files).toHaveLength(1);
    // 两个别名指向同一内容
    expect(store.aliasesFor(a.meta.hash).sort()).toEqual(["first", "second"]);
  });

  it("blob 哈希可验证", () => {
    const { meta } = store.putBlob(Buffer.from("verify me"));
    expect(store.verifyBlob(meta.hash).ok).toBe(true);
  });
});

describe("稳定 JSON 规范化与运行指纹", () => {
  it("键顺序不影响规范化结果", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalize({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("参数键顺序不同的两次运行指纹相同", () => {
    const input = store.putBlob(Buffer.from("x")).meta.hash;
    const r1 = store.prepareRun({ tool: { name: "t", version: "1" }, params: { lr: 1, epochs: 2 }, inputs: [{ hash: input }] });
    const r2 = store.prepareRun({ tool: { name: "t", version: "1" }, params: { epochs: 2, lr: 1 }, inputs: [{ hash: input }] });
    expect(r1.fingerprint).toBe(r2.fingerprint);
    expect(r1.paramsHash).toBe(r2.paramsHash);
  });
});

describe("秘密掩码", () => {
  it("秘密值只保留哈希与展示掩码，明文不落盘", () => {
    const scrubbed = scrubSecrets({ apiKey: { $secret: "sk-super-secret-value" } }) as any;
    expect(scrubbed.apiKey.$secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(scrubbed.apiKey.$mask).toBe("•••ue");
    expect(JSON.stringify(scrubbed)).not.toContain("sk-super-secret-value");

    store.putBlob(Buffer.from("in"), "in");
    const run = store.prepareRun({
      tool: { name: "t", version: "1" },
      params: { token: { $secret: "sk-super-secret-value" }, lr: 0.1 },
      inputs: [{ hash: store.listBlobs()[0].hash }],
    });
    expect(run.paramsCanonical).not.toContain("sk-super-secret-value");
    expect(run.paramsCanonical).toContain("$secretHash");
    expect(run.paramsCanonical).toContain("•••ue");
    const onDisk = fs.readFileSync(path.join(dir, "state.json"), "utf8");
    expect(onDisk).not.toContain("sk-super-secret-value");
  });

  it("同一秘密的哈希参与指纹且稳定", () => {
    const a = fingerprintParams({ k: { $secret: "pw" } });
    const b = fingerprintParams({ k: { $secret: "pw" } });
    const c = fingerprintParams({ k: { $secret: "other" } });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });
});

describe("谱系无环", () => {
  it("检测到环时给出具体路径", () => {
    const a = store.putBlob(Buffer.from("A")).meta.hash;
    // run1: A -> B
    const bRun = commitSimpleRun(store, [{ hash: a }], Buffer.from("B"));
    const b = bRun.outputs[0].hash;
    // run2: B -> A（内容同 A，制造环）
    const run2 = store.prepareRun({
      tool: { name: "t", version: "1" },
      params: {},
      inputs: [{ hash: b }],
    });
    let caught: CycleError | null = null;
    try {
      store.commitRun(run2.id, [{ data: Buffer.from("A") }]);
    } catch (e) {
      caught = e as CycleError;
    }
    expect(caught).toBeInstanceOf(CycleError);
    expect(caught!.cyclePath[0]).toBe(`run:${run2.id}`);
    expect(caught!.cyclePath[caught!.cyclePath.length - 1]).toBe(`run:${run2.id}`);
    expect(caught!.cyclePath.some((n) => n === `run:${bRun.id}`)).toBe(true);
    expect(caught!.cyclePath.some((n) => n.startsWith("blob:"))).toBe(true);
    // 环被拒绝后运行仍处于 prepared，可中止
    expect(store.getRun(run2.id)!.status).toBe("prepared");
  });
});

describe("崩溃恢复", () => {
  it("prepare 后进程退出，重启后悬空记录可恢复而非消失或误判成功", () => {
    const input = store.putBlob(Buffer.from("dataset")).meta.hash;
    const run = store.prepareRun({
      tool: { name: "train", version: "2.0" },
      params: { epochs: 3 },
      inputs: [{ hash: input }],
      declaredOutputs: [{ alias: "model" }],
    });
    // 模拟进程在 prepare 与 commit 之间退出：新建实例从磁盘恢复
    const restarted = new LedgerStore(dir);
    const dangling = restarted.danglingRuns();
    expect(dangling.map((r) => r.id)).toEqual([run.id]);
    expect(dangling[0].status).toBe("prepared");
    // 可恢复：commit 或 abort 均可
    const committed = restarted.commitRun(run.id, [{ data: Buffer.from("weights"), alias: "model" }]);
    expect(committed.status).toBe("committed");
    // 再次重启后无悬空
    expect(new LedgerStore(dir).danglingRuns()).toHaveLength(0);
  });

  it("悬空运行也可以 abort", () => {
    const input = store.putBlob(Buffer.from("d")).meta.hash;
    const run = store.prepareRun({ tool: { name: "t", version: "1" }, params: {}, inputs: [{ hash: input }] });
    const restarted = new LedgerStore(dir);
    restarted.abortRun(run.id);
    expect(restarted.getRun(run.id)!.status).toBe("aborted");
    expect(restarted.danglingRuns()).toHaveLength(0);
  });
});

describe("垃圾回收", () => {
  it("被可达节点引用的内容不得回收；撤销后才可回收", () => {
    const src = store.putBlob(Buffer.from("src"), "src").meta.hash;
    const run = commitSimpleRun(store, [{ hash: src }], Buffer.from("out"), "out");
    const out = run.outputs[0].hash;

    // 撤销输出别名：输出仍被 committed 运行引用，不可回收
    store.revokeAlias("out");
    let plan = store.planGc();
    expect(plan.targets).not.toContain(out);
    expect(plan.targets).not.toContain(src);

    // 撤销运行后，输出不可达；输入仍被别名 src 引用
    store.revokeRun(run.id);
    plan = store.planGc();
    expect(plan.targets).toContain(out);
    expect(plan.targets).not.toContain(src);

    store.executeGc(plan.id);
    expect(store.hasBlob(out)).toBe(false);
    expect(store.hasBlob(src)).toBe(true);
  });

  it("重复执行同一计划不会多删（幂等）", () => {
    store.putBlob(Buffer.from("orphan"), "orphan");
    store.revokeAlias("orphan");
    const plan = store.planGc();
    expect(plan.targets).toHaveLength(1);
    const first = store.executeGc(plan.id);
    expect(first.deleted).toHaveLength(1);
    const second = store.executeGc(plan.id);
    expect(second.deleted).toHaveLength(0);
    // 再次生成计划应为空
    expect(store.planGc().targets).toHaveLength(0);
  });

  it("prepared 运行预留的输入引用不会被回收", () => {
    const input = store.putBlob(Buffer.from("reserved")).meta.hash;
    store.prepareRun({ tool: { name: "t", version: "1" }, params: {}, inputs: [{ hash: input }] });
    const plan = store.planGc();
    expect(plan.targets).not.toContain(input);
  });
});

describe("证明链", () => {
  it("从输出回溯到源输入，包含途经运行与参数", () => {
    const raw = store.putBlob(Buffer.from("raw"), "raw").meta.hash;
    const clean = commitSimpleRun(store, [{ hash: raw }], Buffer.from("clean"), "clean").outputs[0].hash;
    const model = commitSimpleRun(store, [{ hash: clean }], Buffer.from("model"), "model").outputs[0].hash;

    const proof = store.prove(model);
    expect(proof.aliases).toContain("model");
    expect(proof.producedBy).not.toBeNull();
    expect(proof.inputs).toHaveLength(1);
    expect(proof.inputs[0].aliases).toContain("clean");
    expect(proof.inputs[0].inputs[0].aliases).toContain("raw");
    expect(proof.inputs[0].inputs[0].producedBy).toBeNull(); // 源输入
    expect(proof.inputs[0].inputs[0].inputs).toHaveLength(0);
  });
});

describe("可移植归档", () => {
  it("导入空实例后内容哈希、边与运行状态保持不变", () => {
    const raw = store.putBlob(Buffer.from("raw-data"), "raw").meta.hash;
    const run = commitSimpleRun(store, [{ hash: raw }], Buffer.from("model-weights"), "model");
    const prepared = store.prepareRun({
      tool: { name: "eval", version: "1" },
      params: { k: { $secret: "hidden" } },
      inputs: [{ hash: run.outputs[0].hash }],
    });
    const archive = store.exportArchive();

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-import-"));
    try {
      const restored = new LedgerStore(dir2);
      const result = restored.importArchive(archive);
      expect(result.blobs).toBe(2);
      expect(result.runs).toBe(2);
      // 内容哈希不变
      expect(restored.listBlobs().map((b) => b.hash).sort()).toEqual(
        store.listBlobs().map((b) => b.hash).sort()
      );
      // 运行状态不变（含 prepared 悬空）
      expect(restored.getRun(run.id)!.status).toBe("committed");
      expect(restored.getRun(prepared.id)!.status).toBe("prepared");
      expect(restored.danglingRuns().map((r) => r.id)).toEqual([prepared.id]);
      // 边不变：证明链结构一致
      const proof = restored.prove(run.outputs[0].hash);
      expect(proof.inputs[0].blob.hash).toBe(raw);
      // 秘密仍未泄露
      expect(JSON.stringify(restored.exportArchive())).not.toContain("hidden");
      // 内容逐字节一致
      expect(restored.getBlob(raw).toString()).toBe("raw-data");
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("拒绝导入非空实例", () => {
    store.putBlob(Buffer.from("x"));
    expect(() => store.importArchive(store.exportArchive())).toThrow();
  });
});
