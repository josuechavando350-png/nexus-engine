"use client";

import { useEffect } from "react";

const GOOGLE_ADS_ID = "AW-11458109085";
const WHATSAPP_CONVERSION = "AW-11458109085/qaC9CPLhg7obEJZ909cq";
const PHONE_CONVERSION = "AW-11458109085/AtYkCOir1-ocEJZ909cq";

type DataLayer = unknown[];

type Gtag = (...args: unknown[]) => void;

function ensureGoogleAds() {
  const runtime = window as typeof window & {
    dataLayer?: DataLayer;
    gtag?: Gtag;
  };

  const dataLayer = (runtime.dataLayer ||= []);
  const gtag: Gtag = runtime.gtag || ((...args: unknown[]) => dataLayer.push(args));
  runtime.gtag = gtag;

  if (!document.querySelector("script[data-cano-google-ads='true']")) {
    gtag("js", new Date());
    gtag("config", GOOGLE_ADS_ID);

    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}`;
    script.dataset.canoGoogleAds = "true";
    document.head.appendChild(script);
  }

  return gtag;
}

function trackConversion(sendTo: string, extras?: Record<string, unknown>) {
  const gtag = ensureGoogleAds();
  gtag("event", "conversion", {
    send_to: sendTo,
    ...extras,
  });
}

export function GoogleAdsAfterInteraction() {
  useEffect(() => {
    let activated = false;

    const activate = () => {
      if (activated) return;
      activated = true;
      ensureGoogleAds();

      window.removeEventListener("pointerdown", activate);
      window.removeEventListener("keydown", activate);
    };

    // Tag Assistant appends `_dbg` to the inspected URL. In that explicit
    // diagnostic mode we load the Google tag immediately so the debugger can
    // discover it. Normal visitors keep the interaction-gated loader that
    // protects the site's initial performance profile.
    const isTagAssistantDebug = new URLSearchParams(window.location.search).has("_dbg");
    if (isTagAssistantDebug) activate();

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const link = target.closest<HTMLAnchorElement>("a[href]");
      if (!link) return;

      const href = link.getAttribute("href") || "";

      if (href.startsWith("tel:")) {
        trackConversion(PHONE_CONVERSION, { value: 1.0, currency: "MXN" });
        return;
      }

      try {
        const url = new URL(link.href, window.location.href);
        if (url.hostname === "wa.me" || url.hostname.endsWith("whatsapp.com")) {
          trackConversion(WHATSAPP_CONVERSION);
        }
      } catch {
        // Ignore malformed/non-URL href values.
      }
    };

    if (!activated) {
      window.addEventListener("pointerdown", activate, { passive: true, once: true });
      window.addEventListener("keydown", activate, { once: true });
    }
    document.addEventListener("click", handleClick, true);

    return () => {
      window.removeEventListener("pointerdown", activate);
      window.removeEventListener("keydown", activate);
      document.removeEventListener("click", handleClick, true);
    };
  }, []);

  return null;
}
