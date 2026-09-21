# 产物谱系账本（Artifact Lineage Ledger）

本地运行的“产物谱系账本”：登记每次运行的输入 blob、参数、工具版本与输出，把多次运行连成有向无环谱系，并为任意节点生成从选定源输入出发的证明链。

## 准备与演示

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test -- --run
pnpm dev -- --host 127.0.0.1 --port 5213
```

打开 http://127.0.0.1:5213 ，页面顶部显示“产物谱系账本”。

测试全程走进程内函数调用，不监听端口、不访问网络（`test/setup.ts` 拦截 `fetch` / `WebSocket` / `XMLHttpRequest`）。

## 核心模型

- **内容寻址 blob**：所有文件按 SHA-256 存为 `blob-<hash>`，物理路径分片为 `.lineage/blobs/xx/yy/<其余哈希>`。同一内容重复上传返回同一 blob 与 `reused: true`，不复制存储。名称只是**别名（alias）**，可撤销。
- **运行（run）三段状态**：
  - `prepare`：预留输入引用与输出声明，记录规范化参数与工具版本，计算运行指纹；此时输出内容允许尚未到齐。
  - `commit`：校验所有输出内容已存在、且提交不会形成环后，输出才进入可见谱系。
  - `abort`：放弃一次 prepared 运行。
  - 进程在 prepare 与 commit 之间退出后，重启会把悬空记录显示为“可恢复”状态，可继续 commit / abort，绝不会静默删除或当作成功。
  - committed 运行也可被**撤销（revoke）**，其边从可见谱系移除。
- **运行指纹**：对 `{v, inputs, outputs, params, toolVersions}` 做稳定 JSON 规范化（对象键按 UTF-8 排序、数组保序）后取 SHA-256。参数对象写为 `{"__secret__": "明文"}` 的值会被替换为 `{__secret__: true, hash, mask}`，只保留哈希与展示掩码（如 `s***90`），明文不落盘、不进状态文件。
- **无环谱系**：commit 时在 blob↔run 节点图上做可达性检查；检测到环时拒绝提交（HTTP 409）并返回一条包含 run 节点的具体路径，例如 `blob-a → run_1 → blob-b → run_2 → blob-a`。
- **证明链**：`GET /api/proof?source=<blob>&target=<blob>` 返回 BFS 路径以及路径上每次运行的输入、输出、参数（含秘密掩码）、工具版本和指纹。
- **垃圾回收**：
  - 根为所有未撤销别名；prepared 运行的预留输入受保护；committed 运行的任一输入可达时，其输出才可达。
  - 先 `POST /api/gc/plans` **生成计划**（只列不可达且在库的 blob），再 `execute`。
  - 执行时再次做实时引用保护；重复执行同一计划返回相同的 `deleted` 列表，不会多删。
- **可移植归档**：`GET /api/archive/export` 下载确定性排序的 `tar.gz`（内含规范化 `ledger-state.json`、全部 blob 内容、`MANIFEST.json` 状态哈希）。只能导入空实例（或带 `x-force: true`）；导入时逐 blob 校验内容哈希、校验状态哈希，导入后所有哈希、边、运行状态（含悬空 prepared 与已执行 GC 计划）保持不变。

## 机器可读 API

所有接口位于 `/api` 前缀，JSON 请求/响应（blob 上传为原始字节，可用 `x-alias` 头同时绑定别名）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 完整快照：状态、blob 在库情况、运行、悬空 prepared、图、可达集合、GC 计划 |
| POST | `/api/blobs` | 上传/去重登记 blob |
| GET | `/api/blobs/:id/verify` | 重新计算并校验 blob 哈希 |
| GET | `/api/blobs/:id/content` | 下载 blob 原始内容 |
| POST | `/api/aliases` / DELETE | `/api/aliases/:name` | 绑定 / 撤销别名 |
| POST | `/api/runs/prepare` | 预留输入、输出、参数、工具版本 |
| POST | `/api/runs/:id/commit` | 提交（环检测，409 返回具体路径） |
| POST | `/api/runs/:id/abort` | 中止 prepared 运行 |
| POST | `/api/runs/:id/revoke` | 撤销已提交运行 |
| GET | `/api/proof?source=&target=` | 证明链 |
| POST | `/api/gc/plans` | 生成回收计划 |
| POST | `/api/gc/plans/:id/execute` | 执行（重复执行幂等） |
| GET | `/api/archive/export` | 下载 tar.gz 归档 |
| POST | `/api/archive/import` | 导入空实例（`x-force: true` 覆盖） |

## 页面操作

- 拖入文件（支持多选）或点选上传，可选同时绑定别名。
- 添加输入 / 输出声明、编辑参数 JSON（“插入秘密占位”会生成 `{"__secret__": ...}`）、登记工具版本。
- `prepare（仅预留）` 后可 commit / abort；`模拟 prepare 后崩溃并重启` 会在 prepare 持久化后立即重载页面，重启后顶部出现可恢复横幅。
- 谱系图按拓扑层级展示 committed 边；选择源 / 目标后“打开证明链”展示完整路径与每步参数。
- 一键验证 blob 哈希、撤销别名或运行、生成并执行 GC 计划、导出/导入归档。

## 状态位置

所有状态都在项目目录的 `.lineage/` 下（已被 `.gitignore` 忽略）：

```
.lineage/
  ledger.json       # 原子写入的账本状态
  blobs/xx/yy/<hash>  # 内容寻址文件
```

## 技术栈与测试

- TypeScript + Vite 5（开发中间件直接提供 `/api`，无独立后端进程）+ Vitest 2。
- 归档使用 Node 内置 `zlib` 与自包含的 ustar 打包实现，零第三方运行时依赖。
- 测试覆盖：内容去重、规范化指纹、秘密哈希与掩码、环路具体路径、prepare 后崩溃重启恢复、输出缺失拒绝 commit、GC 引用保护与计划重复执行幂等、归档导入后哈希/边/状态不变与篡改拒绝。
