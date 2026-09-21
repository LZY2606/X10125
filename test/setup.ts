import { vi } from "vitest";

const blocked = (endpoint: string): never => {
  throw new Error(`测试期间禁止网络访问: ${endpoint}`);
};

vi.stubGlobal("fetch", ((input: unknown) => {
  const endpoint = typeof input === "string" ? input : (input as { url?: string })?.url ?? String(input);
  return blocked(endpoint);
}) as typeof fetch);

if (typeof globalThis.WebSocket !== "undefined") {
  globalThis.WebSocket = class {
    constructor(url: string) {
      blocked(`WebSocket ${url}`);
    }
  } as typeof WebSocket;
}

if (typeof globalThis.XMLHttpRequest !== "undefined") {
  globalThis.XMLHttpRequest = class {
    open(): never {
      return blocked("XMLHttpRequest");
    }
  } as unknown as typeof XMLHttpRequest;
}
