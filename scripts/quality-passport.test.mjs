import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { sealClientBrowserEvidence } from "./client-browser-evidence-contract.mjs";
import { collectArtifactHashes, inspectBrowserCapture, inspectOperability, inspectSecurityHeaders } from "./quality-passport.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function withHttpServer(headers, action) {
  const server = createServer((_request, response) => {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    response.statusCode = 200;
    response.end("ok");
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test HTTP server did not expose a TCP port");
  try {
    await action(`http://127.0.0.1:${address.port}/`);
  } finally {
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  }
}

function png(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

async function writeBrowserEvidence(root, projectId, revision) {
  const captureRoot = join(root, "artifacts", "browser-capture", projectId);
  const runRoot = join(captureRoot, "request-1");
  await mkdir(runRoot, { recursive: true });

  const buildPayload = {
    authority: "NEXUS_MCP_BUILD_MANIFEST_V1",
    sourceSha: revision,
    target: `apps/${projectId}`,
    outputDigest: "b".repeat(64),
  };
  const buildManifest = {
    ...buildPayload,
    manifestSha256: sha256(Buffer.from(JSON.stringify(buildPayload), "utf8")),
  };
  const buildManifestPath = join(captureRoot, "build-manifest.json");
  await writeFile(buildManifestPath, `${JSON.stringify(buildManifest, null, 2)}\n`);

  const captures = [];
  for (const [viewport, width, height] of [
    ["mobile-390", 390, 844],
    ["tablet-768", 768, 1024],
    ["desktop-1440", 1440, 1200],
  ]) {
    const bytes = png(width, height);
    const path = join(runRoot, `${viewport}.png`);
    await writeFile(path, bytes);
    captures.push({
      browser: "chromium",
      viewport,
      width,
      height,
      path: relative(root, path).replaceAll("\\", "/"),
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }

  const evidence = sealClientBrowserEvidence({
    schemaVersion: 1,
    authority: "NEXUS_CLIENT_BROWSER_EVIDENCE_V1",
    projectId,
    sourceRevision: revision,
    route: "/",
    requestId: "request-1",
    runId: "run-1",
    build: {
      authority: buildManifest.authority,
      target: buildManifest.target,
      manifestPath: relative(root, buildManifestPath).replaceAll("\\", "/"),
      manifestSha256: buildManifest.manifestSha256,
      outputDigest: buildManifest.outputDigest,
    },
    captures,
  });
  await writeFile(join(captureRoot, "evidence-manifest.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  return { captureRoot, evidence, captures };
}

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; frame-ancestors 'self'; object-src 'none'; img-src 'self' data:",
};

describe("quality passport generator", () => {
  it("hashes build files using repository-relative paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-passport-"));
    const output = join(root, "apps", "fixture", ".next");
    await mkdir(join(output, "server"), { recursive: true });
    await writeFile(join(output, "server", "page.js"), "built output\n");

    const hashes = await collectArtifactHashes(root, output);

    expect(hashes).toEqual({
      "apps/fixture/.next/server/page.js": "ba09ea91674745c16f8c33e4bb423c6ffaf25e6bd55a651ecc91269cfd6d9d69",
    });
  });

  it("omits browser evidence only when no project evidence directory exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-passport-"));
    expect(await inspectBrowserCapture(root, "fixture", "a".repeat(40))).toBeNull();

    const captures = join(root, "artifacts", "browser-capture", "fixture");
    await mkdir(captures, { recursive: true });
    await expect(inspectBrowserCapture(root, "fixture", "a".repeat(40))).rejects.toThrow(/exists without .*evidence-manifest\.json/);
  });

  it("accepts browser capture only when project, exact source, build and all screenshot bytes are bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-passport-"));
    const revision = "a".repeat(40);
    await writeBrowserEvidence(root, "fixture", revision);

    const result = await inspectBrowserCapture(root, "fixture", revision);
    expect(result).toMatchObject({ id: "browser-capture", status: "PASS" });
    expect(result.evidenceIds).toHaveLength(5);
    expect(result.detail).toContain("exact-SHA fixture Chromium browser evidence");
  });

  it("rejects stale browser evidence from a different source revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-passport-stale-"));
    await writeBrowserEvidence(root, "fixture", "a".repeat(40));
    await expect(inspectBrowserCapture(root, "fixture", "b".repeat(40))).rejects.toThrow(/stale for the current source revision/);
  });

  it("rejects browser evidence when persisted screenshot bytes change after the manifest was sealed", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-passport-tamper-"));
    const revision = "a".repeat(40);
    const { captures } = await writeBrowserEvidence(root, "fixture", revision);
    await writeFile(join(root, captures[0].path), png(391, 844));
    await expect(inspectBrowserCapture(root, "fixture", revision)).rejects.toThrow(/PNG dimensions do not match|digest does not match/);
  });

  it("omits unavailable H-07 evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-passport-"));
    expect(await inspectOperability(root, "a".repeat(40))).toBeNull();
  });

  it("certifies security headers only after observing them on a real HTTP response", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-passport-security-"));
    const evidence = join(root, ".artifacts", "evidence");
    await mkdir(evidence, { recursive: true });
    const revision = "a".repeat(40);

    await withHttpServer(securityHeaders, async (url) => {
      const result = await inspectSecurityHeaders(root, revision, url, evidence);
      expect(result).toMatchObject({ id: "security-headers", status: "PASS" });
      const record = JSON.parse(await readFile(join(evidence, "security-headers.json"), "utf8"));
      expect(record).toMatchObject({
        authority: "NEXUS_HTTP_SECURITY_HEADERS_OBSERVATION_V1",
        sourceRevision: revision,
        responseStatus: 200,
        failures: [],
      });
      expect(record.observedHeaders["content-security-policy"]).toContain("default-src 'self'");
    });
  });

  it("fails live security evidence when the HTTP response omits CSP", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-passport-security-fail-"));
    const evidence = join(root, ".artifacts", "evidence");
    await mkdir(evidence, { recursive: true });
    const headersWithoutCsp = Object.fromEntries(
      Object.entries(securityHeaders).filter(([name]) => name !== "Content-Security-Policy"),
    );

    await withHttpServer(headersWithoutCsp, async (url) => {
      const result = await inspectSecurityHeaders(root, "b".repeat(40), url, evidence);
      expect(result.status).toBe("FAIL");
      expect(result.detail).toMatch(/content-security-policy header missing/);
    });
  });
});
