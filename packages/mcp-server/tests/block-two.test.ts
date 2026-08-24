import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createQualityPassport, verifyQualityPassport } from "@nexus/quality/quality-passport";
import type { GitState, ProjectState } from "../src/contracts.js";
import { readPassport } from "../src/passport.js";
import type { GateId } from "../src/gates.js";
import { nexusCapture, nexusGates, nexusPassport } from "../src/tools.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const sha = "a".repeat(40);
const git: GitState = { branch: "work", headSha: sha, detached: false, clean: true, changedPaths: [], remoteUrl: null };
const project: ProjectState = { slug: "reference-alfil", path: "apps/reference-alfil", packageName: "@nexus/reference-alfil", workspaceMember: true, kind: "REFERENCE", clientProject: false, evidence: { packageJsonPath: "apps/reference-alfil/package.json", clientProjectDeclaration: null, classificationRule: "reference" } };
const base = { root: "/repo", git: async () => git, projects: async () => [project], requestId: () => "request-block-two" };

it("aggregates executed gate PASS, FAIL and NOT_TESTED without optimistic defaults", async () => {
  const make = (status: "PASS" | "FAIL" | "NOT_TESTED") => async (_root: string, id: GateId) => ({ id, status, command: "pnpm lint", exitCode: status === "PASS" ? 0 : status === "FAIL" ? 1 : null, durationMs: 1, logPath: "/tmp/lint.log", reason: status === "PASS" ? null : status, evidencePaths: ["/tmp/lint.log"] });
  expect((await nexusGates({ sourceSha: sha, gates: ["lint"] }, { ...base, gateRunner: make("PASS") })).status).toBe("PASS");
  expect((await nexusGates({ sourceSha: sha, gates: ["lint"] }, { ...base, gateRunner: make("FAIL") })).status).toBe("FAIL");
  expect((await nexusGates({ sourceSha: sha, gates: ["lint"] }, { ...base, gateRunner: make("NOT_TESTED") })).status).toBe("NOT_TESTED");
});

it("rejects gates against a different SHA without executing a command", async () => {
  let ran = false;
  const result = await nexusGates({ sourceSha: "b".repeat(40), gates: ["lint"] }, { ...base, gateRunner: async () => { ran = true; throw new Error("must not run"); } });
  expect(result.status).toBe("FAIL");
  expect(result.errors[0]?.code).toBe("SOURCE_SHA_MISMATCH");
  expect(ran).toBe(false);
});

it("uses the existing Quality Passport creator/verifier and reports missing evidence as NOT_TESTED", async () => {
  const root = await mkdtemp(join(tmpdir(), "nexus-mcp-passport-")); roots.push(root);
  const directory = join(root, ".artifacts", "quality-passports"); await mkdir(directory, { recursive: true });
  const passport = createQualityPassport({ projectId: project.slug, engineVersion: "6.0.0", sourceRevision: sha, generatedAt: "2026-08-24T00:00:00.000Z", viewport: { width: 390, height: 844 }, artifactHashes: { "capture.png": "c".repeat(64) }, checks: [{ id: "browser", status: "PASS", detail: "real capture", evidenceIds: ["capture:mobile"] }] });
  await writeFile(join(directory, `${project.slug}.json`), `${JSON.stringify(passport, null, 2)}\n`);
  const dependencies = { ...base, root, passportReader: (repoRoot: string, target: string, path?: string) => readPassport(repoRoot, target, path, verifyQualityPassport) };
  const found = await nexusPassport({ target: project.slug, sourceSha: sha }, dependencies);
  expect(found.status).toBe("PASS");
  expect(found.data?.passport?.authority).toBe("NEXUS_QUALITY_PASSPORT_V1");
  const missing = await nexusPassport({ target: "missing", sourceSha: sha }, { ...dependencies, projects: async () => [{ ...project, slug: "missing" }] });
  expect(missing.status).toBe("NOT_TESTED");
  expect(missing.errors[0]?.code).toBe("PASSPORT_NOT_FOUND");
});

it("keeps remote URL capture NOT_TESTED and reports successful adapter evidence", async () => {
  const remote = await nexusCapture({ source: { url: "https://example.com" } }, base);
  expect(remote.status).toBe("NOT_TESTED");
  expect(remote.errors[0]?.code).toBe("REMOTE_URL_CAPTURE_POLICY_UNAVAILABLE");
  const captured = await nexusCapture({ source: { target: project.slug }, sourceSha: sha }, { ...base, captureRunner: async () => ({ captures: [{ viewport: "mobile", width: 390, height: 844, browser: "chromium", finalUrl: "http://127.0.0.1", artifact: { path: ".artifacts/mobile.png", mediaType: "image/png", byteLength: 8, sha256: "d".repeat(64), url: "/artifacts/request/mobile.png" } }, { viewport: "desktop", width: 1440, height: 1000, browser: "chromium", finalUrl: "http://127.0.0.1", artifact: { path: ".artifacts/desktop.png", mediaType: "image/png", byteLength: 8, sha256: "e".repeat(64), url: "/artifacts/request/desktop.png" } }] }) });
  expect(captured.status).toBe("PASS");
  expect(captured.data?.captures).toHaveLength(2);
});
