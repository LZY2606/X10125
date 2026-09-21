export interface BlobMeta { hash: string; size: number; createdAt: string; deduplicated?: boolean }
export interface Alias { name: string; hash: string; revoked: boolean }
export interface Run {
  id: string;
  tool: { name: string; version: string };
  paramsCanonical: string;
  paramsHash: string;
  inputs: Array<{ hash: string; alias?: string | null }>;
  declaredOutputs: Array<{ alias?: string | null }>;
  outputs: Array<{ hash: string; alias?: string | null }>;
  status: "prepared" | "committed" | "aborted";
  revoked: boolean;
  fingerprint: string;
  createdAt: string;
}
export interface GcPlan { id: string; createdAt: string; targets: string[]; executions: Array<{ at: string; deleted: string[] }> }
export interface LedgerState {
  blobs: BlobMeta[];
  aliases: Alias[];
  runs: Run[];
  dangling: Run[];
  gcPlans: GcPlan[];
}
export interface ProofNode {
  blob: { hash: string; size: number };
  aliases: string[];
  producedBy: { id: string; tool: { name: string; version: string }; paramsCanonical: string; fingerprint: string; status: string } | null;
  inputs: ProofNode[];
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`) as Error & { cycle?: string[] };
    if (data.cycle) err.cycle = data.cycle;
    throw err;
  }
  return data as T;
}

export const api = {
  state: () => req<LedgerState>("/api/state"),
  upload: (file: File, alias?: string) =>
    req<BlobMeta>("/api/blobs", {
      method: "POST",
      headers: alias ? { "x-blob-name": encodeURIComponent(alias) } : {},
      body: file,
    }),
  verify: (hash: string) => req<{ hash: string; ok: boolean; actual: string }>(`/api/blobs/${hash}/verify`),
  revokeAlias: (name: string) => req(`/api/aliases/${encodeURIComponent(name)}/revoke`, { method: "POST" }),
  prepare: (body: unknown) => req<Run>("/api/runs/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  commit: (id: string, outputs: Array<{ dataBase64: string; alias?: string | null }>) =>
    req<Run>(`/api/runs/${id}/commit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outputs }) }),
  abort: (id: string) => req<Run>(`/api/runs/${id}/abort`, { method: "POST" }),
  revokeRun: (id: string) => req<Run>(`/api/runs/${id}/revoke`, { method: "POST" }),
  proof: (hash: string) => req<ProofNode>(`/api/proof/${hash}`),
  gcPlan: () => req<GcPlan>("/api/gc/plan", { method: "POST" }),
  gcExecute: (id: string) => req<{ deleted: string[]; plan: GcPlan }>(`/api/gc/${id}/execute`, { method: "POST" }),
  archive: () => req<Record<string, unknown>>("/api/archive"),
  importArchive: (archive: unknown) => req("/api/archive/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(archive) }),
  restart: () => req<{ restarted: boolean; dangling: Run[] }>("/api/debug/restart", { method: "POST" }),
};

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
