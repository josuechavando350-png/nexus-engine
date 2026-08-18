import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateContentReadiness } from "../content-readiness";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(name = "hero.png"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-content-ready-"));
  dirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, PNG_1X1);
  return path;
}

describe("evaluateContentReadiness", () => {
  it("passes only when caller-required photo/copy roles exist with real readable evidence", async () => {
    const path = await fixture();
    const report = await evaluateContentReadiness({
      policy: { requiredPhotoRoles: ["hero"], requiredCopyRoles: ["headline"] },
      photos: [{ role: "hero", filePath: path, rights: "OWNED", source: "client-shoot-2026-08-17" }],
      copy: [{ role: "headline", text: "Coffee worth crossing the street for.", source: "client-approved-copy-v3" }],
    });
    expect(report.verdict).toBe("PASS");
    expect(report.findings).toHaveLength(0);
    expect(report.photos[0]).toMatchObject({ mediaType: "image/png", width: 1, height: 1, byteLength: PNG_1X1.byteLength });
    expect(report.photos[0]?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(report.copy[0]?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("fails closed on missing files, missing roles and placeholder copy", async () => {
    const report = await evaluateContentReadiness({
      policy: { requiredPhotoRoles: ["hero", "ritual"], requiredCopyRoles: ["headline", "cta"] },
      photos: [{ role: "hero", filePath: "/definitely/missing/nexus.jpg", rights: "LICENSED", source: "license-42" }],
      copy: [{ role: "headline", text: "Lorem ipsum placeholder", source: "draft" }],
    });
    expect(report.verdict).toBe("FAIL");
    expect(new Set(report.findings.map((finding) => finding.code))).toEqual(new Set([
      "PHOTO_UNREADABLE",
      "PHOTO_ROLE_MISSING",
      "COPY_PLACEHOLDER",
      "COPY_ROLE_MISSING",
    ]));
  });

  it("enforces policy-supplied minimum dimensions instead of inventing a global threshold", async () => {
    const path = await fixture();
    const report = await evaluateContentReadiness({
      policy: { requiredPhotoRoles: ["hero"], requiredCopyRoles: [], minimumPhotoWidthPx: 1200, minimumPhotoHeightPx: 800 },
      photos: [{ role: "hero", filePath: path, rights: "CLIENT_SUPPLIED", source: "client-upload" }],
      copy: [],
    });
    expect(report.verdict).toBe("FAIL");
    expect(report.findings.map((finding) => finding.code)).toContain("PHOTO_DIMENSIONS_BELOW_POLICY");
  });

  it("returns NOT_TESTED when no requirements were supplied instead of pretending readiness", async () => {
    const report = await evaluateContentReadiness({ policy: { requiredPhotoRoles: [], requiredCopyRoles: [] }, photos: [], copy: [] });
    expect(report.verdict).toBe("NOT_TESTED");
  });
});
