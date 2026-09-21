import { gzipSync, gunzipSync } from "node:zlib";

interface WriteEntry {
  path: string;
  data: Uint8Array;
}

function octal(value: number, length: number): Uint8Array {
  const text = value.toString(8).padStart(length - 1, "0") + "\0";
  return new TextEncoder().encode(text);
}

function header(entry: WriteEntry): Uint8Array {
  const block = new Uint8Array(512);
  const view = new DataView(block.buffer);
  const name = new TextEncoder().encode(entry.path);
  block.set(name.slice(0, 100), 0);
  block.set(octal(0o644, 8), 100);
  block.set(octal(0, 8), 108);
  block.set(octal(0, 8), 116);
  block.set(octal(entry.data.length, 12), 124);
  block.set(octal(0, 12), 136);
  view.setUint32(148, 0x00000000);
  block[156] = 0x30;
  block.set(new TextEncoder().encode("ustar\0"), 257);
  block.set(new TextEncoder().encode("00"), 263);
  for (let i = 148; i < 156; i++) block[i] = 0x20;
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += block[i] ?? 0;
  block.set(octal(checksum, 7), 148);
  block[155] = 0x20;
  return block;
}

export function createTar(entries: WriteEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const sorted = entries.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of sorted) {
    parts.push(header(entry));
    parts.push(entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding) parts.push(new Uint8Array(padding));
  }
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface TarEntry {
  path: string;
  data: Uint8Array;
}

export function readTar(buffer: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    let sizeOctal = "";
    for (let i = 124; i < 136; i++) {
      const byte = block[i];
      if (byte === 0 || byte === 0x20) break;
      sizeOctal += String.fromCharCode(byte as number);
    }
    const size = parseInt(sizeOctal || "0", 8);
    offset += 512;
    const nameBytes: number[] = [];
    for (let i = 0; i < 100; i++) {
      const byte = block[i];
      if (byte === 0) break;
      nameBytes.push(byte as number);
    }
    const path = new TextDecoder().decode(Uint8Array.from(nameBytes));
    if (size > 0) {
      entries.push({ path, data: buffer.slice(offset, offset + size) });
    }
    offset += size + ((512 - (size % 512)) % 512);
  }
  return entries;
}

export function createTarGz(entries: WriteEntry[]): Uint8Array {
  return gzipSync(createTar(entries));
}

export function readTarGz(data: Uint8Array): TarEntry[] {
  return readTar(gunzipSync(data));
}
