import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestProjectFiles } from "../project-ingestion";

const dirs: string[] = [];
const digest = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("project ingestion", () => {
  it("verifies exact shell/assets and records immutable provenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-ingestion-"));
    dirs.push(dir);
    const shell = join(dir, "shell.zip");
    const photo = join(dir, "photo.jpg");
    await writeFile(shell, "fixture-shell");
    await writeFile(photo, "fixture-photo");

    const report = await ingestProjectFiles([
      { id: "shell", kind: "BASE_SHELL", filePath: shell, expectedDigest: digest("fixture-shell"), source: "user-uploaded archive" },
      { id: "photo", kind: "ASSET", filePath: photo, expectedDigest: digest("fixture-photo"), source: "client supplied", rights: "CLIENT_SUPPLIED", observedContent: "documentary clinic photograph" },
    ]);

    expect(report.verdict).toBe("PASS");
    expect(report.files).toHaveLength(2);
    expect(report.provenanceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(report.files.find((file) => file.id === "photo")?.rights).toBe("CLIENT_SUPPLIED");
  });

  it("fails closed on a digest mismatch instead of silently accepting changed bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-ingestion-"));
    dirs.push(dir);
    const shell = join(dir, "shell.zip");
    await writeFile(shell, "changed");
    const report = await ingestProjectFiles([{ id: "shell", kind: "BASE_SHELL", filePath: shell, expectedDigest: digest("expected"), source: "user" }]);
    expect(report.verdict).toBe("FAIL");
    expect(report.findings.some((finding) => finding.code === "DIGEST_MISMATCH")).toBe(true);
  });

  it("refuses assets without explicit rights provenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-ingestion-"));
    dirs.push(dir);
    const shell = join(dir, "shell.zip");
    const photo = join(dir, "photo.jpg");
    await writeFile(shell, "shell");
    await writeFile(photo, "photo");
    const report = await ingestProjectFiles([
      { id: "shell", kind: "BASE_SHELL", filePath: shell, expectedDigest: digest("shell"), source: "user" },
      { id: "photo", kind: "ASSET", filePath: photo, expectedDigest: digest("photo"), source: "client" },
    ]);
    expect(report.verdict).toBe("FAIL");
    expect(report.findings.some((finding) => finding.code === "RIGHTS_MISSING")).toBe(true);
  });
});
