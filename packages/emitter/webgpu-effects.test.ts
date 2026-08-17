import { describe, expect, it, vi } from "vitest";
import { defineExperienceDNA, direction, intent, type ExperienceDNA } from "@nexus/experience/dna";
import { DnaWebGpuController, deriveWebGpuEffectPlan, type WebGpuEffectAdapter } from "./webgpu-effects";

function dna(values: { motion?: number; cinematicity?: number; spatiality?: number; directness?: number } = {}): ExperienceDNA {
  const because = "Project evidence requires this direction.";
  return defineExperienceDNA({
    version: 2,
    subject: "webgpu-policy-fixture",
    principles: ["GPU effects are non-essential enhancement only"],
    artDirectionVocabulary: ["spatial"],
    composition: { asymmetry: intent(0.6, because), gridDiscipline: intent(0.5, because), overlap: intent(0.5, because), continuity: intent(0.7, because), dominantFlow: direction("vertical", because) },
    density: { information: intent(0.5, because), whitespace: intent(0.6, because), compression: intent(0.3, because) },
    geometry: { angularity: intent(0.4, because), regularity: intent(0.4, because), boundaryVisibility: intent(0.3, because), dominantShape: direction("field", because) },
    typography: { scaleContrast: intent(0.7, because), hierarchyRigidity: intent(0.5, because), expressiveType: intent(0.6, because), voice: direction("editorial", because) },
    media: { dominance: intent(0.6, because), continuity: intent(0.7, because), documentaryVsAbstract: intent(0.4, because), role: direction("supporting", because) },
    navigation: { persistence: intent(0.4, because), visibility: intent(0.7, because), topology: direction("contextual", because) },
    interaction: { discoverability: intent(0.7, because), directness: intent(values.directness ?? 0.7, because), spatiality: intent(values.spatiality ?? 0.8, because), language: direction("spatial response", because) },
    cta: { prominence: intent(0.6, because), repetition: intent(0.2, because), grammar: direction("single action", because) },
    motion: { intensity: intent(values.motion ?? 0.7, because), continuity: intent(0.8, because), choreography: direction("continuous", because) },
    editoriality: intent(0.7, because), cinematicity: intent(values.cinematicity ?? 0.8, because), ornamentation: intent(0.3, because),
  });
}

describe("DNA WebGPU policy", () => {
  it("enables a cinematic field only when DNA and device capability both permit it", () => {
    const plan = deriveWebGpuEffectPlan(dna(), { webGpuAvailable: true, reducedMotion: false, deviceMemoryGb: 16 });
    expect(plan).toMatchObject({ enabled: true, effect: "CINEMATIC_FIELD", maxFps: 60, interactive: true, fallback: "STATIC_CSS" });
    expect(plan.intensity).toBeGreaterThan(0);
  });

  it("fails safely to static CSS for reduced motion, low power, unavailable WebGPU or low-memory devices", () => {
    for (const capability of [
      { webGpuAvailable: false, reducedMotion: false },
      { webGpuAvailable: true, reducedMotion: true },
      { webGpuAvailable: true, reducedMotion: false, lowPowerMode: true },
      { webGpuAvailable: true, reducedMotion: false, deviceMemoryGb: 2 },
    ]) {
      const plan = deriveWebGpuEffectPlan(dna(), capability);
      expect(plan.enabled).toBe(false);
      expect(plan.effect).toBe("NONE");
      expect(plan.intensity).toBe(0);
      expect(plan.reasons.length).toBeGreaterThan(0);
    }
  });

  it("honors restrained DNA even on capable hardware", () => {
    const plan = deriveWebGpuEffectPlan(dna({ motion: 0.1, cinematicity: 0.2, spatiality: 0.3 }), { webGpuAvailable: true, reducedMotion: false, deviceMemoryGb: 16 });
    expect(plan.enabled).toBe(false);
    expect(plan.reasons.join(" ")).toMatch(/restrained motion/i);
  });

  it("stops the previous GPU runtime before switching plans and never starts an adapter in fallback mode", async () => {
    const start = vi.fn(async () => ({ runtimeId: "gpu-runtime-1" }));
    const stop = vi.fn(async () => undefined);
    const adapter: WebGpuEffectAdapter = { start, stop };
    const controller = new DnaWebGpuController(adapter);

    const active = deriveWebGpuEffectPlan(dna(), { webGpuAvailable: true, reducedMotion: false, deviceMemoryGb: 16 });
    await expect(controller.apply(active)).resolves.toEqual({ status: "ACTIVE", runtimeId: "gpu-runtime-1" });

    const fallback = deriveWebGpuEffectPlan(dna(), { webGpuAvailable: true, reducedMotion: true, deviceMemoryGb: 16 });
    await expect(controller.apply(fallback)).resolves.toEqual({ status: "FALLBACK" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith("gpu-runtime-1");
  });
});
