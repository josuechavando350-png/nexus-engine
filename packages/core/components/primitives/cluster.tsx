import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import type { SpaceRole } from "./shared";
import { mergeStyles, spaceValue } from "./shared";

export type ClusterProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children?: ReactNode;
  gap?: SpaceRole;
  align?: CSSProperties["alignItems"];
  justify?: CSSProperties["justifyContent"];
  wrap?: CSSProperties["flexWrap"];
  style?: CSSProperties;
};

/** @status core Structural horizontal/wrapping flow primitive. */
export function Cluster({
  children,
  gap = "space.md",
  align = "center",
  justify,
  wrap = "wrap",
  style,
  ...rest
}: ClusterProps) {
  return (
    <div
      {...rest}
      style={mergeStyles(
        {
          display: "flex",
          flexWrap: wrap,
          gap: spaceValue(gap),
          alignItems: align,
          justifyContent: justify
        },
        style
      )}
    >
      {children}
    </div>
  );
}
