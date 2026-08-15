import { describe, expect, it } from "vitest";
import { DeterministicGPUPlanner, GPUError, type ShaderPipelineRequest } from "../gpu";

const scope = Object.freeze({ tenantId: "tenant-a", brandId: "brand-a" });
const digest = `sha256:${"a".repeat(64)}` as const;
const request: ShaderPipelineRequest = Object.freeze({
  pipelineId: "pipeline-1",
  scope,
  shaders: Object.freeze([
    Object.freeze({ shaderId: "fragment-main", stage: "fragment", sourceDigest: digest, entryPoint: "main", requiredFeatures: Object.freeze(["texture-sampling"]), estimatedCost: 3 }),
    Object.freeze({ shaderId: "vertex-main", stage: "vertex", sourceDigest: digest, entryPoint: "main", requiredFeatures: Object.freeze([]), estimatedCost: 1 })
  ]),
  capabilities: Object.freeze([
    Object.freeze({ backend: "webgl2", features: Object.freeze(["texture-sampling"]), maxTextureDimension2D: 8192, maxStorageBufferBytes: 0, score: 0.7 }),
    Object.freeze({ backend: "webgpu", features: Object.freeze(["texture-sampling", "storage-buffer"]), maxTextureDimension2D: 16384, maxStorageBufferBytes: 134217728, score: 0.9 })
  ]),
  budget: Object.freeze({ maxFrameTimeMs: 16.67, maxEstimatedCost: 10, preferredQuality: "ultra" })
});

const planner = new DeterministicGPUPlanner();

describe("DeterministicGPUPlanner", () => {
  it("selects the highest-scored compatible backend deterministically", () => {
    const plan = planner.plan(request, scope);
    expect(plan.backend).toBe("webgpu");
    expect(plan.shaderIds).toEqual(["fragment-main", "vertex-main"]);
    expect(plan.estimatedCost).toBe(4);
  });

  it("is invariant to shader and capability ordering", () => {
    const first = planner.plan(request, scope);
    const second = planner.plan({ ...request, shaders: [...request.shaders].reverse(), capabilities: [...request.capabilities].reverse() }, scope);
    expect(second).toEqual(first);
  });

  it("uses backend preference as deterministic tie-breaker", () => {
    const equal = request.capabilities.map((capability) => ({ ...capability, score: 0.8 }));
    expect(planner.plan({ ...request, capabilities: equal }, scope).backend).toBe("webgpu");
  });

  it("rejects cross-scope planning", () => {
    expect(() => planner.plan(request, { tenantId: "tenant-b", brandId: "brand-a" })).toThrowError(GPUError);
    expect(() => planner.plan(request, { tenantId: "tenant-a", brandId: "brand-b" })).toThrowError(GPUError);
  });

  it("rejects unsupported feature requirements", () => {
    const shaders = [{ ...request.shaders[0]!, requiredFeatures: ["missing-feature"] }];
    expect(() => planner.plan({ ...request, shaders }, scope)).toThrowError(GPUError);
  });

  it("rejects over-budget pipelines", () => {
    expect(() => planner.plan({ ...request, budget: { ...request.budget, maxEstimatedCost: 2 } }, scope)).toThrowError(GPUError);
  });

  it("rejects invalid numbers and malformed digests", () => {
    expect(() => planner.plan({ ...request, budget: { ...request.budget, maxFrameTimeMs: Number.NaN } }, scope)).toThrowError(GPUError);
    const shaders = [{ ...request.shaders[0]!, sourceDigest: "sha256:nope" as `sha256:${string}` }];
    expect(() => planner.plan({ ...request, shaders }, scope)).toThrowError(GPUError);
  });

  it("does not expose browser or vendor objects in the public plan", () => {
    expect(Object.keys(planner.plan(request, scope)).sort()).toEqual(["backend", "estimatedCost", "pipelineId", "quality", "rationale", "scope", "shaderIds"]);
  });
});
