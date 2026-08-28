import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectArtifactHashes, inspectBrowserCapture, inspectOperability } from "./quality-passport.mjs";

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
});
