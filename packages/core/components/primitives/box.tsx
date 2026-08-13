import type {
  CSSProperties,
  ElementType,
  HTMLAttributes,
  ReactNode
} from "react";
import { createElement } from "react";
import type { SpaceRole } from "./shared";
import { mergeStyles, spaceValue } from "./shared";

export type BoxProps = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  as?: ElementType;
  children?: ReactNode;
  padding?: SpaceRole;
  paddingBlock?: SpaceRole;
  paddingInline?: SpaceRole;
  margin?: SpaceRole;
  style?: CSSProperties;
};

/**
 * @status core
 * Brand-agnostic structural wrapper. Spacing can only reference Foundation roles.
 */
export function Box({
  as: Component = "div",
  children,
  padding,
  paddingBlock,
  paddingInline,
  margin,
  style,
  ...rest
}: BoxProps) {
  const structuralStyle: CSSProperties = {
    padding: spaceValue(padding),
    paddingBlock: spaceValue(paddingBlock),
    paddingInline: spaceValue(paddingInline),
    margin: spaceValue(margin)
  };

  return createElement(
    Component,
    { ...rest, style: mergeStyles(structuralStyle, style) },
    children
  );
}
