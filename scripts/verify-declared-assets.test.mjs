import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyAppAssets } from "./verify-declared-assets.mjs";

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });
function fixture() { const root=mkdtempSync(join(tmpdir(),"nexus-assets-")); roots.push(root); mkdirSync(join(root,"src"),{recursive:true}); mkdirSync(join(root,"public","portfolio"),{recursive:true}); return root; }

describe("declared asset guard", () => {
  it("passes when every declared public asset exists and is non-empty", () => {
    const app=fixture(); writeFileSync(join(app,"src","content.ts"),'export const image = "/portfolio/a.webp";\n'); writeFileSync(join(app,"public","portfolio","a.webp"),"bytes"); expect(verifyAppAssets(app).declarations).toBe(1);
  });
  it("fails closed when a declared asset is missing", () => {
    const app=fixture(); writeFileSync(join(app,"src","content.ts"),'export const image = "/portfolio/missing.webp";\n'); expect(()=>verifyAppAssets(app)).toThrow(/missing/);
  });
  it("fails closed when a declared asset is empty", () => {
    const app=fixture(); writeFileSync(join(app,"src","content.ts"),'export const image = "/portfolio/a.webp";\n'); writeFileSync(join(app,"public","portfolio","a.webp"),""); expect(()=>verifyAppAssets(app)).toThrow(/empty/);
  });
});
