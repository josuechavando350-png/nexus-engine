"use client";

import { useEffect } from "react";

export function ClientInteractions() {
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".cp-header");
    const audience = document.querySelector<HTMLElement>(".cp-audiences");
    const tactileCards = Array.from(document.querySelectorAll<HTMLElement>(".cp-path, .cp-why article, .cp-area, .cp-case"));

    const updateHeader = () => header?.classList.toggle("is-scrolled", window.scrollY > 80);
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

    const pressHandlers = tactileCards.map((card) => {
      let releaseTimer: number | undefined;
      const press = () => {
        if (releaseTimer) window.clearTimeout(releaseTimer);
        card.classList.add("is-pressed");
      };
      const release = () => {
        if (releaseTimer) window.clearTimeout(releaseTimer);
        releaseTimer = window.setTimeout(() => card.classList.remove("is-pressed"), 720);
      };
      card.addEventListener("pointerdown", press);
      card.addEventListener("pointerup", release);
      card.addEventListener("pointercancel", release);
      card.addEventListener("pointerleave", release);
      return () => {
        if (releaseTimer) window.clearTimeout(releaseTimer);
        card.classList.remove("is-pressed");
        card.removeEventListener("pointerdown", press);
        card.removeEventListener("pointerup", release);
        card.removeEventListener("pointercancel", release);
        card.removeEventListener("pointerleave", release);
      };
    });

    updateHeader();
    updateAudience();
    window.addEventListener("scroll", updateHeader, { passive: true });
    audience?.addEventListener("scroll", updateAudience, { passive: true });

    return () => {
      window.removeEventListener("scroll", updateHeader);
      audience?.removeEventListener("scroll", updateAudience);
      pressHandlers.forEach((cleanup) => cleanup());
    };
  }, []);

  return null;
}
