import type { NexusTheme } from "@nexus/core/foundation/theme";

/**
 * Reference probe theme — Nexus Bot Studio.
 *
 * Art direction: structural, technical, precise. Deliberately avoids the
 * dark-mode-gradient-SaaS cliché — light cool-neutral surface, no
 * gradients, no blue/purple glow, no pill buttons. See EXPRESSIVENESS.md
 * "DESIGN INTENT".
 */
export const nexusBotTheme: NexusTheme = {
  "space.xs": "0.5rem",
  "space.sm": "0.75rem",
  "space.md": "1rem",
  "space.lg": "2rem",
  "space.xl": "3.5rem",

  "container.sm": "40rem",
  "container.md": "58rem",
  "container.lg": "78rem",
  "container.xl": "94rem",

  "focus.ring": "#12151a",
  "focus.offset": "2px",

  "motion.duration.instant": "0ms",
  "motion.duration.fast": "90ms",
  "motion.duration.base": "160ms",
  "motion.duration.slow": "240ms",

  "motion.easing.standard": "linear",
  "motion.easing.decelerate": "ease-out",
  "motion.easing.accelerate": "ease-in",
  "motion.easing.linear": "linear",

  "surface.base": "#f1f2f4",
  "surface.elevated": "#ffffff",
  "surface.inverse": "#12151a",
  "surface.overlay": "rgba(18, 21, 26, 0.5)",

  "content.primary": "#12151a",
  "content.secondary": "#54606e",
  "content.inverse": "#f1f2f4",
  "content.disabled": "#9aa3ac",

  "accent.default": "#1f6f63",
  "accent.emphasis": "#164f46",
  "accent.muted": "#bcd8d2",

  "border.subtle": "rgba(18, 21, 26, 0.12)",
  "border.strong": "rgba(18, 21, 26, 0.32)",

  "radius.sm": "0px",
  "radius.md": "0px",
  "radius.lg": "2px",
  "radius.full": "999px"
};
