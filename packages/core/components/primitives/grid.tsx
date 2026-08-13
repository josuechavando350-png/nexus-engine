import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import type { SpaceRole } from "./shared";
import { mergeStyles, spaceValue } from "./shared";

export type GridProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children?: ReactNode;
  columns?: number;
  gap?: SpaceRole;
  style?: CSSProperties;
};

/** @status core Structural grid primitive with no branded breakpoints or values. */
export function Grid({
  children,
  columns = 1,
  gap = "space.md",
  style,
  ...rest
}: GridProps) {
  const safeColumns = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 1;

  return (
    <div
      {...rest}
      style={mergeStyles(
        {
          display: "grid",
          gridTemplateColumns: `repeat(${safeColumns}, minmax(0, 1fr))`,
          gap: spaceValue(gap)
        },
        style
      )}
    >
      {children}
    </div>
  );
}
