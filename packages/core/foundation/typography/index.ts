export type TypographyRole =
  | "display"
  | "heading.1"
  | "heading.2"
  | "heading.3"
  | "heading.4"
  | "body.default"
  | "body.small"
  | "caption"
  | "mono";

export const typographyRoles: readonly TypographyRole[] = [
  "display",
  "heading.1",
  "heading.2",
  "heading.3",
  "heading.4",
  "body.default",
  "body.small",
  "caption",
  "mono"
] as const;

export type TypographyProperty =
  | "fontFamily"
  | "fontSize"
  | "lineHeight"
  | "fontWeight"
  | "letterSpacing";

function roleToSegment(role: TypographyRole): string {
  return role.replace(/\./g, "-");
}

function propertyToSegment(property: TypographyProperty): string {
  return property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * Returns a `var(--typography-<role>-<property>)` reference.
 * Core defines the contract only: no concrete font family, size,
 * weight, or identity is declared here.
 */
export function typographyVar(
  role: TypographyRole,
  property: TypographyProperty
): string {
  return `var(--typography-${roleToSegment(role)}-${propertyToSegment(property)})`;
}
