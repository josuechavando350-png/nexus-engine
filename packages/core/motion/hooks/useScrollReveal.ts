"use client";

/**
 * @status candidate
 *
 * Candidate implementation for the scroll → reveal role.
 * Promotion requires evidence from 2+ projects with distinct art direction,
 * plus performance and accessibility evidence.
 */

import { useEffect, useRef, useState } from "react";

export type UseScrollRevealOptions = {
  threshold?: number;
  once?: boolean;
};

export function useScrollReveal({
  threshold = 0.15,
  once = true
}: UseScrollRevealOptions = {}) {
  const ref = useRef<HTMLElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;

        if (entry.isIntersecting) {
          setIsVisible(true);
          if (once) observer.disconnect();
        } else if (!once) {
          setIsVisible(false);
        }
      },
      { threshold }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [once, threshold]);

  return { ref, isVisible };
}
