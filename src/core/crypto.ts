import { createHash } from "node:crypto";

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Id(prefix: string, data: Uint8Array | string): string {
  return `${prefix}-${sha256Hex(data)}`;
}
