import type { AnchorHTMLAttributes, ReactNode } from "react";

export type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children"> & {
  children?: ReactNode;
  href: string;
};

/** @status core Semantic anchor shell; routing adapters belong to the app layer. */
export function Link({ children, href, ...rest }: LinkProps) {
  return (
    <a href={href} data-nx-focus="" {...rest}>
      {children}
    </a>
  );
}
