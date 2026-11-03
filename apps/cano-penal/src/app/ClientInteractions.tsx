"use client";

import { useEffect } from "react";

const FADE_SELECTOR = [
  ".cp-hero-copy",
  ".cp-section-head",
  ".cp-path",
  ".cp-why article",
  ".cp-metrics-about",
  ".cp-metric",
  ".cp-areas-intro",
  ".cp-area",
  ".cp-route-index-heading",
  ".cp-route-index-group",
  ".cp-case",
  ".cp-v2-specialty-grid > div",
  ".cp-v2-intelligence-head > div",
  ".cp-v2-intelligence-head > p",
  ".cp-v2-intelligence-grid > a",
  ".cp-advisory > div",
  ".cp-contact > div",
  ".cp-interior-hero-copy",
  ".cp-interior-aside",
  ".cp-interior-editorial-row",
  ".cp-interior-cta-grid > div",
  ".cp-strategic-context",
  ".cp-strategic-scenarios article",
  ".cp-strategic-related",
  ".cp-proof-center-intro",
  ".cp-proof-center-rail article",
  ".cp-about-academics",
  ".cp-intel-hero-grid > div",
  ".cp-intel-entry",
  ".cp-intel-method-grid > div",
  ".cp-enterprise-hero-grid > div",
  ".cp-enterprise-process > div",
  ".cp-enterprise-steps article",
  ".cp-enterprise-form-grid > div",
  ".cp-biz-hero-grid > div",
  ".cp-biz-row-list article",
  ".cp-biz-proof-grid > div",
  ".cp-sat-headline",
  ".cp-sat-question-list article",
  ".cp-sat-next > div > div",
].join(",");

/**
 * Page CTAs the floating WhatsApp button must never cover: the site's buttons and form fields.
 * On a phone the hero buttons sit right where the floating button is fixed, so the label
 * ("Atención inmediata") covered "Hablemos de tu caso" on the first screen of ad visitors.
 */
export const FLOATING_WA_GUARDED_SELECTOR = "main .cp-btn, main input, main textarea, main select, main button";

type RectLike = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

export function rectsOverlap(a: RectLike, b: RectLike, gap = 0) {
  return a.left - gap < b.right && a.right + gap > b.left && a.top - gap < b.bottom && a.bottom + gap > b.top;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function ClientInteractions() {
  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".cp-header");
    const audience = document.querySelector<HTMLElement>(".cp-audiences");
    const tactileCards = Array.from(document.querySelectorAll<HTMLElement>(".cp-path, .cp-why article, .cp-area, .cp-case"));
    const fadeItems = Array.from(document.querySelectorAll<HTMLElement>(FADE_SELECTOR));
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const floatingWa = document.querySelector<HTMLElement>(".cp-wa");
    const floatingLabel = floatingWa?.querySelector<HTMLElement>(".cp-wa-cta") ?? null;
    const guardedTargets = Array.from(document.querySelectorAll<HTMLElement>(FLOATING_WA_GUARDED_SELECTOR));
    let previousScrollY = window.scrollY;
    let frame = 0;

    fadeItems.forEach((item) => item.classList.add("cp-scroll-fade"));

    // Hide the label, or the whole floating button, only while it would cover a page CTA.
    const updateFloatingWhatsapp = () => {
      if (!floatingWa) return;
      const viewportHeight = window.innerHeight;
      const onScreen = guardedTargets
        .map((target) => target.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < viewportHeight);
      const covers = (rect: RectLike) => onScreen.some((target) => rectsOverlap(rect, target, 6));
      const label = floatingLabel?.getBoundingClientRect();
      floatingWa.classList.toggle("is-yielding", covers(floatingWa.getBoundingClientRect()));
      floatingWa.classList.toggle("is-label-yielding", Boolean(label && label.width > 0 && covers(label)));
    };

    const updateScrollExperience = () => {
      frame = 0;
      const y = window.scrollY;
      const delta = y - previousScrollY;

      header?.classList.toggle("is-scrolled", y > 80);
      if (y <= 110 || delta < -5) header?.classList.remove("is-hidden");
      else if (delta > 7) header?.classList.add("is-hidden");

      if (!reducedMotion.matches) {
        const viewport = Math.max(window.innerHeight, 1);
        const fadeLine = viewport * 0.30;
        fadeItems.forEach((item) => {
          const rect = item.getBoundingClientRect();
          const progress = clamp((fadeLine - rect.bottom) / fadeLine, 0, 1);
          const opacity = 1 - progress * 0.96;
          const lift = -24 * progress;
          const blur = 2.2 * progress;
          item.style.setProperty("--cp-scroll-opacity", opacity.toFixed(3));
          item.style.setProperty("--cp-scroll-lift", `${lift.toFixed(2)}px`);
          item.style.setProperty("--cp-scroll-blur", `${blur.toFixed(2)}px`);
        });
      } else {
        fadeItems.forEach((item) => {
          item.style.removeProperty("--cp-scroll-opacity");
          item.style.removeProperty("--cp-scroll-lift");
          item.style.removeProperty("--cp-scroll-blur");
        });
        header?.classList.remove("is-hidden");
      }

      updateFloatingWhatsapp();
      previousScrollY = y;
    };

    const requestScrollUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateScrollExperience);
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

    updateScrollExperience();
    updateAudience();
    // Layout can still move after hydration (images, fonts) and the label slides in at ~2.6 s.
    const settleTimer = window.setTimeout(requestScrollUpdate, 3300);
    window.addEventListener("load", requestScrollUpdate);
    window.addEventListener("scroll", requestScrollUpdate, { passive: true });
    window.addEventListener("resize", requestScrollUpdate, { passive: true });
    audience?.addEventListener("scroll", updateAudience, { passive: true });
    reducedMotion.addEventListener("change", requestScrollUpdate);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      window.removeEventListener("load", requestScrollUpdate);
      window.removeEventListener("scroll", requestScrollUpdate);
      window.removeEventListener("resize", requestScrollUpdate);
      audience?.removeEventListener("scroll", updateAudience);
      reducedMotion.removeEventListener("change", requestScrollUpdate);
      floatingWa?.classList.remove("is-yielding", "is-label-yielding");
      fadeItems.forEach((item) => {
        item.classList.remove("cp-scroll-fade");
        item.style.removeProperty("--cp-scroll-opacity");
        item.style.removeProperty("--cp-scroll-lift");
        item.style.removeProperty("--cp-scroll-blur");
      });
      header?.classList.remove("is-hidden");
      pressHandlers.forEach((cleanup) => cleanup());
    };
  }, []);

  return null;
}
