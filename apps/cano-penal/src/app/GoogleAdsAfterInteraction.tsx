"use client";

import { useEffect } from "react";

const GOOGLE_ADS_ID = "AW-11458109085";
const WHATSAPP_CONVERSION = "AW-11458109085/qaC9CPLhg7obEJZ909cq";
const PHONE_CONVERSION = "AW-11458109085/AtYkCOir1-ocEJZ909cq";

type DataLayer = unknown[];
type Gtag = (...args: unknown[]) => void;

type RuntimeWindow = typeof window & {
  dataLayer?: DataLayer;
  gtag?: Gtag;
};

let loaderPromise: Promise<void> | null = null;

function ensureGoogleAdsReady(): Promise<void> {
  if (loaderPromise) return loaderPromise;

  loaderPromise = new Promise<void>((resolve) => {
    const runtime = window as RuntimeWindow;
    const dataLayer = (runtime.dataLayer ||= []);
    const gtag: Gtag = runtime.gtag || ((...args: unknown[]) => dataLayer.push(args));
    runtime.gtag = gtag;

    const existing = document.querySelector<HTMLScriptElement>("script[data-cano-google-ads='true']");
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => resolve(), { once: true });
      return;
    }

    gtag("js", new Date());
    gtag("config", GOOGLE_ADS_ID);

    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}`;
    script.dataset.canoGoogleAds = "true";
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    }, { once: true });
    script.addEventListener("error", () => resolve(), { once: true });
    document.head.appendChild(script);
  });

  return loaderPromise;
}

function trackConversion(sendTo: string, extras?: Record<string, unknown>) {
  const runtime = window as RuntimeWindow;
  runtime.gtag?.("event", "conversion", {
    send_to: sendTo,
    ...extras,
  });
}

function trackOutboundConversion(sendTo: string, destination: string, extras?: Record<string, unknown>) {
  const runtime = window as RuntimeWindow;
  const gtag = runtime.gtag;
  let navigated = false;

  const navigate = () => {
    if (navigated) return;
    navigated = true;
    window.location.href = destination;
  };

  if (!gtag) {
    navigate();
    return;
  }

  gtag("event", "conversion", {
    send_to: sendTo,
    ...extras,
    event_callback: navigate,
    event_timeout: 900,
  });

  window.setTimeout(navigate, 900);
}

export function GoogleAdsAfterInteraction() {
  useEffect(() => {
    const activate = () => {
      void ensureGoogleAdsReady();
    };

    const handleClick = async (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const link = target.closest<HTMLAnchorElement>("a[href]");
      if (!link) return;

      const href = link.getAttribute("href") || "";
      const destination = link.href;

      if (href.startsWith("tel:")) {
        event.preventDefault();
        await ensureGoogleAdsReady();
        trackOutboundConversion(PHONE_CONVERSION, destination, { value: 1.0, currency: "MXN" });
        return;
      }

      try {
        const url = new URL(destination, window.location.href);
        if (url.hostname === "wa.me" || url.hostname.endsWith("whatsapp.com")) {
          // WhatsApp links already open in a new tab. Keep the current page alive so
          // the deferred Google Ads tag has time to finish loading and send the hit.
          // Do not preventDefault() and do not redirect this tab.
          void ensureGoogleAdsReady().then(() => {
            trackConversion(WHATSAPP_CONVERSION);
          });
        }
      } catch {
        // Ignore malformed/non-URL href values.
      }
    };

    window.addEventListener("pointerdown", activate, { passive: true, once: true });
    window.addEventListener("keydown", activate, { once: true });
    document.addEventListener("click", handleClick, true);

    return () => {
      window.removeEventListener("pointerdown", activate);
      window.removeEventListener("keydown", activate);
      document.removeEventListener("click", handleClick, true);
    };
  }, []);

  return null;
}
