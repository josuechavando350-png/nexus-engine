import { tokenVar } from "../foundation/tokens";

export function isKeyboardActivation(
  event: KeyboardEvent,
  keys: readonly string[] = ["Enter", " "]
): boolean {
  return keys.includes(event.key);
}

export function getAriaLabel(
  label: string | undefined,
  fallback: string
): string {
  return label?.trim() || fallback;
}

/** Selector for browsers that support native focus-visible matching. */
export const FOCUS_VISIBLE_SELECTOR = ":focus-visible";

/**
 * Returns a role-driven focus ring style declaration.
 * Values come from Foundation tokens, never hardcoded colors.
 */
export function focusRingDeclaration(): Record<string, string> {
  return {
    outline: `2px solid ${tokenVar("focus.ring")}`,
    outlineOffset: tokenVar("focus.offset")
  };
}

/** Class name applied to visually-hidden, screen-reader-only content. */
export const SR_ONLY_CLASS = "nexus-sr-only";

/** CSS block implementing the visually-hidden pattern for SR_ONLY_CLASS. */
export const SR_ONLY_CSS = `.${SR_ONLY_CLASS} {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}`;

export type LiveRegionProps = {
  "aria-live": "polite" | "assertive";
  "aria-atomic": "true";
};

/** ARIA attributes for a non-interrupting (polite) live region. */
export function politeLiveRegion(): LiveRegionProps {
  return { "aria-live": "polite", "aria-atomic": "true" };
}

/** ARIA attributes for an interrupting (assertive) live region. */
export function assertiveLiveRegion(): LiveRegionProps {
  return { "aria-live": "assertive", "aria-atomic": "true" };
}

/** Media query matching the user's reduced-motion preference. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** CSS block neutralizing animation/transition under reduced motion. */
export const REDUCED_MOTION_CSS = `@media ${REDUCED_MOTION_QUERY} {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}`;

/**
 * SSR-safe check for the user's reduced-motion preference.
 * Returns false when there is no window/matchMedia (server render).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export type SkipLinkProps = {
  href: string;
  className: string;
};

/** Class name applied to the skip-link element. */
export const SKIP_LINK_CLASS = "nexus-skip-link";

/**
 * CSS block implementing skip-link visual behavior for SKIP_LINK_CLASS.
 *
 * Uses `position: fixed` rather than `absolute` — standardized here after
 * observing 4 independent hand-written copies of this exact rule (in
 * `_experience-seed` and 3 experience probes during NEXUS V1.1) all
 * converge on `fixed` independently, which keeps the link reachable
 * regardless of scroll position. `surface.base`/`content.primary` are
 * Experience-specific roles — this only renders with color once an
 * Experience themes those roles; Core does not decide what they are.
 */
export const SKIP_LINK_CSS = `.${SKIP_LINK_CLASS} {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 9999;
  padding: ${tokenVar("space.md")};
  background: ${tokenVar("surface.base")};
  color: ${tokenVar("content.primary")};
  transform: translateY(-120%);
}

.${SKIP_LINK_CLASS}:focus-visible {
  transform: translateY(0);
}`;

/**
 * Global CSS rule for the same focus ring contract as focusRingDeclaration(),
 * for consumers that need a stylesheet rule rather than an inline style
 * object (e.g. a global CSS import instead of per-element styling).
 */
export const FOCUS_VISIBLE_CSS = `${FOCUS_VISIBLE_SELECTOR} {
  outline: 2px solid ${tokenVar("focus.ring")};
  outline-offset: ${tokenVar("focus.offset")};
}`;

/**
 * Props contract for a "skip to content" link.
 * Defaults to the conventional #main-content anchor.
 */
export function skipLinkProps(targetId: string = "main-content"): SkipLinkProps {
  return {
    href: `#${targetId}`,
    className: SKIP_LINK_CLASS
  };
}

/* -------------------------------------------------------------------------
 * CAPABILITY SIGNALS (NEXUS Adaptive Luxury — V1.2)
 *
 * Only signals backed by real, standardized media queries. Deliberately
 * excludes navigator.deviceMemory, navigator.connection, and any other
 * unreliable hardware/network inference — those are NOT capability
 * signals NEXUS supports, by design, not by oversight.
 * ---------------------------------------------------------------------- */

/** Media query for coarse (touch-like) pointers. */
export const POINTER_COARSE_QUERY = "(pointer: coarse)";

/** Media query for fine (mouse-like) pointers. */
export const POINTER_FINE_QUERY = "(pointer: fine)";

/** Media query for devices with no hover capability. */
export const HOVER_NONE_QUERY = "(hover: none)";

/** Media query for devices that support hover. */
export const HOVER_HOVER_QUERY = "(hover: hover)";

/**
 * Media query for the user's reduced-data preference.
 * Support is real but not universal (primarily Chromium today) — treat
 * this as a progressive enhancement signal, never as the sole gate for
 * critical content.
 */
export const REDUCED_DATA_QUERY = "(prefers-reduced-data: reduce)";

/** SSR-safe check for coarse-pointer capability. False without window. */
export function hasCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(POINTER_COARSE_QUERY).matches;
}

/** SSR-safe check for hover capability. False without window. */
export function hasHoverCapability(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(HOVER_HOVER_QUERY).matches;
}
