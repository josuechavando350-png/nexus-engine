import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PerceptualImageCwvAdapter } from "./cwv-adapter";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("CORTEX #33 perceptual image build adapter", () => {
  it("returns NO_CHANGE with digest evidence when the native optimization toolchain is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-cwv-image-adapter-")); dirs.push(dir);
    writeFileSync(join(dir, "hero.jpg"), Buffer.from("not-decoded-when-toolchain-is-unavailable"));
    const adapter = new PerceptualImageCwvAdapter({
      inputRoot: dir,
      outputRoot: join(dir, "optimized"),
      tools: { avifenc: join(dir, "missing-avifenc"), avifdec: join(dir, "missing-avifdec"), cjxl: join(dir, "missing-cjxl"), djxl: join(dir, "missing-djxl"), ssimulacra2: join(dir, "missing-ssimulacra2") },
    });
    const receipt = await adapter.apply({ actionId: "image-hero-main", kind: "IMAGE_PERCEPTUAL", target: "/hero.jpg", required: true });
    expect(receipt.status).toBe("NO_CHANGE");
    expect(receipt.beforeDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(receipt.evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("rejects targets that escape the configured input root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-cwv-image-adapter-")); dirs.push(dir);
    const adapter = new PerceptualImageCwvAdapter({ inputRoot: dir, outputRoot: join(dir, "optimized"), tools: { avifenc: "/missing/a", avifdec: "/missing/b", cjxl: "/missing/c", djxl: "/missing/d", ssimulacra2: "/missing/e" } });
    await expect(adapter.apply({ actionId: "image-escape-test", kind: "IMAGE_PERCEPTUAL", target: "/../secret.jpg", required: true })).rejects.toThrow(/escapes configured root/u);
  });
});
