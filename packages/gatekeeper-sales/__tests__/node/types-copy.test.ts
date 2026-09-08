// `types.txt` is what the agent receives from getTypeScriptTypes(); `types.d.ts` is what the code
// implements. Upstream keeps them one file via a symlink, which Windows checkouts flatten into a
// 10-byte stub — so this package ships a real copy and this test keeps the two identical.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("types.txt", () => {
  it("is byte-identical to types.d.ts", () => {
    const dts = readFileSync(new URL("../../src/types.d.ts", import.meta.url), "utf8");
    const txt = readFileSync(new URL("../../src/types.txt", import.meta.url), "utf8");
    expect(txt).toBe(dts);
  });
});
