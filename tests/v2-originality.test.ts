import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareFingerprints, type StyleFingerprintV2 } from "../packages/experience/originality";

const root = process.cwd();
const probes = ["v2-probe-editorial", "v2-probe-cinematic", "v2-probe-industrial", "v2-probe-asymmetric"];
const fingerprints = probes.map((probe) => JSON.parse(readFileSync(join(root, "apps", probe, "style-fingerprint-v2.json"), "utf8")) as StyleFingerprintV2);

describe("NEXUS V2 structural originality probes", () => {
  it("ships four radically different structural fingerprints", () => {
    expect(new Set(fingerprints.map((fp) => fp.openingSignature)).size).toBe(4);
    expect(new Set(fingerprints.map((fp) => fp.navigationSignature)).size).toBe(4);
    expect(new Set(fingerprints.map((fp) => fp.sectionSequence.join(">"))).size).toBe(4);
    expect(fingerprints.every((fp) => fp.structure.cardReliance === 0)).toBe(true);
  });

  it("keeps fingerprints independent from color/palette", () => {
    for (const fingerprint of fingerprints) {
      expect(JSON.stringify(fingerprint)).not.toMatch(/color|palette|#[0-9a-f]{3,8}/i);
    }
  });

  it("does not detect exact structural duplication in any pair", () => {
    for (let i = 0; i < fingerprints.length; i++) {
      for (let j = i + 1; j < fingerprints.length; j++) {
        const report = compareFingerprints(fingerprints[i]!, fingerprints[j]!);
        expect(report.warnings).not.toContain(expect.stringMatching(/exact structural duplication/));
        expect(report.dimensions.filter((dimension) => dimension.score === 1).length).toBeLessThan(3);
      }
    }
  });
});
