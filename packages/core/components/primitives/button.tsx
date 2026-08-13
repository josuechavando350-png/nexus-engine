import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  children?: ReactNode;
};

/**
 * @status core
 * Semantic button shell. Visual styling and variants remain Client Experience concerns.
 */
export function Button({ children, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} data-nx-focus="" {...rest}>
      {children}
    </button>
  );
}
