# 产物谱系账本

本地「产物谱系账本」：登记每次运行的输入 blob、参数、工具版本与输出，把多次运行连成有向无环谱系，并能从任意节点回溯完整证明链。

## 准备与演示

```bash
corepack enable && pnpm install --frozen-lockfile
pnpm test -- --run
pnpm dev -- --host 127.0.0.1 --port 5213
```

打开 http://127.0.0.1:5213 即可看到「产物谱系账本」。

## 核心概念

- **内容寻址**：文件按 SHA-256 存于 `.ledger/blobs/<hash>`，名称只是别名；同一内容重复上传自动去重（`deduplicated: true`）。
- **运行生命周期**：`prepare`（预留输入引用 + 声明输出）→ `commit`（输出进入可见谱系）或 `abort`。进程在两者之间退出后，重启（或点页面上的「模拟 prepare 后崩溃重启」）会把悬空 `prepared` 运行展示为可恢复状态。
- **运行指纹**：参数先经稳定 JSON 规范化（键递归排序），`{"$secret": "..."}` 形式的秘密值只保留 `$secretHash` 与展示掩码 `$mask`，明文永不落盘。
- **无环谱系**：commit 时检测环，拒绝并返回一条具体环路路径（如 `run:A -> blob:x -> run:B -> blob:y -> run:A`）。
- **垃圾回收**：`POST /api/gc/plan` 先生成计划；被可达节点（未撤销别名、未撤销/未中止运行的输入输出及其传递闭包）引用的内容绝不回收；同一计划重复执行幂等，不会多删。
- **可移植归档**：`GET /api/archive` 导出含全部状态与 blob 内容（base64）的 JSON；导入空实例后内容哈希、谱系边、运行状态完全保持。

## 机器可读 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 全量状态（含 `dangling` 悬空运行） |
| POST | `/api/blobs` | 上传 blob（原始字节，别名放 `x-blob-name` 头） |
| GET | `/api/blobs/:hash/verify` | 重算并校验 blob 哈希 |
| POST | `/api/aliases` / `/api/aliases/:name/revoke` | 设置 / 撤销别名 |
| POST | `/api/runs/prepare` | prepare 运行（tool、params、inputs、declaredOutputs） |
| POST | `/api/runs/:id/commit` | commit（outputs 为 base64 + 可选别名） |
| POST | `/api/runs/:id/abort` / `/api/runs/:id/revoke` | 中止 / 撤销运行 |
| GET | `/api/proof/:hash` | 从该 blob 回溯到源输入的证明链 |
| POST | `/api/gc/plan` / `/api/gc/:id/execute` | GC 计划 / 幂等执行 |
| GET | `/api/archive` / POST `/api/archive/import` | 导出 / 导入归档（仅空实例） |
| POST | `/api/debug/restart` | 模拟进程重启，返回悬空 prepared 运行 |

## 测试

`pnpm test -- --run` 运行 vitest（纯本地，不访问网络），覆盖：内容去重、规范化指纹、环路路径、崩溃恢复、秘密掩码、回收引用、GC 计划幂等、归档往返一致性。

## 目录结构

- `src/core/canon.ts` — 稳定 JSON 规范化、秘密掩码、指纹
- `src/core/store.ts` — 账本核心（状态持久化于 `.ledger/`）
- `src/server/api.ts` — HTTP API（作为 Vite 中间件挂载）
- `src/App.tsx` — 单页 UI（拖拽上传、参数编辑、谱系/证明链、GC、归档）
- `tests/ledger.test.ts` — 自动化测试
