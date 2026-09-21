import { sha256Hex } from "./crypto.js";
import type { JsonValue, StoredSecret } from "./types.js";

const SECRET_KEY = "__secret__";

export function isSecretMarker(value: unknown): value is { [SECRET_KEY]: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)[SECRET_KEY] === "string"
  );
}

export function maskSecret(secret: string): string {
  if (secret.length <= 2) {
    return "*".repeat(secret.length || 1);
  }
  if (secret.length <= 6) {
    return secret[0] + "***";
  }
  return secret.slice(0, 1) + "***" + secret.slice(-2);
}

export function redactParams(value: JsonValue): JsonValue {
  if (isSecretMarker(value)) {
    const secret = value[SECRET_KEY];
    const stored: StoredSecret = {
      __secret__: true,
      hash: sha256Hex(secret),
      mask: maskSecret(secret)
    };
    return stored as unknown as JsonValue;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactParams(item as JsonValue));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactParams(item as JsonValue);
    }
    return out;
  }
  return value;
}

export function assertNoLiveSecrets(value: unknown, path = "$"): void {
  if (isSecretMarker(value)) {
    throw new Error(`Unredacted secret marker at ${path}`);
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      assertNoLiveSecrets(item, `${path}.${key}`);
    }
  }
}

export function isStoredSecret(value: unknown): value is StoredSecret {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as StoredSecret).__secret__ === true &&
    typeof (value as StoredSecret).hash === "string"
  );
}
