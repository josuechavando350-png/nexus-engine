"use client";

import { useEffect } from "react";

const GOOGLE_ADS_ID = "AW-11458109085";
const WHATSAPP_CONVERSION = "AW-11458109085/qaC9CPLhg7obEJZ909cq";
const PHONE_CONVERSION = "AW-11458109085/AtYkCOir1-ocEJZ909cq";
const AUTO_LOAD_DELAY_MS = 1200;

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
    let autoLoadTimer: number | undefined;

    const activate = () => {
      if (activated) return;
      activated = true;
      ensureGoogleAds();

      window.removeEventListener("pointerdown", activate);
      window.removeEventListener("keydown", activate);
      if (autoLoadTimer) window.clearTimeout(autoLoadTimer);
    };

    const scheduleAutoLoad = () => {
      if (activated || autoLoadTimer) return;
      autoLoadTimer = window.setTimeout(activate, AUTO_LOAD_DELAY_MS);
    };

    // Load immediately in explicit Tag Assistant debug sessions. Some mobile
    // Tag Assistant flows do not preserve `_dbg`, so normal pages also get a
    // delayed post-load activation. This keeps the tag discoverable without
    // putting it on the critical rendering path.
    const isTagAssistantDebug = new URLSearchParams(window.location.search).has("_dbg");
    if (isTagAssistantDebug) {
      activate();
    } else if (document.readyState === "complete") {
      scheduleAutoLoad();
    } else {
      window.addEventListener("load", scheduleAutoLoad, { once: true });
    }

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
      window.removeEventListener("load", scheduleAutoLoad);
      window.removeEventListener("pointerdown", activate);
      window.removeEventListener("keydown", activate);
      document.removeEventListener("click", handleClick, true);
      if (autoLoadTimer) window.clearTimeout(autoLoadTimer);
    };
  }, []);

  return null;
}
