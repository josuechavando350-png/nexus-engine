"use client";

import { useEffect } from "react";

export function ClientInteractions() {
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".cp-header");
    const audience = document.querySelector<HTMLElement>(".cp-audiences");

    const updateHeader = () => header?.classList.toggle("is-scrolled", window.scrollY > 24);
    const updateAudience = () => {
      if (!audience) return;
      const center = audience.getBoundingClientRect().left + audience.clientWidth / 2;
      let closest: HTMLImageElement | undefined;
      let distance = Number.POSITIVE_INFINITY;
      audience.querySelectorAll("img").forEach((image) => {
        const bounds = image.getBoundingClientRect();
        const nextDistance = Math.abs(bounds.left + bounds.width / 2 - center);
        if (nextDistance < distance) {
          closest = image;
          distance = nextDistance;
        }
      });
      audience.querySelectorAll("img").forEach((image) => image.classList.toggle("is-active", image === closest));
    };

    updateHeader();
    updateAudience();
    window.addEventListener("scroll", updateHeader, { passive: true });
    audience?.addEventListener("scroll", updateAudience, { passive: true });

    return () => {
      window.removeEventListener("scroll", updateHeader);
      audience?.removeEventListener("scroll", updateAudience);
    };
  }, []);

  return null;
}
