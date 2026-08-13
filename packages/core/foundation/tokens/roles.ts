export type TokenRole =
  | "surface.base"
  | "surface.elevated"
  | "surface.inverse"
  | "surface.overlay"
  | "content.primary"
  | "content.secondary"
  | "content.inverse"
  | "content.disabled"
  | "accent.default"
  | "accent.emphasis"
  | "accent.muted"
  | "border.subtle"
  | "border.strong"
  | "feedback.success"
  | "feedback.warning"
  | "feedback.danger"
  | "feedback.info"
  | "focus.ring"
  | "focus.offset"
  | "space.xs"
  | "space.sm"
  | "space.md"
  | "space.lg"
  | "space.xl"
  | "container.sm"
  | "container.md"
  | "container.lg"
  | "container.xl"
  | "radius.sm"
  | "radius.md"
  | "radius.lg"
  | "radius.full"
  | "shadow.sm"
  | "shadow.md"
  | "shadow.lg"
  | "z-index.base"
  | "z-index.dropdown"
  | "z-index.sticky"
  | "z-index.overlay"
  | "z-index.modal"
  | "z-index.toast"
  | "motion.duration.fast"
  | "motion.duration.base"
  | "motion.duration.slow"
  | "motion.duration.instant"
  | "motion.easing.standard"
  | "motion.easing.decelerate"
  | "motion.easing.accelerate"
  | "motion.easing.linear";

// NOTE: "opacity.*" is intentionally NOT a role category.
// Specification v0.3 marks the opacity category as DEFERRED.

const ROLE_TO_VAR: Record<TokenRole, string> = {
  "surface.base": "--surface-base",
  "surface.elevated": "--surface-elevated",
  "surface.inverse": "--surface-inverse",
  "surface.overlay": "--surface-overlay",
  "content.primary": "--content-primary",
  "content.secondary": "--content-secondary",
  "content.inverse": "--content-inverse",
  "content.disabled": "--content-disabled",
  "accent.default": "--accent-default",
  "accent.emphasis": "--accent-emphasis",
  "accent.muted": "--accent-muted",
  "border.subtle": "--border-subtle",
  "border.strong": "--border-strong",
  "feedback.success": "--feedback-success",
  "feedback.warning": "--feedback-warning",
  "feedback.danger": "--feedback-danger",
  "feedback.info": "--feedback-info",
  "focus.ring": "--focus-ring",
  "focus.offset": "--focus-offset",
  "space.xs": "--space-xs",
  "space.sm": "--space-sm",
  "space.md": "--space-md",
  "space.lg": "--space-lg",
  "space.xl": "--space-xl",
  "container.sm": "--container-sm",
  "container.md": "--container-md",
  "container.lg": "--container-lg",
  "container.xl": "--container-xl",
  "radius.sm": "--radius-sm",
  "radius.md": "--radius-md",
  "radius.lg": "--radius-lg",
  "radius.full": "--radius-full",
  "shadow.sm": "--shadow-sm",
  "shadow.md": "--shadow-md",
  "shadow.lg": "--shadow-lg",
  "z-index.base": "--z-index-base",
  "z-index.dropdown": "--z-index-dropdown",
  "z-index.sticky": "--z-index-sticky",
  "z-index.overlay": "--z-index-overlay",
  "z-index.modal": "--z-index-modal",
  "z-index.toast": "--z-index-toast",
  "motion.duration.fast": "--motion-duration-fast",
  "motion.duration.base": "--motion-duration-base",
  "motion.duration.slow": "--motion-duration-slow",
  "motion.duration.instant": "--motion-duration-instant",
  "motion.easing.standard": "--motion-easing-standard",
  "motion.easing.decelerate": "--motion-easing-decelerate",
  "motion.easing.accelerate": "--motion-easing-accelerate",
  "motion.easing.linear": "--motion-easing-linear"
};

export const tokenRoles = Object.keys(ROLE_TO_VAR) as TokenRole[];

/**
 * Returns the raw CSS custom property name for a role (e.g. "--surface-base").
 * Use when composing custom property declarations, not values.
 */
export function tokenName(role: TokenRole): string {
  return ROLE_TO_VAR[role];
}

/**
 * Returns a `var(--role)` reference for a role, ready to use as a CSS value.
 */
export function tokenVar(role: TokenRole): string {
  return `var(${ROLE_TO_VAR[role]})`;
}
