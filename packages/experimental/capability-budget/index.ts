/**
 * @status experimental
 *
 * NEXUS Capability Budget — formalized in V1.2.
 *
 * An Experience declares its budget BEFORE implementation, the same
 * discipline as "brand intent → art direction" from V1.1. This type
 * defines the shape only. It does NOT define numeric thresholds (KB,
 * FPS, Core Web Vitals targets, timings) — those would be invented
 * numbers with no real measurement behind them. Thresholds should be
 * derived from measuring a real Experience once one exists, not
 * decided in the abstract.
 *
 * Lives in packages/experimental, not packages/core: nothing in NEXUS
 * consumes this yet, and no build tooling enforces it. Promotion to
 * Core is a candidate for V2, gated on real evidence — see
 * docs/research/WHAT_V2_HAS_EARNED.md for the promotion criteria this
 * repo already uses for that kind of decision.
 */
export type CapabilityBudget = {
  motion: "none" | "subtle" | "expressive" | "cinematic";
  media: "none" | "static-image" | "optimized-photo" | "video" | "cinematic-media";
  js: "zero-client" | "minimal-interaction" | "rich-interaction";
  gpu: "none" | "css-only" | "webgl" | "webgpu";
  network: "ultra-light" | "standard" | "media-heavy";
  fonts: "system-only" | "single-webfont" | "variable-font-family";
  thirdParty: "none" | "essential-only" | "multiple";
};

/**
 * The budget every current app in this repo actually operates at,
 * confirmed by direct inspection (no client components, no images, no
 * third-party origins, system/generic font stacks only) — not asserted,
 * measured. Documented here as the one real data point this type has
 * behind it so far.
 */
export const OBSERVED_CURRENT_BUDGET: CapabilityBudget = {
  motion: "subtle",
  media: "none",
  js: "zero-client",
  gpu: "css-only",
  network: "ultra-light",
  fonts: "system-only",
  thirdParty: "none"
};
