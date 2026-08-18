import { describe, expect, it } from "vitest";
import { deriveViewportContainmentRepair } from "./viewport-containment";

describe("viewport containment repair", () => {
  it("emits only neutral horizontal containment from measured evidence", () => {
    const repair = deriveViewportContainmentRepair({
      viewport: "mobile-390",
      horizontalOverflowPx: 7.0625,
      evidenceIds: ["capture:mobile-390:scroll-width", "finding:viewport-torture:overflow"],
    });
    expect(repair.authority).toBe("NEXUS_VIEWPORT_CONTAINMENT_REPAIR_V1");
    expect(repair.viewport).toBe("mobile-390");
    expect(repair.horizontalOverflowPx).toBe(7.063);
    expect(repair.css).toBe("html,body{overflow-x:clip}");
    expect(repair.evidenceIds).toEqual(["capture:mobile-390:scroll-width", "finding:viewport-torture:overflow"]);
    expect(repair.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("fails closed without positive measured overflow", () => {
    expect(() => deriveViewportContainmentRepair({ viewport: "mobile-390", horizontalOverflowPx: 0, evidenceIds: ["capture:x"] })).toThrow(/positive measured horizontal overflow/);
  });

  it("fails closed without traceable evidence", () => {
    expect(() => deriveViewportContainmentRepair({ viewport: "mobile-390", horizontalOverflowPx: 4, evidenceIds: [] })).toThrow(/traceable evidence ids/);
  });

  it("refuses duplicate or empty evidence identifiers", () => {
    expect(() => deriveViewportContainmentRepair({ viewport: "mobile-390", horizontalOverflowPx: 4, evidenceIds: ["capture:x", "capture:x"] })).toThrow(/unique non-empty/);
    expect(() => deriveViewportContainmentRepair({ viewport: "mobile-390", horizontalOverflowPx: 4, evidenceIds: [""] })).toThrow(/traceable evidence ids/);
  });
});
