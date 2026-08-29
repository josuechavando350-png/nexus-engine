import { describe, expect, test } from "vitest";
import { createTerm, definePrimitive } from "@nexus/visual-algebra";
import { synthesizeTermCertified } from "@nexus/topology";
import { projectTopologyMeasurement } from "./topology.js";

describe("topology measurement integration", () => {
  test("projects certified topology with provenance and finite samples", () => {
    const term = createTerm({
      subject: "client/home",
      canvasBounds: { x: 0, y: 0, width: 100, height: 100 },
      primitives: [
        definePrimitive({ id: "a", kind: "rectangle", bounds: { x: 0, y: 0, width: 0, height: 0 } }),
        definePrimitive({ id: "b", kind: "rectangle", bounds: { x: 20, y: 0, width: 0, height: 0 } }),
      ],
    });
    const result = synthesizeTermCertified({
      planId: "measurement",
      term,
      constraints: [{ id: "connected", kind: "max_component_count", value: 1, severity: "required" }],
    });
    const projection = projectTopologyMeasurement(result);
    expect(projection.authority).toBe("NEXUS_TOPOLOGY_MEASUREMENT_V1");
    expect(projection.subject).toBe(term.subject);
    expect(projection.status).toBe("CERTIFIED");
    expect(projection.certificateDigest).toBe(result.certificate.certificateDigest);
    expect(projection.samples).toHaveLength(7);
    expect(projection.samples.every((sample) => Number.isFinite(sample.value))).toBe(true);
  });
});
