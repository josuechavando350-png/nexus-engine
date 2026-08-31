import { describe, expect, it } from "vitest";
import { saliencyCanonicalJson } from "../saliency-model.js";

describe("saliency canonicalization hardening", () => {
  it("rejects self-referential arrays without unbounded recursion", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => saliencyCanonicalJson(cyclic)).toThrow(/cyclic objects/);
  });

  it("rejects mixed object-array cycles without unbounded recursion", () => {
    const array: unknown[] = [];
    const object: Record<string, unknown> = { array };
    array.push(object);
    expect(() => saliencyCanonicalJson(object)).toThrow(/cyclic objects/);
  });
});
