import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateCraftProvenance } from "../craft-provenance";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function localFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-craft-"));
  dirs.push(dir);
  const path = join(dir, "asset.bin");
  await writeFile(path, contents);
  return path;
}

describe("evaluateCraftProvenance", () => {
  it("returns NOT_TESTED for an unevaluated project", async () => {
    expect((await evaluateCraftProvenance([])).verdict).toBe("NOT_TESTED");
  });

  it("hashes local bytes and records rights/license provenance", async () => {
    const path = await localFile("owned-photo-bytes");
    const report = await evaluateCraftProvenance([{
      id: "hero-photo",
      kind: "IMAGE",
      mode: "LOCAL_FILE",
      filePath: path,
      source: "client-shoot-2026-08-17",
      rights: "OWNED",
      licenseRef: "owner:client",
    }]);
    expect(report.verdict).toBe("PASS");
    expect(report.resources[0]?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(report.resources[0]?.byteLength).toBeGreaterThan(0);
  });

  it("fails fonts without an explicit family identity", async () => {
    const report = await evaluateCraftProvenance([{
      id: "display-font",
      kind: "FONT",
      mode: "EXTERNAL_REFERENCE",
      sourceUri: "https://fonts.example.org/specimen",
      source: "licensed-foundry",
      rights: "LICENSED",
      licenseRef: "license:123",
    }]);
    expect(report.verdict).toBe("FAIL");
    expect(report.findings[0]?.code).toBe("FONT_IDENTITY_MISSING");
  });

  it("fails motion/3D/shader dependencies without an explicit version", async () => {
    const report = await evaluateCraftProvenance([{
      id: "motion-engine",
      kind: "MOTION_LIBRARY",
      mode: "EXTERNAL_REFERENCE",
      sourceUri: "https://github.com/greensock/GSAP",
      source: "upstream",
      rights: "LICENSED",
      licenseRef: "commercial-license",
    }]);
    expect(report.verdict).toBe("FAIL");
    expect(report.findings[0]?.code).toBe("VERSION_MISSING");
  });

  it("rejects insecure external provenance instead of accepting unverifiable URLs", async () => {
    const report = await evaluateCraftProvenance([{
      id: "icon-set",
      kind: "ICON",
      mode: "EXTERNAL_REFERENCE",
      sourceUri: "http://assets.invalid/icons",
      source: "vendor",
      rights: "LICENSED",
      licenseRef: "invoice-42",
    }]);
    expect(report.verdict).toBe("FAIL");
    expect(report.findings[0]?.code).toBe("INSECURE_SOURCE");
  });
});
