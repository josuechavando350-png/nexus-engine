"use client";

import { CSSProperties, ReactNode, useRef } from "react";
import { useReveal } from "@/lib/useReveal";

type Props = { children: ReactNode; className?: string; delay?: number; as?: "div" | "p" | "li" | "span" };

export function Reveal({ children, className = "", delay = 0, as = "div" }: Props) {
  const ref = useRef<HTMLElement | null>(null);
  useReveal(ref);
  const Tag = as;
  return <Tag ref={ref as never} className={`reveal ${className}`.trim()} style={{ "--reveal-delay": `${delay}ms` } as CSSProperties}>{children}</Tag>;
}
