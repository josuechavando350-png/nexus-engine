import { assertUiAgnostic } from "./shared";

export type PremiumCapabilityId =
  | "cinematic-video"
  | "scroll-choreography"
  | "view-transitions"
  | "webgl"
  | "webgpu"
  | "shaders"
  | "spatial-interaction"
  | "canvas"
  | "three-dimensional"
  | "high-end-typography"
  | "responsive-art-direction";

export type PremiumCapabilityDefinition = {
  id: PremiumCapabilityId;
  purpose: string;
  cost: {
    motion: "low" | "medium" | "high";
    network: "low" | "medium" | "high";
    gpu: "none" | "moderate" | "high";
    clientJs: "none" | "moderate" | "high";
  };
  signalRequirements?: {
    hover?: boolean;
    precisePointer?: boolean;
    reducedMotionMustBeFalse?: boolean;
    reducedDataMustBeFalse?: boolean;
  };
  fallbackStrategy: string;
};

export function definePremiumCapability(input: PremiumCapabilityDefinition): PremiumCapabilityDefinition {
  assertUiAgnostic(input, `PremiumCapability(${input.id})`);
  return Object.freeze(input);
}

export const PREMIUM_CAPABILITIES: Readonly<Record<PremiumCapabilityId, PremiumCapabilityDefinition>> = Object.freeze({
  "cinematic-video": definePremiumCapability({ id: "cinematic-video", purpose: "Carry atmosphere or evidence through motion media.", cost: { motion: "medium", network: "high", gpu: "moderate", clientJs: "none" }, signalRequirements: { reducedMotionMustBeFalse: true, reducedDataMustBeFalse: true }, fallbackStrategy: "Poster/still sequence preserving narrative meaning." }),
  "scroll-choreography": definePremiumCapability({ id: "scroll-choreography", purpose: "Coordinate narrative state with viewport progression.", cost: { motion: "high", network: "low", gpu: "moderate", clientJs: "moderate" }, signalRequirements: { reducedMotionMustBeFalse: true }, fallbackStrategy: "Linear document flow with the same content order." }),
  "view-transitions": definePremiumCapability({ id: "view-transitions", purpose: "Preserve spatial continuity across state/navigation changes.", cost: { motion: "medium", network: "low", gpu: "moderate", clientJs: "moderate" }, signalRequirements: { reducedMotionMustBeFalse: true }, fallbackStrategy: "Instant navigation/state change." }),
  webgl: definePremiumCapability({ id: "webgl", purpose: "Render GPU-assisted visual systems when they materially support the art direction.", cost: { motion: "medium", network: "medium", gpu: "high", clientJs: "high" }, signalRequirements: { reducedDataMustBeFalse: true }, fallbackStrategy: "CSS/static-media representation preserving hierarchy." }),
  webgpu: definePremiumCapability({ id: "webgpu", purpose: "Use modern GPU compute/rendering for justified high-end experiences.", cost: { motion: "medium", network: "medium", gpu: "high", clientJs: "high" }, signalRequirements: { reducedDataMustBeFalse: true }, fallbackStrategy: "WebGL or static/CSS fallback selected by the Experience." }),
  shaders: definePremiumCapability({ id: "shaders", purpose: "Create art-directed image/geometry treatment not achievable economically in static assets.", cost: { motion: "high", network: "medium", gpu: "high", clientJs: "high" }, signalRequirements: { reducedMotionMustBeFalse: true, reducedDataMustBeFalse: true }, fallbackStrategy: "Pre-rendered or CSS visual treatment." }),
  "spatial-interaction": definePremiumCapability({ id: "spatial-interaction", purpose: "Use pointer/hover space as a meaningful interaction dimension.", cost: { motion: "high", network: "low", gpu: "moderate", clientJs: "high" }, signalRequirements: { hover: true, precisePointer: true, reducedMotionMustBeFalse: true }, fallbackStrategy: "Direct tap/click interaction with equivalent information access." }),
  canvas: definePremiumCapability({ id: "canvas", purpose: "Render bespoke visual systems with deterministic control.", cost: { motion: "medium", network: "low", gpu: "moderate", clientJs: "high" }, fallbackStrategy: "Semantic DOM/static representation." }),
  "three-dimensional": definePremiumCapability({ id: "three-dimensional", purpose: "Represent objects/spaces where 3D materially improves understanding or brand expression.", cost: { motion: "high", network: "high", gpu: "high", clientJs: "high" }, signalRequirements: { reducedMotionMustBeFalse: true, reducedDataMustBeFalse: true }, fallbackStrategy: "Optimized image sequence or still views." }),
  "high-end-typography": definePremiumCapability({ id: "high-end-typography", purpose: "Use advanced type features and responsive optical control as part of art direction.", cost: { motion: "low", network: "medium", gpu: "none", clientJs: "none" }, fallbackStrategy: "System/fallback font preserving hierarchy and metrics as closely as practical." }),
  "responsive-art-direction": definePremiumCapability({ id: "responsive-art-direction", purpose: "Change crop, composition, or media treatment per viewport without changing identity.", cost: { motion: "low", network: "medium", gpu: "none", clientJs: "none" }, fallbackStrategy: "Single optimized source with safe crop and semantic content order." })
});
