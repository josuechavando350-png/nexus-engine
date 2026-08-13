import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { tokenVar } from "../../foundation/tokens";
import type { ContainerRole, SpaceRole } from "./shared";
import { mergeStyles, spaceValue } from "./shared";

export type ContainerProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children?: ReactNode;
  size?: ContainerRole;
  paddingInline?: SpaceRole;
  style?: CSSProperties;
};

/** @status core Centers content within an app-owned tokenized max width. */
export function Container({
  children,
  size = "container.lg",
  paddingInline,
  style,
  ...rest
}: ContainerProps) {
  return (
    <div
      {...rest}
      style={mergeStyles(
        {
          width: "100%",
          maxWidth: tokenVar(size),
          marginInline: "auto",
          paddingInline: spaceValue(paddingInline)
        },
        style
      )}
    >
      {children}
    </div>
  );
}
