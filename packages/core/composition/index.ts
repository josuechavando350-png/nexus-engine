/**
 * @status core
 *
 * Structural layout primitives only.
 * No semantic marketing sections such as Hero, Features, or CTA.
 */

export type LayoutPrimitive =
  | "grid"
  | "container"
  | "stack"
  | "cluster"
  | "section-wrapper";

export const layoutPrimitives = [
  "grid",
  "container",
  "stack",
  "cluster",
  "section-wrapper"
] as const;
