"use client";

import { useEffect } from "react";
import { site } from "./content";
import { googleTaggedWhatsappHref, isBrowserAdVisit } from "./ad-visitor";

/** Marks the home hero's main button; for ad visitors it becomes a direct WhatsApp link. */
export const HERO_PRIMARY_ATTRIBUTE = "data-cp-hero-primary";

/**
 * For visits that came from a Google Ads click only: tags every WhatsApp link on the page
 * with "Hola, lo encontré en Google." and turns the hero's main button into WhatsApp.
 * Every other visitor gets the page exactly as it is rendered.
 */
export function AdVisitorWhatsapp() {
  useEffect(() => {
    try {
      if (!isBrowserAdVisit()) return;
      const base = window.location.href;
      document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
        const href = anchor.getAttribute("href");
        if (!href) return;
        const tagged = googleTaggedWhatsappHref(href, base);
        if (tagged !== href) anchor.setAttribute("href", tagged);
      });
      const hero = document.querySelector<HTMLAnchorElement>(`a[${HERO_PRIMARY_ATTRIBUTE}]`);
      if (hero) {
        hero.setAttribute("href", googleTaggedWhatsappHref(site.whatsapp, base));
        hero.setAttribute("target", "_blank");
        hero.setAttribute("rel", "noopener noreferrer");
        hero.setAttribute("data-nexus-signal", "hero-whatsapp-ad");
      }
    } catch {
      // Tagging is a convenience; a failure must leave every contact link working as rendered.
    }
  }, []);

  return null;
}
