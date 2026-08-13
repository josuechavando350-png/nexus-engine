import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import type { SpaceRole } from "./shared";
import { mergeStyles, spaceValue } from "./shared";

export type SectionProps = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  children?: ReactNode;
  spacing?: SpaceRole;
  style?: CSSProperties;
};

/** @status core Generic section wrapper; deliberately not a marketing pattern. */
export function Section({
  children,
  spacing,
  style,
  ...rest
}: SectionProps) {
  return (
    <section
      {...rest}
      style={mergeStyles(
        {
          paddingBlock: spaceValue(spacing)
        },
        style
      )}
    >
      {children}
    </section>
  );
}
