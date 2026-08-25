"use client";

import { useEffect } from "react";

const ACTIVE_CARD_SELECTOR = ".cp-path, .cp-why article, .cp-area, .cp-case";

export function ClientInteractions() {
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".cp-header");
    const cards = Array.from(document.querySelectorAll<HTMLElement>(ACTIVE_CARD_SELECTOR));
    const audience = document.querySelector<HTMLElement>(".cp-audiences");

    const updateHeader = () => header?.classList.toggle("is-scrolled", window.scrollY > 24);
    const updateGlow = (event: PointerEvent) => {
      const card = event.currentTarget as HTMLElement;
      const bounds = card.getBoundingClientRect();
      card.style.setProperty("--glow-x", `${event.clientX - bounds.left}px`);
      card.style.setProperty("--glow-y", `${event.clientY - bounds.top}px`);
    };
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
    cards.forEach((card) => card.addEventListener("pointermove", updateGlow));
    audience?.addEventListener("scroll", updateAudience, { passive: true });

    const observer = new IntersectionObserver(
      (entries) => entries.forEach((entry) => entry.target.classList.toggle("is-visible", entry.isIntersecting)),
      { threshold: 0.65 }
    );
    cards.forEach((card) => observer.observe(card));

    return () => {
      window.removeEventListener("scroll", updateHeader);
      cards.forEach((card) => card.removeEventListener("pointermove", updateGlow));
      audience?.removeEventListener("scroll", updateAudience);
      observer.disconnect();
    };
  }, []);

  return null;
}
