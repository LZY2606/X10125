export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RunStatus = "prepared" | "committed" | "aborted" | "revoked";

export interface StoredSecret {
  __secret__: true;
  hash: string;
  mask: string;
}

export interface InputRef {
  alias?: string;
  role?: string;
}

export interface OutputDeclaration {
  role?: string;
  mediaType?: string;
}

export interface BlobRecord {
  id: string;
  size: number;
  createdAt: string;
}

export interface AliasRecord {
  name: string;
  blobId: string;
  createdAt: string;
  revoked: boolean;
}

export interface RunRecord {
  id: string;
  status: RunStatus;
  createdAt: string;
  committedAt?: string;
  endedAt?: string;
  inputs: Record<string, InputRef>;
  outputs: Record<string, OutputDeclaration & { size: number }>;
  params: JsonValue;
  toolVersions: Record<string, string>;
  fingerprint: string;
  note?: string;
}

export interface GcEntry {
  blobId: string;
  size: number;
  reason: string;
}

export interface GcPlanRecord {
  id: string;
  createdAt: string;
  entries: GcEntry[];
  status: "pending" | "executed";
  executedAt?: string;
  deleted: string[];
  missing: string[];
}

export interface LedgerState {
  version: 1;
  blobs: Record<string, BlobRecord>;
  aliases: Record<string, AliasRecord>;
  runs: Record<string, RunRecord>;
  gcPlans: Record<string, GcPlanRecord>;
}
