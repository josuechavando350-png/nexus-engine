import { createHash } from "node:crypto";
import type { ReferencePresentationPlan } from "./reference-presentation";

export interface PresentationSequencingArtifact {
  authority: "NEXUS_PRESENTATION_SEQUENCING_V1";
  css: string;
  digest: `sha256:${string}`;
  overlayDurationMs: number;
}

const sha256 = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function sequenceReferencePresentationAfterOverlay(input: {
  plan: ReferencePresentationPlan;
  overlayDurationMs: number;
}): PresentationSequencingArtifact {
  const delay = input.overlayDurationMs;
  if (!Number.isInteger(delay) || delay < 0 || delay > 5000) throw new Error("overlayDurationMs must be an integer within [0,5000]");
  if (!input.plan.heroMotion.enabled) throw new Error("presentation sequencing requires enabled hero motion");

  const duration = input.plan.heroMotion.durationMs;
  const glintOffset = Math.round(duration * 0.18);
  const taglineOffset = Math.round(duration * 0.32);
  const css = [
    `.nexusBrandMotionLogo{animation-delay:${delay}ms}`,
    `.nexusBrandMotionGlint{animation-delay:${delay + glintOffset}ms}`,
    `.nexusBrandMotionTagline{animation-delay:${delay + taglineOffset}ms}`,
    `@media(prefers-reduced-motion:reduce){.nexusBrandMotionLogo,.nexusBrandMotionGlint,.nexusBrandMotionTagline{animation-delay:0ms!important}}`,
  ].join("\n");

  return Object.freeze({
    authority: "NEXUS_PRESENTATION_SEQUENCING_V1",
    css,
    digest: sha256(css),
    overlayDurationMs: delay,
  });
}
