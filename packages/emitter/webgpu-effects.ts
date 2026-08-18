import type { ExperienceDNA } from "@nexus/experience/dna";

export type WebGpuEffectKind = "NONE" | "SUBTLE_FIELD" | "SPATIAL_FLOW" | "CINEMATIC_FIELD";

export interface WebGpuCapabilitySnapshot {
  webGpuAvailable: boolean;
  reducedMotion: boolean;
  lowPowerMode?: boolean;
  deviceMemoryGb?: number;
}

export interface DnaWebGpuPlan {
  authority: "NEXUS_DNA_WEBGPU_POLICY_V1";
  effect: WebGpuEffectKind;
  enabled: boolean;
  intensity: number;
  maxFps: 30 | 60;
  interactive: boolean;
  fallback: "STATIC_CSS";
  reasons: readonly string[];
}

export interface WebGpuEffectAdapter {
  start(plan: DnaWebGpuPlan): Promise<{ runtimeId: string }>;
  stop(runtimeId: string): Promise<void>;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function deriveWebGpuEffectPlan(
  dna: ExperienceDNA,
  capability: WebGpuCapabilitySnapshot,
): DnaWebGpuPlan {
  const reasons: string[] = [];
  const requestedIntensity = clamp01((dna.motion.intensity.value * 0.45) + (dna.interaction.spatiality.value * 0.25) + (dna.cinematicity.value * 0.3));

  if (!capability.webGpuAvailable) reasons.push("WebGPU is unavailable; static CSS fallback is mandatory.");
  if (capability.reducedMotion) reasons.push("prefers-reduced-motion disables non-essential GPU motion.");
  if (capability.lowPowerMode) reasons.push("Low-power mode disables non-essential GPU effects.");
  if (capability.deviceMemoryGb !== undefined && capability.deviceMemoryGb < 4) reasons.push("Device memory is below the 4GB effect budget.");
  if (dna.motion.intensity.value < 0.2 && dna.cinematicity.value < 0.3) reasons.push("ExperienceDNA explicitly requests restrained motion/cinematicity.");

  const enabled = reasons.length === 0;
  let effect: WebGpuEffectKind = "NONE";
  if (enabled) {
    if (dna.cinematicity.value >= 0.75 && dna.motion.intensity.value >= 0.55) effect = "CINEMATIC_FIELD";
    else if (dna.interaction.spatiality.value >= 0.65) effect = "SPATIAL_FLOW";
    else effect = "SUBTLE_FIELD";
  }

  const maxFps: 30 | 60 = capability.deviceMemoryGb !== undefined && capability.deviceMemoryGb < 8 ? 30 : 60;
  const intensity = enabled ? Math.min(requestedIntensity, maxFps === 30 ? 0.65 : 0.9) : 0;
  const interactive = enabled && dna.interaction.directness.value >= 0.55 && dna.interaction.spatiality.value >= 0.55;

  return Object.freeze({
    authority: "NEXUS_DNA_WEBGPU_POLICY_V1",
    effect,
    enabled,
    intensity,
    maxFps,
    interactive,
    fallback: "STATIC_CSS",
    reasons: Object.freeze(reasons),
  });
}

export class DnaWebGpuController {
  #runtimeId: string | undefined;

  constructor(private readonly adapter: WebGpuEffectAdapter) {}

  async apply(plan: DnaWebGpuPlan): Promise<{ status: "ACTIVE" | "FALLBACK"; runtimeId?: string }> {
    if (this.#runtimeId) {
      await this.adapter.stop(this.#runtimeId);
      this.#runtimeId = undefined;
    }

    if (!plan.enabled || plan.effect === "NONE") return Object.freeze({ status: "FALLBACK" });
    const started = await this.adapter.start(plan);
    if (!started.runtimeId.trim()) throw new Error("WebGPU adapter returned an empty runtimeId");
    this.#runtimeId = started.runtimeId;
    return Object.freeze({ status: "ACTIVE", runtimeId: started.runtimeId });
  }

  async dispose(): Promise<void> {
    if (!this.#runtimeId) return;
    const runtimeId = this.#runtimeId;
    this.#runtimeId = undefined;
    await this.adapter.stop(runtimeId);
  }
}
