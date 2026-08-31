import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

describe("query fan-out runtime consumer", () => {
  test("executes the compiled package and preserves evidence labels", () => {
    execFileSync("pnpm", ["--filter", "@nexus/query-fanout", "build"], { cwd: root, stdio: "pipe" });
    const dir = mkdtempSync(join(tmpdir(), "nexus-query-fanout-"));
    try {
      const inputPath = join(dir, "input.json");
      writeFileSync(inputPath, JSON.stringify({
        fanOut: {
          rootQuery: "abogado fiscal colima",
          locale: "es-MX",
          intents: [{ id: "compare", label: "comparar opciones", weight: 0.8 }],
          entities: [{ id: "geo-colima", label: "Colima", weight: 1 }],
          attributes: [{ id: "cost", label: "costos", weight: 0.7 }],
          constraints: [],
          evidenceNeeds: ["EXPERIENCE"],
        },
        corpus: [{
          id: "p1",
          url: "https://example.com/fiscal",
          heading: "Defensa fiscal en Colima",
          text: "Experiencia y costos de consulta.",
          topics: ["defensa fiscal"],
          entities: ["Colima"],
          evidence: ["EXPERIENCE"],
        }],
      }));

      const result = spawnSync(process.execPath, ["scripts/audit-query-fanout.mjs", "--input", inputPath], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as {
        evidenceState: string;
        externalCorpusVerification: string;
        interpretation: string;
        report: { weightedCoverage: number };
      };
      expect(output.evidenceState).toBe("OBSERVED");
      expect(output.externalCorpusVerification).toBe("NOT_VERIFIED");
      expect(output.interpretation).toBe("SIMULATED_PLAUSIBLE_NOT_OBSERVED_GOOGLE_INTERNAL_QUERIES");
      expect(output.report.weightedCoverage).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails closed when runtime evidence input is absent", () => {
    const result = spawnSync(process.execPath, ["scripts/audit-query-fanout.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ evidenceState: "UNAVAILABLE", reason: "INPUT_NOT_PROVIDED" });
  });
});
