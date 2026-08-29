import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { captureGeometrySnapshot, compareGeometry, type GeometricDesignDna } from "../geometric-comparator";
const fixture = fileURLToPath(new URL("../../../tests/fixtures/nexus-bot-studio-broken/", import.meta.url));
describe("geometric comparator permanent negative fixture", () => {
  it("stays red for every required geometry and structured DNA violation", async () => {
    const dna = JSON.parse(await readFile(resolve(fixture, "design-dna.json"), "utf8")) as GeometricDesignDna;
    const browser = await chromium.launch({ headless: true });
    try { const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); await page.goto(`file://${resolve(fixture, "index.html")}`); const report = compareGeometry(await captureGeometrySnapshot(page), dna); console.log(`NEXUS GEOMETRIC FIXTURE: ${report.verdict}\n${report.violations.map((item) => `RED ${item.id} ${item.elements.join("+") || "DNA"}`).join("\n")}`); expect(report.verdict).toBe("FAIL"); expect(new Set(report.violations.map((item) => item.id))).toEqual(new Set(["TEXT_OVERLAP", "SECTION_ESCAPE", "VISUAL_OVER_TEXT", "TEXT_CLIPPED", "FORBIDDEN_TYPOGRAPHY_MIX", "IDENTICAL_COLUMNS_FORBIDDEN", "FOCUS_TREATMENT_MISSING"]));
    }
    finally { await browser.close(); }
  });
});
