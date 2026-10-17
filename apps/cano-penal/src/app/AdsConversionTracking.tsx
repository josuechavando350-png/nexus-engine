"use client";

import { useEffect } from "react";
import { contactKindForClickTarget, pageGtag, reportAdsConversion } from "./ads-conversions";

/**
 * Reports clicks on WhatsApp and phone links to Google Ads. It only observes the click:
 * it never prevents, delays or redirects the navigation the visitor asked for.
 */
export function AdsConversionTracking() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      try {
        const kind = contactKindForClickTarget(event.target, window.location.href);
        if (kind) reportAdsConversion(kind, pageGtag());
      } catch {
        // Measurement must never interfere with a visitor reaching the lawyer.
      }
    };
    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, []);

  return null;
}
