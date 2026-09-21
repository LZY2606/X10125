import "./styles.css";

interface BlobView {
  id: string;
  size: number;
  createdAt: string;
  present: boolean;
}
interface RunView {
  id: string;
  status: "prepared" | "committed" | "aborted" | "revoked";
  createdAt: string;
  committedAt?: string;
  endedAt?: string;
  inputs: Record<string, { alias?: string; role?: string }>;
  outputs: Record<string, { size: number; role?: string; mediaType?: string }>;
  params: unknown;
  toolVersions: Record<string, string>;
  fingerprint: string;
  note?: string;
}
interface AliasView { name: string; blobId: string; revoked: boolean; createdAt: string }
interface GcPlanView {
  id: string;
  createdAt: string;
  status: "pending" | "executed";
  entries: Array<{ blobId: string; size: number; reason: string }>;
  deleted: string[];
  missing: string[];
  executedAt?: string;
}
interface StateView {
  blobs: BlobView[];
  runs: RunView[];
  prepared: RunView[];
  aliases: AliasView[];
  graph: { nodes: Array<{ id: string; kind: "blob" | "run"; label: string; status?: string }>; edges: Array<{ from: string; to: string }> };
  reachable: string[];
  gcPlans: GcPlanView[];
}

const app = document.querySelector<HTMLDivElement>("#app")!;
let state: StateView | null = null;
let toastTimer: number | undefined;

function toast(message: string, kind: "info" | "error" | "success" = "info"): void {
  document.querySelectorAll(".toast").forEach((node) => node.remove());
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  document.body.append(node);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.remove(), 5000);
}

async function api(path: string, init: { method?: string; body?: BodyInit | null; headers?: Record<string, string> } = {}): Promise<unknown> {
  const res = await fetch(path, { method: init.method ?? "GET", body: init.body, headers: init.headers });
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      if (contentType.includes("json")) {
        const error = await res.json();
        message = error.message ? `${error.message}${error.details?.path ? "\n路径: " + error.details.path.join(" → ") : ""}` : JSON.stringify(error);
      }
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  if (contentType.includes("json")) return res.json();
  return res.arrayBuffer();
}

async function refresh(): Promise<void> {
  const data = (await api("/api/state")) as StateView & {
    state: { aliases: Record<string, AliasView> };
  };
  data.aliases = Object.values(data.state.aliases);
  state = data;
  render();
}

function short(id: string): string {
  return id.length > 18 ? id.slice(0, 8) + "…" + id.slice(-4) : id;
}

function statusBadge(status: string): string {
  const labels: Record<string, string> = {
    prepared: "已 prepare",
    committed: "已 commit",
    aborted: "已 abort",
    revoked: "已撤销"
  };
  return `<span class="badge ${status}">${labels[status] ?? status}</span>`;
}

function render(): void {
  if (!state) return;
  const preparedBanner = state.prepared.length
    ? `<div class="banner"><strong>检测到 ${state.prepared.length} 条悬空（prepare 后未 commit/abort）运行。</strong>
        重启后可继续提交或中止：
        ${state.prepared
          .map(
            (run) =>
              `<div class="row"><code>${run.id}</code>
                <button data-action="commit" data-id="${run.id}">commit</button>
                <button class="danger" data-action="abort" data-id="${run.id}">abort</button>
                <span class="small">输出未到齐时 commit 会被拒绝</span></div>`
          )
          .join("")}
      </div>`
    : "";

  app.innerHTML = `
    <header>
      <h1>产物谱系账本</h1>
      <span class="hint">内容寻址 · prepare/commit/abort · 有向无环谱系 · 可移植归档</span>
    </header>
    <main>
      ${preparedBanner}
      ${uploadCard()}
      ${prepareCard()}
      ${runsCard()}
      ${graphCard()}
      ${aliasCard()}
      ${gcCard()}
      ${archiveCard()}
    </main>`;
  bindEvents();
}

function uploadCard(): string {
  const rows = (state?.blobs ?? [])
    .map(
      (blob) => `<tr>
        <td class="mono">${short(blob.id)}</td>
        <td>${blob.size}</td>
        <td>${blob.present ? "在库" : "内容缺失"}</td>
        <td class="row">
          <button class="ghost" data-action="verify" data-id="${blob.id}">验证哈希</button>
        </td>
      </tr>`
    )
    .join("");
  return `<section class="card">
    <h2>① 登记输入 / 输出 blob</h2>
    <div id="drop" class="drop">把文件拖到这里，或 <button class="secondary" id="pick">选择文件</button>
      <div class="small">相同内容再次上传只返回同一 blob，不复制存储。可选别名：<input id="alias" type="text" placeholder="别名（可选）" /></div>
      <input id="file" type="file" multiple hidden />
    </div>
    <details><summary>已登记 blob（${state?.blobs.length ?? 0}）</summary><table>
      <tr><th>blob</th><th>字节</th><th>状态</th><th></th></tr>${rows}
    </table></details>
  </section>`;
}

function blobSelect(selected = ""): string {
  return (state?.blobs ?? [])
    .map((blob) => `<option value="${blob.id}" ${blob.id === selected ? "selected" : ""}>${short(blob.id)} (${blob.size}B)</option>`)
    .join("");
}

function prepareCard(): string {
  return `<section class="card">
    <h2>② 创建运行（prepare）</h2>
    <div class="row">
      <strong>输入</strong>
      <select id="in-blob"><option value="">选择 blob…</option>${blobSelect()}</select>
      <input id="in-role" type="text" placeholder="角色（可选）" />
      <button class="secondary" id="add-input">添加输入</button>
    </div>
    <ul id="input-list" class="small mono"></ul>
    <div class="row">
      <strong>输出</strong>
      <select id="out-blob"><option value="">选择已上传 blob…</option>${blobSelect()}</select>
      <input id="out-role" type="text" placeholder="角色（可选）" />
      <input id="out-media" type="text" placeholder="mediaType（可选）" />
      <button class="secondary" id="add-output">添加输出声明</button>
    </div>
    <ul id="output-list" class="small mono"></ul>
    <div class="row"><strong>参数 JSON</strong>
      <button class="ghost" id="add-secret">插入秘密占位</button>
      <span class="small">写成 {"__secret__":"明文"} 后仅保存哈希与掩码</span>
    </div>
    <textarea id="params">{
  "temperature": 0.2,
  "api_key": {"__secret__": "sk-demo-secret"}
}</textarea>
    <div class="row"><strong>工具版本</strong>
      <input id="tool-name" type="text" placeholder="名称，如 python" />
      <input id="tool-version" type="text" placeholder="版本，如 3.12.4" />
      <button class="secondary" id="add-tool">添加</button>
    </div>
    <div id="tool-list" class="small mono"></div>
    <div class="row">
      <input id="note" type="text" placeholder="运行备注（可选）" />
    </div>
    <div class="row">
      <button id="prepare">prepare（仅预留）</button>
      <button class="ghost" id="crash">模拟 prepare 后崩溃并重启</button>
    </div>
    <div id="prepare-result" class="small"></div>
  </section>`;
}

function runsCard(): string {
  const rows = (state?.runs ?? [])
    .slice()
    .reverse()
    .map((run) => {
      const actions =
        run.status === "prepared"
          ? `<button data-action="commit" data-id="${run.id}">commit</button>
             <button class="danger" data-action="abort" data-id="${run.id}">abort</button>`
          : run.status !== "revoked"
            ? `<button class="ghost" data-action="revoke" data-id="${run.id}">撤销运行</button>`
            : "";
      return `<tr>
        <td class="mono">${short(run.id)}<div class="small">${statusBadge(run.status)}</div></td>
        <td>
          <details><summary>入 ${Object.keys(run.inputs).length} / 出 ${Object.keys(run.outputs).length}</summary>
            <div class="small mono">IN: ${Object.keys(run.inputs).map(short).join(", ") || "—"}</div>
            <div class="small mono">OUT: ${Object.keys(run.outputs).map(short).join(", ") || "—"}</div>
            <div class="small">指纹: <span class="mono">${short(run.fingerprint)}</span></div>
            <pre class="json">${escapeHtml(JSON.stringify({ params: run.params, toolVersions: run.toolVersions }, null, 2))}</pre>
          </details>
        </td>
        <td class="row">${actions}</td>
      </tr>`;
    })
    .join("");
  return `<section class="card wide">
    <h2>③ 运行（三段状态）</h2>
    <table><tr><th>运行</th><th>内容</th><th>操作</th></tr>${rows}</table>
  </section>`;
}

function graphCard(): string {
  return `<section class="card wide">
    <h2>④ 有向谱系与证明链</h2>
    <div class="row">
      源输入 <select id="proof-source"><option value="">选择 blob…</option>${(state?.blobs ?? []).map((b) => `<option value="${b.id}">${short(b.id)}</option>`).join("")}</select>
      目标 <select id="proof-target"><option value="">选择 blob…</option>${(state?.blobs ?? []).map((b) => `<option value="${b.id}">${short(b.id)}</option>`).join("")}</select>
      <button id="proof-btn">打开证明链</button>
    </div>
    <div id="proof-result" class="small"></div>
    ${renderSvg()}
  </section>`;
}

function aliasCard(): string {
  const rows = (state?.aliases ?? [])
    .map(
      (alias) => `<tr>
        <td>${alias.name}</td>
        <td class="mono">${short(alias.blobId)}</td>
        <td>${alias.revoked ? '<span class="badge revoked">已撤销</span>' : "生效中"}</td>
        <td>${alias.revoked ? "" : `<button class="ghost" data-action="revoke-alias" data-id="${alias.name}">撤销别名</button>`}</td>
      </tr>`
    )
    .join("");
  return `<section class="card">
    <h2>⑤ 别名（名称只是别名）</h2>
    <div class="row">
      <input id="new-alias" type="text" placeholder="别名" />
      <select id="new-alias-blob"><option value="">blob…</option>${blobSelect()}</select>
      <button id="bind-alias">绑定</button>
    </div>
    <table><tr><th>别名</th><th>blob</th><th>状态</th><th></th></tr>${rows}</table>
  </section>`;
}

function gcCard(): string {
  const reachable = new Set(state?.reachable ?? []);
  const unreachable = (state?.blobs ?? []).filter((blob) => blob.present && !reachable.has(blob.id));
  const plans = (state?.gcPlans ?? [])
    .slice()
    .reverse()
    .map(
      (plan) => `<tr>
        <td class="mono">${short(plan.id)}</td>
        <td>${plan.status === "pending" ? "待执行" : `已执行 ${plan.executedAt ?? ""}`}</td>
        <td>${plan.entries.length} 项 / 已删 ${plan.deleted.length}${plan.missing.length ? ` / 缺失 ${plan.missing.length}` : ""}</td>
        <td>${plan.status === "pending" ? `<button data-action="gc-exec" data-id="${plan.id}">执行计划</button>` : `<button class="ghost" data-action="gc-exec" data-id="${plan.id}">重复执行（不多删）</button>`}</td>
      </tr>`
    )
    .join("");
  return `<section class="card">
    <h2>⑥ 垃圾回收（先生成计划）</h2>
    <div class="small">当前不可达且在库 blob：${unreachable.length}（仍被可达节点引用的内容不会出现）</div>
    <div class="row"><button id="gc-plan">生成回收计划</button></div>
    <table><tr><th>计划</th><th>状态</th><th>条目</th><th></th></tr>${plans}</table>
  </section>`;
}

function archiveCard(): string {
  return `<section class="card wide">
    <h2>⑦ 可移植归档 / 导入</h2>
    <div class="row">
      <a href="/api/archive/export"><button class="secondary">导出 lineage-archive.tar.gz</button></a>
      <label class="small">导入到空实例：<input id="archive-file" type="file" accept=".gz,.tar.gz" /></label>
    </div>
    <div id="archive-result" class="small"></div>
  </section>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] as string);
}

function renderSvg(): string {
  if (!state || state.graph.nodes.length === 0) {
    return '<svg class="graph"></svg>';
  }
  const { nodes, edges } = state.graph;
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const rank = new Map<string, number>();
  const blobs = nodes.filter((node) => node.kind === "blob").map((node) => node.id);
  const queue = blobs.filter((id) => (incoming.get(id) ?? []).every((from) => rank.has(from)));
  for (const id of blobs) rank.set(id, 0);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      const fromRank = rank.get(edge.from);
      if (fromRank === undefined) continue;
      const next = fromRank + 1;
      if ((rank.get(edge.to) ?? -1) < next) {
        rank.set(edge.to, next);
        changed = true;
      }
    }
  }
  void queue;
  void outgoing;
  const byRank = new Map<number, string[]>();
  for (const node of nodes) {
    const r = rank.get(node.id) ?? 0;
    byRank.set(r, [...(byRank.get(r) ?? []), node.id]);
  }
  const width = 1080;
  const rankGap = 170;
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const positions = new Map<string, { x: number; y: number }>();
  ranks.forEach((r, index) => {
    const ids = (byRank.get(r) ?? []).sort();
    ids.forEach((id, i) => {
      const y = 40 + i * 64;
      positions.set(id, { x: 40 + index * rankGap, y });
    });
  });
  const edgeSvg = edges
    .map((edge) => {
      const a = positions.get(edge.from);
      const b = positions.get(edge.to);
      if (!a || !b) return "";
      return `<path class="edge" d="M ${a.x + 84} ${a.y + 14} C ${a.x + 130} ${a.y + 14}, ${b.x - 40} ${b.y + 14}, ${b.x} ${b.y + 14}" />`;
    })
    .join("");
  const nodeSvg = nodes
    .map((node) => {
      const pos = positions.get(node.id);
      if (!pos) return "";
      const isRun = node.kind === "run";
      const cls = isRun ? `node-run ${node.status ?? ""}` : "node-blob";
      const label = escapeHtml(node.label);
      return `<g>
        <rect class="${cls}" x="${pos.x}" y="${pos.y}" rx="8" ry="8" width="${isRun ? 92 : 116}" height="28"></rect>
        <text x="${pos.x + 8}" y="${pos.y + 18}">${label}</text>
      </g>`;
    })
    .join("");
  const height = Math.max(420, ...[...positions.values()].map((p) => p.y + 60));
  return `<svg class="graph" viewBox="0 0 ${width} ${height}">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#8a98ac"></path>
    </marker></defs>
    ${edgeSvg}${nodeSvg}
  </svg>`;
}

interface DraftRef { blobId: string; role?: string }
interface DraftOutput extends DraftRef { mediaType?: string }
const draft = { inputs: [] as DraftRef[], outputs: [] as DraftOutput[], tools: {} as Record<string, string>, preparedId: "" };

function renderDraftLists(): void {
  const inputList = document.querySelector<HTMLUListElement>("#input-list");
  const outputList = document.querySelector<HTMLUListElement>("#output-list");
  const toolList = document.querySelector<HTMLDivElement>("#tool-list");
  if (inputList) inputList.innerHTML = draft.inputs.map((item, i) => `<li>[${i}] ${short(item.blobId)}${item.role ? ` role=${item.role}` : ""} <button class="ghost" data-draft="input" data-index="${i}">移除</button></li>`).join("") || "<li>无</li>";
  if (outputList) outputList.innerHTML = draft.outputs.map((item, i) => `<li>[${i}] ${short(item.blobId)}${item.role ? ` role=${item.role}` : ""} <button class="ghost" data-draft="output" data-index="${i}">移除</button></li>`).join("") || "<li>无（可先 prepare，稍后再上传并 commit）</li>";
  if (toolList) toolList.textContent = Object.entries(draft.tools).map(([name, version]) => `${name}=${version}`).join("  ") || "（将自动记录 node 与浏览器 UA）";
}

async function uploadFiles(files: FileList | File[], alias?: string): Promise<void> {
  for (const file of Array.from(files)) {
    const buffer = await file.arrayBuffer();
    const result = (await api("/api/blobs", {
      method: "POST",
      body: buffer,
      headers: alias ? { "x-alias": alias } : {}
    })) as { blobId: string; reused: boolean };
    toast(`${file.name} → ${short(result.blobId)}${result.reused ? "（内容已存在，去重）" : ""}`, "success");
  }
  await refresh();
}

function bindEvents(): void {
  renderDraftLists();

  const drop = document.querySelector<HTMLDivElement>("#drop");
  const fileInput = document.querySelector<HTMLInputElement>("#file");
  const aliasInput = document.querySelector<HTMLInputElement>("#alias");
  document.querySelector("#pick")?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", () => {
    if (fileInput.files) void uploadFiles(fileInput.files, aliasInput?.value || undefined);
  });
  drop?.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("over");
  });
  drop?.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop?.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("over");
    if (event.dataTransfer) void uploadFiles(event.dataTransfer.files, aliasInput?.value || undefined);
  });

  document.querySelector("#add-input")?.addEventListener("click", () => {
    const blobId = document.querySelector<HTMLSelectElement>("#in-blob")?.value ?? "";
    const role = document.querySelector<HTMLInputElement>("#in-role")?.value || undefined;
    if (!blobId) return toast("请先选择输入 blob", "error");
    if (!draft.inputs.some((item) => item.blobId === blobId)) draft.inputs.push({ blobId, role });
    renderDraftLists();
  });

  document.querySelector("#add-output")?.addEventListener("click", () => {
    const blobId = document.querySelector<HTMLSelectElement>("#out-blob")?.value ?? "";
    const role = document.querySelector<HTMLInputElement>("#out-role")?.value || undefined;
    const mediaType = document.querySelector<HTMLInputElement>("#out-media")?.value || undefined;
    if (!blobId) return toast("请先选择输出 blob（也可在 prepare 后上传）", "error");
    if (!draft.outputs.some((item) => item.blobId === blobId)) draft.outputs.push({ blobId, role, mediaType });
    renderDraftLists();
  });

  document.querySelector("#add-tool")?.addEventListener("click", () => {
    const name = document.querySelector<HTMLInputElement>("#tool-name")?.value.trim() ?? "";
    const version = document.querySelector<HTMLInputElement>("#tool-version")?.value.trim() ?? "";
    if (name && version) {
      draft.tools[name] = version;
      renderDraftLists();
    }
  });

  document.querySelector("#add-secret")?.addEventListener("click", () => {
    const textarea = document.querySelector<HTMLTextAreaElement>("#params");
    if (!textarea) return;
    textarea.value = textarea.value.trimEnd().replace(/}$/, '  "token": {"__secret__": "把秘密写在这里"}\n}');
  });

  document.querySelector("#prepare")?.addEventListener("click", () => void doPrepare(false));
  document.querySelector("#crash")?.addEventListener("click", () => void doPrepare(true));
  document.querySelector("#proof-btn")?.addEventListener("click", () => void showProof());
  document.querySelector("#bind-alias")?.addEventListener("click", () => void bindAlias());
  document.querySelector("#gc-plan")?.addEventListener("click", () => void makeGcPlan());

  document.querySelector("#archive-file")?.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.files?.[0]) void importArchive(input.files[0]);
  });

  document.querySelectorAll<HTMLButtonElement>("button[data-draft]").forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.dataset.draft as "input" | "output";
      const index = Number(button.dataset.index);
      draft[kind === "input" ? "inputs" : "outputs"].splice(index, 1);
      renderDraftLists();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((button) => {
    button.addEventListener("click", () => void runAction(button.dataset.action as string, button.dataset.id as string));
  });
}

async function doPrepare(simulateCrash: boolean): Promise<void> {
  const textarea = document.querySelector<HTMLTextAreaElement>("#params");
  let params: unknown = {};
  try {
    params = textarea?.value ? JSON.parse(textarea.value) : {};
  } catch (error) {
    toast(`参数 JSON 解析失败：${(error as Error).message}`, "error");
    return;
  }
  const note = document.querySelector<HTMLInputElement>("#note")?.value || undefined;
  const toolVersions = {
    ...draft.tools,
    "user-agent": navigator.userAgent,
    "web-app": "artifact-lineage-ledger/1.0.0"
  };
  try {
    const run = (await api("/api/runs/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inputs: draft.inputs,
        outputs: draft.outputs,
        params,
        toolVersions,
        note
      })
    })) as RunView;
    draft.preparedId = run.id;
    const result = document.querySelector("#prepare-result");
    if (result) {
      result.innerHTML = `已 prepare：<code>${run.id}</code>，指纹 <code>${short(run.fingerprint)}</code>`;
    }
    if (simulateCrash) {
      toast("prepare 已持久化。现在模拟进程崩溃：页面立即重载（重启后悬空记录出现在顶部，不会丢失或被当作成功）。", "success");
      window.setTimeout(() => window.location.reload(), 900);
      return;
    }
    toast("prepare 成功，可在运行列表 commit / abort", "success");
    await refresh();
  } catch (error) {
    toast((error as Error).message, "error");
  }
}

async function runAction(action: string, id: string): Promise<void> {
  try {
    if (action === "commit") {
      await api(`/api/runs/${encodeURIComponent(id)}/commit`, { method: "POST" });
      toast("commit 成功，输出进入可见谱系", "success");
    } else if (action === "abort") {
      await api(`/api/runs/${encodeURIComponent(id)}/abort`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "用户在界面中止" })
      });
      toast("运行已 abort", "success");
    } else if (action === "revoke") {
      await api(`/api/runs/${encodeURIComponent(id)}/revoke`, { method: "POST" });
      toast("运行已撤销（从可见谱系移除边）", "success");
    } else if (action === "revoke-alias") {
      await api(`/api/aliases/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast(`别名 ${id} 已撤销`, "success");
    } else if (action === "verify") {
      const result = (await api(`/api/blobs/${encodeURIComponent(id)}/verify`)) as {
        ok: boolean;
        expected: string;
        actual: string;
        size: number;
      };
      toast(result.ok ? `哈希校验通过（${result.size} 字节）` : `哈希不匹配！\nexpected ${result.expected}\nactual ${result.actual}`, result.ok ? "success" : "error");
    } else if (action === "gc-exec") {
      const result = (await api(`/api/gc/plans/${encodeURIComponent(id)}/execute`, { method: "POST" })) as {
        deleted: string[];
        missing: string[];
        status: string;
      };
      toast(`计划执行完成：删除 ${result.deleted.length}，缺失 ${result.missing.length}；再次执行同一计划不会多删`, "success");
    }
    await refresh();
  } catch (error) {
    toast((error as Error).message, "error");
  }
}

async function showProof(): Promise<void> {
  const source = document.querySelector<HTMLSelectElement>("#proof-source")?.value ?? "";
  const target = document.querySelector<HTMLSelectElement>("#proof-target")?.value ?? "";
  const result = document.querySelector("#proof-result");
  if (!source || !target || !result) return;
  try {
    const proof = (await api(`/api/proof?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`)) as {
      found: boolean;
      path: string[];
      steps: Array<{ runId: string; params: unknown; toolVersions: Record<string, string>; fingerprint: string }>;
    };
    if (!proof.found) {
      result.innerHTML = "源输入到目标之间不存在提交过的谱系路径。";
      return;
    }
    result.innerHTML = `<div>证明链：<span class="mono">${proof.path.map(escapeHtml).join(" → ")}</span></div>
      <details open><summary>${proof.steps.length} 个运行与参数</summary>
      <pre class="json">${escapeHtml(JSON.stringify(proof.steps, null, 2))}</pre></details>`;
  } catch (error) {
    result.textContent = (error as Error).message;
  }
}

async function bindAlias(): Promise<void> {
  const name = document.querySelector<HTMLInputElement>("#new-alias")?.value ?? "";
  const blobId = document.querySelector<HTMLSelectElement>("#new-alias-blob")?.value ?? "";
  if (!name || !blobId) return toast("需要别名与 blob", "error");
  try {
    await api("/api/aliases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, blobId })
    });
    await refresh();
  } catch (error) {
    toast((error as Error).message, "error");
  }
}

async function makeGcPlan(): Promise<void> {
  try {
    const result = (await api("/api/gc/plans", { method: "POST" })) as {
      plan: { id: string; entries: Array<{ blobId: string; reason: string }> };
    };
    toast(`已生成计划 ${result.plan.id}：${result.plan.entries.length} 个候选 blob`, "success");
    await refresh();
  } catch (error) {
    toast((error as Error).message, "error");
  }
}

async function importArchive(file: File): Promise<void> {
  try {
    const info = (await api("/api/archive/import", { method: "POST", body: await file.arrayBuffer() })) as {
      stateHash: string;
      blobCount: number;
    };
    toast(`导入完成：${info.blobCount} 个 blob，状态哈希 ${info.stateHash.slice(0, 16)}…`, "success");
    await refresh();
  } catch (error) {
    toast((error as Error).message, "error");
  }
}

void refresh();
