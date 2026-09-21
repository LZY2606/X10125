import { describe, it, expect } from "vitest";
import { canonicalize } from "../src/core/canonical.js";

describe("稳定 JSON 规范化", () => {
  it("对象键按 UTF-8 排序，数组保持顺序", () => {
    expect(canonicalize({ b: 1, a: 2, c: [3, { z: 1, a: 2 }] })).toBe(
      '{"a":2,"b":1,"c":[3,{"a":2,"z":1}]}'
    );
  });

  it("嵌套键顺序不影响结果", () => {
    expect(canonicalize({ x: { d: 4, a: { y: 1, b: 2 } }, m: 1 })).toBe(
      canonicalize({ m: 1, x: { a: { b: 2, y: 1 }, d: 4 } })
    );
  });
});
