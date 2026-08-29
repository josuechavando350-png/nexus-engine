"use client";

import { useEffect } from "react";

const WHATSAPP_CONVERSION = "AW-11458109085/qaC9CPLhg7obEJZ909cq";
const PHONE_CONVERSION = "AW-11458109085/AtYkCOir1-ocEJZ909cq";
const NAVIGATION_FALLBACK_MS = 900;

type DataLayer = unknown[];
type Gtag = (...args: unknown[]) => void;

function getGtag(): Gtag {
  const runtime = window as typeof window & {
    dataLayer?: DataLayer;
    gtag?: Gtag;
  };

  const dataLayer = (runtime.dataLayer ||= []);
  const gtag: Gtag = runtime.gtag || ((...args: unknown[]) => dataLayer.push(args));
  runtime.gtag = gtag;
  return gtag;
}

function trackConversionAndNavigate(
  sendTo: string,
  destination: string,
  target: string | null,
  extras?: Record<string, unknown>,
) {
  const gtag = getGtag();
  let navigated = false;

  const navigate = () => {
    if (navigated) return;
    navigated = true;
    if (target === "_blank") {
      window.open(destination, "_blank", "noopener,noreferrer");
    } else {
      window.location.href = destination;
    }
  };

  window.setTimeout(navigate, NAVIGATION_FALLBACK_MS);

  gtag("event", "conversion", {
    send_to: sendTo,
    event_callback: navigate,
    event_timeout: NAVIGATION_FALLBACK_MS,
    ...extras,
  });
}

export function GoogleAdsAfterInteraction() {
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const link = target.closest<HTMLAnchorElement>("a[href]");
      if (!link) return;

      const href = link.getAttribute("href") || "";

      if (href.startsWith("tel:")) {
        event.preventDefault();
        trackConversionAndNavigate(PHONE_CONVERSION, link.href, link.target || null, {
          value: 1.0,
          currency: "MXN",
        });
        return;
      }

      try {
        const url = new URL(link.href, window.location.href);
        if (url.hostname === "wa.me" || url.hostname.endsWith("whatsapp.com")) {
          event.preventDefault();
          trackConversionAndNavigate(WHATSAPP_CONVERSION, link.href, link.target || null);
        }
      } catch {
        // Ignore malformed/non-URL href values.
      }
    };

    document.addEventListener("click", handleClick, true);

    return () => {
      document.removeEventListener("click", handleClick, true);
    };
  }, []);

  return null;
}
