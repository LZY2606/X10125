import { useCallback, useEffect, useRef, useState } from "react";
import { api, fileToBase64, type LedgerState, type ProofNode, type Run } from "./api";

function short(h: string) {
  return h.slice(0, 12);
}

function ProofTree({ node, depth = 0 }: { node: ProofNode; depth?: number }) {
  return (
    <div className="proof" style={{ marginLeft: depth === 0 ? 0 : 8 }}>
      <div className="node">
        <span className="hash">blob:{short(node.blob.hash)}</span>{" "}
        <span className="muted">({node.blob.size} B)</span>{" "}
        {node.aliases.map((a) => (
          <span key={a} className="tag alias">{a}</span>
        ))}
        {node.producedBy ? (
          <div className="muted">
            ← 运行 {node.producedBy.id} · {node.producedBy.tool.name}@{node.producedBy.tool.version} ·
            指纹 {short(node.producedBy.fingerprint)} · 参数 <code>{node.producedBy.paramsCanonical}</code>
          </div>
        ) : (
          <div className="muted">← 源输入（无上游运行）</div>
        )}
      </div>
      {node.inputs.map((child) => (
        <ProofTree key={child.blob.hash + depth} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<LedgerState | null>(null);
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const [alias, setAlias] = useState("");
  const [tool, setTool] = useState("trainer");
  const [toolVersion, setToolVersion] = useState("1.0.0");
  const [paramsText, setParamsText] = useState('{\n  "lr": 0.001,\n  "epochs": 10\n}');
  const [selectedInputs, setSelectedInputs] = useState<Set<string>>(new Set());
  const [declaredAliases, setDeclaredAliases] = useState("");
  const [proofs, setProofs] = useState<Record<string, ProofNode>>({});
  const [commitFor, setCommitFor] = useState<string | null>(null);
  const [verifyResults, setVerifyResults] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const commitFileRef = useRef<HTMLInputElement>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setState(await api.state());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (fn: () => Promise<unknown>, okMsg?: string) => {
      setError("");
      setNotice("");
      try {
        await fn();
        if (okMsg) setNotice(okMsg);
        await refresh();
      } catch (e) {
        const err = e as Error & { cycle?: string[] };
        setError(err.cycle ? `${err.message}\n环路路径: ${err.cycle.join(" -> ")}` : err.message);
      }
    },
    [refresh]
  );

  const uploadFiles = (files: FileList | File[]) =>
    run(async () => {
      for (const file of Array.from(files)) {
        const result = await api.upload(file, alias || file.name);
        setNotice(
          result.deduplicated
            ? `${file.name}: 内容已存在（${short(result.hash)}），未重复存储`
            : `${file.name}: 已存储为 ${short(result.hash)}`
        );
      }
    });

  if (!state) return <main>加载中…</main>;

  const aliasOf = (hash: string) => state.aliases.filter((a) => !a.revoked && a.hash === hash);

  return (
    <>
      <header>
        <h1>产物谱系账本</h1>
        <span className="sub">内容寻址 · prepare/commit/abort · 有向无环谱系 · 证明链</span>
        <span style={{ flex: 1 }} />
        <button
          className="danger"
          onClick={() =>
            run(async () => {
              const r = await api.restart();
              setNotice(
                r.dangling.length > 0
                  ? `已模拟重启：发现 ${r.dangling.length} 个 prepare 后未完成的运行（可恢复）`
                  : "已模拟重启：无悬空运行"
              );
            })
          }
        >
          模拟 prepare 后崩溃重启
        </button>
      </header>
      <main>
        {state.dangling.length > 0 && (
          <div className="banner full">
            ⚠ 检测到 {state.dangling.length} 个悬空的 prepared 运行（进程可能在 prepare 与 commit 之间退出）：
            {state.dangling.map((d) => d.id).join(", ")}。请在下方将其 commit 或 abort。
          </div>
        )}
        {error && <div className="error full">{error}</div>}
        {notice && <div className="ok full">{notice}</div>}

        <section>
          <h2>① 登记输入 blob（拖入文件）</h2>
          <div
            className={`dropzone ${dragOver ? "over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void uploadFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
          >
            拖拽文件到此处，或点击选择
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => e.target.files && uploadFiles(e.target.files)}
            />
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <label>别名（可选）</label>
            <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="如 dataset-v1" />
          </div>
          <table>
            <thead>
              <tr><th>哈希</th><th>大小</th><th>别名</th><th>操作</th></tr>
            </thead>
            <tbody>
              {state.blobs.map((b) => (
                <tr key={b.hash}>
                  <td className="hash">{short(b.hash)}…</td>
                  <td>{b.size} B</td>
                  <td>
                    {aliasOf(b.hash).map((a) => (
                      <span key={a.name} className="tag alias">
                        {a.name}
                        <a
                          style={{ marginLeft: 4, cursor: "pointer", color: "var(--bad)" }}
                          title="撤销别名"
                          onClick={() => run(() => api.revokeAlias(a.name))}
                        >
                          ×
                        </a>
                      </span>
                    ))}
                  </td>
                  <td>
                    <button
                      onClick={() =>
                        run(async () => {
                          const v = await api.verify(b.hash);
                          setVerifyResults((m) => ({ ...m, [b.hash]: v.ok ? "✓ 校验通过" : `✗ 实际 ${short(v.actual)}` }));
                        })
                      }
                    >
                      验证哈希
                    </button>{" "}
                    <button
                      onClick={() =>
                        run(async () => {
                          const p = await api.proof(b.hash);
                          setProofs((m) => ({ ...m, [b.hash]: p }));
                        })
                      }
                    >
                      证明链
                    </button>
                    <div className="ok">{verifyResults[b.hash]}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {Object.entries(proofs).map(([hash, p]) => (
            <div key={hash}>
              <h3 className="muted">证明链 {short(hash)}</h3>
              <ProofTree node={p} />
            </div>
          ))}
        </section>

        <section>
          <h2>② 创建运行（prepare）</h2>
          <div className="row">
            <label>工具</label>
            <input value={tool} onChange={(e) => setTool(e.target.value)} />
            <label>版本</label>
            <input value={toolVersion} onChange={(e) => setToolVersion(e.target.value)} style={{ width: 90 }} />
          </div>
          <div className="row">
            <label>输入 blob</label>
            {state.blobs.map((b) => (
              <label key={b.hash} style={{ color: "var(--text)" }}>
                <input
                  type="checkbox"
                  checked={selectedInputs.has(b.hash)}
                  onChange={(e) => {
                    const next = new Set(selectedInputs);
                    if (e.target.checked) next.add(b.hash);
                    else next.delete(b.hash);
                    setSelectedInputs(next);
                  }}
                />{" "}
                {aliasOf(b.hash)[0]?.name ?? short(b.hash)}
              </label>
            ))}
          </div>
          <label>参数（JSON；秘密值写作 {"{\"$secret\":\"…\"}"}，仅保留哈希与掩码）</label>
          <textarea rows={5} value={paramsText} onChange={(e) => setParamsText(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <label>声明输出别名（逗号分隔）</label>
            <input value={declaredAliases} onChange={(e) => setDeclaredAliases(e.target.value)} placeholder="model-v2, report" />
          </div>
          <button
            className="primary"
            onClick={() =>
              run(async () => {
                const params = JSON.parse(paramsText);
                const r = await api.prepare({
                  tool: { name: tool, version: toolVersion },
                  params,
                  inputs: [...selectedInputs].map((hash) => ({ hash })),
                  declaredOutputs: declaredAliases
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .map((a) => ({ alias: a })),
                });
                setNotice(`已 prepare 运行 ${r.id}（指纹 ${short(r.fingerprint)}），可 commit 或 abort`);
              })
            }
          >
            prepare 运行
          </button>
        </section>

        <section className="full">
          <h2>③ 运行列表</h2>
          <table>
            <thead>
              <tr><th>ID</th><th>工具</th><th>状态</th><th>指纹</th><th>参数（已脱敏）</th><th>输入 → 输出</th><th>操作</th></tr>
            </thead>
            <tbody>
              {state.runs.map((r: Run) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.tool.name}@{r.tool.version}</td>
                  <td>
                    <span className={`tag ${r.status}`}>{r.status}</span>
                    {r.revoked && <span className="tag revoked">已撤销</span>}
                  </td>
                  <td className="hash">{short(r.fingerprint)}</td>
                  <td className="hash">{r.paramsCanonical}</td>
                  <td className="hash">
                    {r.inputs.map((i) => short(i.hash)).join(", ") || "（无）"} →{" "}
                    {r.outputs.map((o) => short(o.hash)).join(", ") ||
                      r.declaredOutputs.map((o) => o.alias ?? "?").join(", ") ||
                      "—"}
                  </td>
                  <td>
                    {r.status === "prepared" && (
                      <>
                        <button
                          className="primary"
                          onClick={() => {
                            setCommitFor(r.id);
                            commitFileRef.current?.click();
                          }}
                        >
                          commit
                        </button>{" "}
                        <button className="danger" onClick={() => run(() => api.abort(r.id), `已 abort ${r.id}`)}>
                          abort
                        </button>
                      </>
                    )}
                    {r.status === "committed" && !r.revoked && (
                      <button className="danger" onClick={() => run(() => api.revokeRun(r.id), `已撤销 ${r.id}`)}>
                        撤销运行
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <input
            ref={commitFileRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              const files = e.target.files;
              const id = commitFor;
              e.target.value = "";
              if (!files || !id) return;
              const target = state.runs.find((x) => x.id === id);
              void run(async () => {
                const outputs = await Promise.all(
                  Array.from(files).map(async (f, i) => ({
                    dataBase64: await fileToBase64(f),
                    alias: target?.declaredOutputs[i]?.alias ?? f.name,
                  }))
                );
                await api.commit(id, outputs);
                setNotice(`已 commit ${id}，输出进入可见谱系`);
              });
            }}
          />
        </section>

        <section>
          <h2>④ 垃圾回收（先计划，幂等执行）</h2>
          <div className="row">
            <button onClick={() => run(async () => {
              const p = await api.gcPlan();
              setNotice(`GC 计划 ${p.id}：${p.targets.length} 个不可达 blob`);
            })}>
              生成 GC 计划
            </button>
          </div>
          {state.gcPlans.map((p) => (
            <div key={p.id} className="row">
              <span className="hash">{p.id}</span>
              <span className="muted">目标 {p.targets.length} 个 · 已执行 {p.executions.length} 次</span>
              <button onClick={() => run(async () => {
                const r = await api.gcExecute(p.id);
                setNotice(`执行 ${p.id}：本次删除 ${r.deleted.length} 个（重复执行不会多删）`);
              })}>
                执行
              </button>
            </div>
          ))}
        </section>

        <section>
          <h2>⑤ 可移植归档</h2>
          <div className="row">
            <button
              onClick={() =>
                run(async () => {
                  const archive = await api.archive();
                  const blob = new Blob([JSON.stringify(archive)], { type: "application/json" });
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = "ledger-archive.json";
                  a.click();
                  setNotice("归档已导出");
                })
              }
            >
              导出归档
            </button>
            <button onClick={() => archiveInputRef.current?.click()}>导入归档（空实例）</button>
            <input
              ref={archiveInputRef}
              type="file"
              accept="application/json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                void run(async () => {
                  const archive = JSON.parse(await f.text());
                  const r = (await api.importArchive(archive)) as { blobs: number; runs: number };
                  setNotice(`导入完成：${r.blobs} 个 blob，${r.runs} 个运行，哈希/边/状态保持不变`);
                });
              }}
            />
          </div>
          <p className="muted">归档包含全部状态与 blob 内容（base64），导入空实例后内容哈希、谱系边与运行状态完全一致。</p>
        </section>
      </main>
    </>
  );
}
