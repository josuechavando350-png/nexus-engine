import type { HTMLAttributes, ReactNode } from "react";
import { SR_ONLY_CLASS } from "../../a11y";

export type VisuallyHiddenProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  children?: ReactNode;
};

/** @status core Reuses the central screen-reader-only accessibility contract. */
export function VisuallyHidden({
  children,
  className,
  ...rest
}: VisuallyHiddenProps) {
  const classes = [SR_ONLY_CLASS, className].filter(Boolean).join(" ");

  return (
    <span className={classes} {...rest}>
      {children}
    </span>
  );
}
