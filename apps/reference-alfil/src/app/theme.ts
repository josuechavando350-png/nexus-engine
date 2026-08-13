import type { NexusTheme } from "@nexus/core/foundation/theme";

/**
 * Reference probe theme — Alfil.
 *
 * Art direction: editorial, luxury, air, delicacy. Deliberately avoids the
 * serif+gold+black+rounded-corners cliché — no gold, no radius. See
 * EXPRESSIVENESS.md "DESIGN INTENT".
 */
export const alfilTheme: NexusTheme = {
  "space.xs": "0.5rem",
  "space.sm": "1rem",
  "space.md": "1.75rem",
  "space.lg": "3.5rem",
  "space.xl": "6.5rem",

  "container.sm": "36rem",
  "container.md": "52rem",
  "container.lg": "70rem",
  "container.xl": "84rem",

  "focus.ring": "#1f1d1c",
  "focus.offset": "3px",

  "motion.duration.instant": "0ms",
  "motion.duration.fast": "180ms",
  "motion.duration.base": "420ms",
  "motion.duration.slow": "720ms",

  "motion.easing.standard": "ease",
  "motion.easing.decelerate": "cubic-bezier(0.16, 1, 0.3, 1)",
  "motion.easing.accelerate": "cubic-bezier(0.7, 0, 0.84, 0)",
  "motion.easing.linear": "linear",

  "surface.base": "#faf8f5",
  "surface.elevated": "#ffffff",
  "surface.inverse": "#1f1d1c",
  "surface.overlay": "rgba(31, 29, 28, 0.4)",

  "content.primary": "#1f1d1c",
  "content.secondary": "#6b635c",
  "content.inverse": "#faf8f5",
  "content.disabled": "#a39a91",

  "accent.default": "#8a6b5c",
  "accent.emphasis": "#6d5044",
  "accent.muted": "#c9bdb3",

  "border.subtle": "rgba(31, 29, 28, 0.08)",
  "border.strong": "rgba(31, 29, 28, 0.24)",

  "radius.sm": "0px",
  "radius.md": "0px",
  "radius.lg": "0px",
  "radius.full": "999px"
};
