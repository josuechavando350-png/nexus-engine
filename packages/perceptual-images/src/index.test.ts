import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  NON_CLAIM,
  createPolicy,
  inspectToolchain,
  optimizeImage,
  parseSsimulacra2,
  renderPicture,
  selectSmallestPassing,
  thresholdForTier,
  type CandidateResult,
  type CommandRunner,
  type ToolPaths,
} from "./index.js";

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-perceptual-test-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function candidate(codec: "AVIF" | "JXL", bytes: number, score: number, passing: boolean, key = "x"): CandidateResult {
  return { codec, bytes, score, passing, key, outputPath: `/${key}`, outputSha256: "a".repeat(64) };
}

describe("perceptual images", () => {
  it("preserves documented quality tiers and bounded candidate space", () => {
    expect(thresholdForTier("HIGH")).toBe(70);
    expect(thresholdForTier("EXCELLENT")).toBe(85);
    expect(thresholdForTier("VISUALLY_LOSSLESS")).toBe(90);
    expect(() => createPolicy({ tier: "HIGH", minimumSavingsRatio: 0.1, avif: [], jxl: [] })).toThrow(/empty/);
    expect(() => createPolicy({ tier: "HIGH", minimumSavingsRatio: 1, avif: [{ quality: 50, speed: 5, chroma: "420" }], jxl: [] })).toThrow(/minimumSavingsRatio/);
  });

  it("selects only the smallest passing candidate inside the declared search space", () => {
    const selected = selectSmallestPassing([
      candidate("AVIF", 100, 95, true, "large"),
      candidate("AVIF", 60, 86, true, "small"),
      candidate("AVIF", 40, 70, false, "bad"),
      candidate("JXL", 20, 99, true, "other"),
    ], "AVIF");
    expect(selected?.key).toBe("small");
  });

  it("parses SSIMULACRA2 and rejects malformed/non-finite-looking outputs", () => {
    expect(parseSsimulacra2("SSIMULACRA2: 87.25")).toBe(87.25);
    expect(() => parseSsimulacra2("no score")).toThrow(/missing/);
    expect(() => parseSsimulacra2("score 101")).toThrow(/invalid/);
  });

  it("keeps JXL enhancement-only with AVIF and mandatory fallback", () => {
    const html = renderPicture({ jxl: "/a.jxl", avif: "/a.avif", fallback: "/a.jpg", alt: "A & B", width: 100, height: 50 });
    expect(html.indexOf("image/jxl")).toBeLessThan(html.indexOf("image/avif"));
    expect(html).toContain('/a.jpg');
    expect(html).toContain('alt="A &amp; B"');
    expect(() => renderPicture({ fallback: "https://evil.example/a.jpg", alt: "x", width: 1, height: 1 })).toThrow(/root-relative/);
  });

  it("fails closed as UNAVAILABLE when any native tool is absent", async () => {
    await withTemp(async (dir) => {
      const paths = { avifenc: join(dir, "avifenc"), avifdec: join(dir, "avifdec"), cjxl: join(dir, "cjxl"), djxl: join(dir, "djxl"), ssimulacra2: join(dir, "ssimulacra2") };
      await writeFile(paths.avifenc, "x");
      const evidence = await inspectToolchain(paths, async () => ({ stdout: "v1", stderr: "" }));
      expect(evidence.status).toBe("UNAVAILABLE");
      expect(evidence.missing).toContain("ssimulacra2");
    });
  });

  it("does not misclassify an existing tool when its version flag is unsupported", async () => {
    await withTemp(async (dir) => {
      const tools: ToolPaths = {
        avifenc: join(dir, "avifenc"), avifdec: join(dir, "avifdec"), cjxl: join(dir, "cjxl"), djxl: join(dir, "djxl"), ssimulacra2: join(dir, "ssimulacra2"),
      };
      for (const path of Object.values(tools)) await writeFile(path, "tool-v1");
      const evidence = await inspectToolchain(tools, async (file) => {
        if (file.endsWith("ssimulacra2")) throw new Error("no version flag");
        return { stdout: "tool 1.0", stderr: "" };
      });
      expect(evidence.status).toBe("AVAILABLE");
      expect(evidence.missing).toEqual([]);
      expect(evidence.binaries.find((binary) => binary.name === "ssimulacra2")?.version).toBe("VERSION_PROBE_UNSUPPORTED");
    });
  });

  it("runs a real filesystem integration around an injected deterministic native runner", async () => {
    await withTemp(async (dir) => {
      const tools: ToolPaths = {
        avifenc: join(dir, "avifenc"), avifdec: join(dir, "avifdec"), cjxl: join(dir, "cjxl"), djxl: join(dir, "djxl"), ssimulacra2: join(dir, "ssimulacra2"),
      };
      for (const path of Object.values(tools)) await writeFile(path, "tool-v1");
      const source = join(dir, "source.png");
      await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 12, g: 50, b: 90 } } }).png().toFile(source);
      const decodedFixture = join(dir, "decoded.png");
      await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 12, g: 50, b: 90 } } }).png().toFile(decodedFixture);

      const runner: CommandRunner = async (file, args) => {
        const name = file.split("/").at(-1)!;
        if (args.includes("--version") || args.includes("-version")) return { stdout: `${name} 1.0`, stderr: "" };
        if (name === "ssimulacra2") return { stdout: "SSIMULACRA2 92.5", stderr: "" };
        if (name === "avifenc") { await writeFile(args.at(-1)!, "tiny-avif"); return { stdout: "", stderr: "" }; }
        if (name === "cjxl") { await writeFile(args[1]!, "tiny-jxl"); return { stdout: "", stderr: "" }; }
        if (name === "avifdec" || name === "djxl") { await copyFile(decodedFixture, args[1]!); return { stdout: "", stderr: "" }; }
        throw new Error(`unexpected ${name}`);
      };
      const report = await optimizeImage({
        sourcePath: source,
        outputDir: join(dir, "out"),
        tools,
        runner,
        policy: createPolicy({ tier: "EXCELLENT", minimumSavingsRatio: 0, avif: [{ quality: 60, speed: 6, chroma: "420" }], jxl: [{ distance: 1, effort: 7 }] }),
      });
      expect(report.status).toBe("READY");
      expect(report.nonClaim).toBe(NON_CLAIM);
      expect(report.candidates).toHaveLength(2);
      expect(report.selected.AVIF?.score).toBe(92.5);
      expect(report.selected.JXL?.score).toBe(92.5);
      expect((await stat(report.selected.AVIF!.outputPath)).isFile()).toBe(true);
      expect((await readFile(report.selected.JXL!.outputPath)).length).toBeGreaterThan(0);
    });
  });
});
