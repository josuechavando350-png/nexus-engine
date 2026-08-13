import type { NexusTheme } from "@nexus/core/foundation/theme";

/**
 * Reference probe theme — Mesón del 5.
 *
 * Art direction: material, warm, photographic, tactile. Deliberately NOT
 * the productive site's black+orange+pill+rounded-card combination — see
 * EXPRESSIVENESS.md "DESIGN INTENT".
 */
export const mesonTheme: NexusTheme = {
  "space.xs": "0.5rem",
  "space.sm": "0.75rem",
  "space.md": "1.25rem",
  "space.lg": "2.25rem",
  "space.xl": "4rem",

  "container.sm": "38rem",
  "container.md": "54rem",
  "container.lg": "76rem",
  "container.xl": "92rem",

  "focus.ring": "#f4ece1",
  "focus.offset": "3px",

  "motion.duration.instant": "0ms",
  "motion.duration.fast": "140ms",
  "motion.duration.base": "260ms",
  "motion.duration.slow": "480ms",

  "motion.easing.standard": "cubic-bezier(0.4, 0, 0.2, 1)",
  "motion.easing.decelerate": "cubic-bezier(0, 0, 0.2, 1)",
  "motion.easing.accelerate": "cubic-bezier(0.4, 0, 1, 1)",
  "motion.easing.linear": "linear",

  "surface.base": "#211a16",
  "surface.elevated": "#2b221c",
  "surface.inverse": "#f4ece1",
  "surface.overlay": "rgba(15, 10, 7, 0.55)",

  "content.primary": "#f4ece1",
  "content.secondary": "#c9b8a4",
  "content.inverse": "#211a16",
  "content.disabled": "#7d6f60",

  "accent.default": "#b1502c",
  "accent.emphasis": "#d9702f",
  "accent.muted": "#7a4128",

  "border.subtle": "rgba(244, 236, 225, 0.14)",
  "border.strong": "rgba(244, 236, 225, 0.34)",

  "radius.sm": "0px",
  "radius.md": "2px",
  "radius.lg": "3px",
  "radius.full": "999px"
};
