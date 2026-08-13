import type { CSSProperties } from "react";
import type { TokenRole } from "../../foundation/tokens";
import { tokenVar } from "../../foundation/tokens";

export type SpaceRole = Extract<TokenRole, `space.${string}`>;
export type ContainerRole = Extract<TokenRole, `container.${string}`>;

export function spaceValue(role: SpaceRole | undefined): string | undefined {
  return role ? tokenVar(role) : undefined;
}

export function mergeStyles(
  base: CSSProperties,
  override: CSSProperties | undefined
): CSSProperties {
  return { ...base, ...override };
}
