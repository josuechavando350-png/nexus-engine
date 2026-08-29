"use client";

import { useEffect } from "react";

const WHATSAPP_CONVERSION = "AW-11458109085/qaC9CPLhg7obEJZ909cq";
const PHONE_CONVERSION = "AW-11458109085/AtYkCOir1-ocEJZ909cq";

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

function trackConversion(sendTo: string, extras?: Record<string, unknown>) {
  const gtag = getGtag();
  gtag("event", "conversion", {
    send_to: sendTo,
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

    document.addEventListener("click", handleClick, true);

    return () => {
      document.removeEventListener("click", handleClick, true);
    };
  }, []);

  return null;
}
