import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import type { SpaceRole } from "./shared";
import { mergeStyles, spaceValue } from "./shared";

export type StackProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children?: ReactNode;
  gap?: SpaceRole;
  align?: CSSProperties["alignItems"];
  style?: CSSProperties;
};

/** @status core Structural vertical flow primitive. */
export function Stack({
  children,
  gap = "space.md",
  align,
  style,
  ...rest
}: StackProps) {
  return (
    <div
      {...rest}
      style={mergeStyles(
        {
          display: "flex",
          flexDirection: "column",
          gap: spaceValue(gap),
          alignItems: align
        },
        style
      )}
    >
      {children}
    </div>
  );
}
