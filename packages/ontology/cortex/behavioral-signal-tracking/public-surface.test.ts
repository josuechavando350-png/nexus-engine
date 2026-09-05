import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface OntologyPackageManifest {
  readonly exports: Readonly<Record<string, string>>;
}

describe("behavioral signal governed public surface", () => {
  it("exports the governed facade and does not expose lower-level engine or suite subpaths", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as OntologyPackageManifest;

    expect(manifest.exports["./cortex/behavioral-signal-tracking"]).toBe("./cortex/behavioral-signal-tracking/public.ts");
    expect(manifest.exports["./cortex/behavioral-signal-tracking/suite"]).toBeUndefined();

    const publicSurface = await import("./public");
    expect(publicSurface).toHaveProperty("CortexBehavioralSignalRuntime");
    expect(publicSurface).toHaveProperty("createBehavioralSignalPolicy");
    expect(publicSurface).not.toHaveProperty("BehavioralSignalTrackingEngine");
    expect(publicSurface).not.toHaveProperty("CortexBehavioralSignalSuite");
  });
});
