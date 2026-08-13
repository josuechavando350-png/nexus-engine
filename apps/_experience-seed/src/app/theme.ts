import type { NexusTheme } from "@nexus/core/foundation/theme";

/**
 * Deliberately incomplete. Maps ONLY the REQUIRED token roles
 * (see theme-contract.ts) — technical rhythm and a minimum a11y default,
 * never brand identity.
 *
 * `focus.ring` uses a neutral near-black rather than reusing the blue
 * that `_template-client` shipped as its accent — the point of this file
 * is to not hand every new Experience the same "safe" color by default.
 * An Experience is expected to override this once it sets accent.default.
 *
 * surface.*, content.*, accent.*, border.*, radius.* are intentionally
 * ABSENT. Do not add them here. Do not add fallback values in CSS either
 * (see reset.css) — an unthemed seed should look visibly unfinished, not
 * quietly presentable.
 */
export const experienceSeedTheme: NexusTheme = {
  "space.xs": "0.5rem",
  "space.sm": "0.75rem",
  "space.md": "1rem",
  "space.lg": "1.5rem",
  "space.xl": "2.5rem",

  "container.sm": "40rem",
  "container.md": "56rem",
  "container.lg": "72rem",
  "container.xl": "88rem",

  "focus.ring": "#111111",
  "focus.offset": "4px",

  "motion.duration.instant": "0ms",
  "motion.duration.fast": "120ms",
  "motion.duration.base": "240ms",
  "motion.duration.slow": "420ms",

  "motion.easing.standard": "ease",
  "motion.easing.decelerate": "ease-out",
  "motion.easing.accelerate": "ease-in",
  "motion.easing.linear": "linear"
};
