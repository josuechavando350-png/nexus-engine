"use client";

import type { ReactNode } from "react";
import { useScrollReveal } from "@nexus/core/motion/hooks/useScrollReveal";

type RevealProps = {
  children: ReactNode;
  className?: string;
  delay?: "none" | "short" | "medium" | "long";
};

export function Reveal({
  children,
  className,
  delay = "none"
}: RevealProps) {
  const { ref, isVisible } = useScrollReveal({
    threshold: 0.15,
    once: true
  });

  const classes = [
    "nexus-reveal",
    isVisible ? "nexus-reveal-visible" : "",
    `nexus-reveal-delay-${delay}`,
    className ?? ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section
      ref={ref}
      className={classes}
      data-nexus-motion="enter"
    >
      {children}
    </section>
  );
}
