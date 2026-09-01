import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectArtifactHashes, inspectBrowserCapture, inspectOperability, inspectSecurityHeaders } from "./quality-passport.mjs";

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

  it("only reports browser capture after all three required widths exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexus-passport-"));
    const captures = join(root, "artifacts", "browser-capture", "fixture");
    await mkdir(captures, { recursive: true });
    expect(await inspectBrowserCapture(root, "fixture")).toBeNull();

    for (const [name, width] of [["mobile-390.png", 390], ["tablet-768.png", 768], ["desktop-1440.png", 1440]]) {
      const png = Buffer.alloc(24);
      png.write("PNG", 1, "ascii");
      png.writeUInt32BE(width, 16);
      await writeFile(join(captures, name), png);
    }
    expect(await inspectBrowserCapture(root, "fixture")).toMatchObject({ id: "browser-capture", status: "PASS" });
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
