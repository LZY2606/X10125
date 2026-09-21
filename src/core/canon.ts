import { createHash } from "node:crypto";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface SecretBox {
  $secret: string;
}

export function isSecretBox(value: unknown): value is SecretBox {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).$secret === "string" &&
    Object.keys(value as Record<string, unknown>).length === 1
  );
}

export interface MaskedSecret {
  $secretHash: string;
  $mask: string;
}

export function maskSecret(plain: string): MaskedSecret {
  const tail = plain.length <= 2 ? "" : plain.slice(-2);
  return { $secretHash: sha256Hex(plain), $mask: `•••${tail}` };
}

/**
 * Recursively replace {$secret: "..."} boxes with hash+mask so the
 * plaintext never persists. Plain values pass through untouched.
 */
export function scrubSecrets(value: unknown): unknown {
  if (isSecretBox(value)) return maskSecret(value.$secret);
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubSecrets(v);
    return out;
  }
  return value;
}

/** Stable JSON: object keys sorted recursively, no insignificant whitespace. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`
  );
  return `{${parts.join(",")}}`;
}

/** Scrub secrets, canonicalize, return the canonical string and its fingerprint hash. */
export function fingerprintParams(params: unknown): { canonical: string; hash: string } {
  const canonical = canonicalize(scrubSecrets(params));
  return { canonical, hash: sha256Hex(canonical) };
}
