import type { TokenRole } from "@nexus/core/foundation/tokens";
import type { NexusTheme } from "@nexus/core/foundation/theme";

/**
 * Token role classification for `_experience-seed`.
 *
 * This is a seed-level convenience, NOT a Core contract. Core's `TokenRole`
 * type has no metadata about which roles are required, optional, derived,
 * or experience-specific — that classification is proposed here as a
 * candidate for Core, documented but not implemented there (see
 * docs/architecture/VISUAL_ARCHITECTURE.md, "Core API candidates").
 *
 * REQUIRED — Core primitives read these directly (Box/Stack/Cluster/Grid
 * default gaps, Container default max-width, a11y focus ring, motion
 * helpers). Leaving them unset does not throw, it silently degrades:
 * invalid `var()` references are dropped by the browser, so gaps collapse
 * to zero, containers become unbounded, and — critically — the focus
 * ring can become invisible. None of these values carry brand identity:
 * they are technical rhythm (spacing scale, container widths, motion
 * timing) or a minimum-contrast a11y default, not art direction.
 *
 * OPTIONAL — declared as roles, never read by any current Core primitive.
 * Only matter once an app builds something that uses them (alerts,
 * overlays, elevated surfaces). Safe to leave unset in the seed.
 *
 * EXPERIENCE-SPECIFIC — this is where brand identity belongs. The seed
 * MUST NOT set these. An Experience is expected to set them before the
 * app looks like anything intentional.
 *
 * DERIVED — proposed category, currently empty. Nothing in Core today
 * computes one token from another (e.g. accent.emphasis from
 * accent.default via color-mix). Flagged as a future direction, not
 * implemented anywhere.
 */
export const REQUIRED_TOKEN_ROLES: readonly TokenRole[] = [
  "space.xs",
  "space.sm",
  "space.md",
  "space.lg",
  "space.xl",
  "container.sm",
  "container.md",
  "container.lg",
  "container.xl",
  "focus.ring",
  "focus.offset",
  "motion.duration.instant",
  "motion.duration.fast",
  "motion.duration.base",
  "motion.duration.slow",
  "motion.easing.standard",
  "motion.easing.decelerate",
  "motion.easing.accelerate",
  "motion.easing.linear"
];

export const OPTIONAL_TOKEN_ROLES: readonly TokenRole[] = [
  "feedback.success",
  "feedback.warning",
  "feedback.danger",
  "feedback.info",
  "shadow.sm",
  "shadow.md",
  "shadow.lg",
  "z-index.base",
  "z-index.dropdown",
  "z-index.sticky",
  "z-index.overlay",
  "z-index.modal",
  "z-index.toast"
];

export const EXPERIENCE_SPECIFIC_TOKEN_ROLES: readonly TokenRole[] = [
  "surface.base",
  "surface.elevated",
  "surface.inverse",
  "surface.overlay",
  "content.primary",
  "content.secondary",
  "content.inverse",
  "content.disabled",
  "accent.default",
  "accent.emphasis",
  "accent.muted",
  "border.subtle",
  "border.strong",
  "radius.sm",
  "radius.md",
  "radius.lg",
  "radius.full"
];

/** Currently empty on purpose. See module doc above. */
export const DERIVED_TOKEN_ROLES: readonly TokenRole[] = [];

/**
 * Fails loudly and specifically instead of letting Core silently degrade.
 * Only checks REQUIRED roles. Never checks EXPERIENCE_SPECIFIC roles —
 * the seed must not be able to define what "complete" art direction is.
 */
export function assertRequiredTheme(theme: NexusTheme): void {
  const missing = REQUIRED_TOKEN_ROLES.filter((role) => theme[role] === undefined);

  if (missing.length > 0) {
    throw new Error(
      `NEXUS experience-seed: theme is missing required token role(s): ${missing.join(", ")}. ` +
        "These roles are read directly by Core primitives (layout gaps, container widths, " +
        "focus ring, motion timing) and have no safe silent fallback. " +
        "This is not about art direction — fill these before anything else."
    );
  }

  const experienceValuesSet = EXPERIENCE_SPECIFIC_TOKEN_ROLES.filter(
    (role) => theme[role] !== undefined
  );

  if (experienceValuesSet.length > 0) {
    // Intentionally not throwing: an Experience built FROM the seed is
    // expected to add these. This only matters if the seed itself is
    // consumed unmodified — flagged here as a warning signal for that
    // case, not enforced as a hard boundary (see VISUAL_ARCHITECTURE.md).
    console.warn(
      "NEXUS experience-seed: theme sets experience-specific role(s) " +
        `(${experienceValuesSet.join(", ")}) directly in the seed. ` +
        "Confirm this is an actual Experience and not the seed being shipped unmodified."
    );
  }
}
