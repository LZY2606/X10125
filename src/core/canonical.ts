import type { JsonValue } from "./types.js";

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function compareUtf8(a: string, b: string): number {
  const ab = utf8Bytes(a.normalize("NFC"));
  const bb = utf8Bytes(b.normalize("NFC"));
  const length = Math.min(ab.length, bb.length);
  for (let i = 0; i < length; i++) {
    if (ab[i] !== bb[i]) {
      return (ab[i] as number) - (bb[i] as number);
    }
  }
  return ab.length - bb.length;
}

export function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return primitive(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalize(item as JsonValue)).join(",") + "]";
  }
  const keys = Object.keys(value)
    .filter((key) => (value as Record<string, JsonValue>)[key] !== undefined)
    .sort(compareUtf8);
  return (
    "{" +
    keys.map((key) => primitive(key) + ":" + canonicalize((value as Record<string, JsonValue>)[key] as JsonValue)).join(",") +
    "}"
  );
}

function primitive(value: JsonValue | string | number | boolean | null): string {
  if (typeof value === "string") {
    return JSON.stringify(value.normalize("NFC"));
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Non-finite numbers cannot be canonicalized");
    }
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

export function canonicalBytes(value: JsonValue): Uint8Array {
  return utf8Bytes(canonicalize(value));
}
