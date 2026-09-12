"use client";

import { useEffect } from "react";

const WHATSAPP_CONVERSION = "AW-11458109085/91BuCLXLwO4cEJ2909cq";
const PHONE_CONVERSION = "AW-11458109085/O_A8CLjLwO4cEJ2909cq";

type Gtag = (...args: unknown[]) => void;

type RuntimeWindow = typeof window & {
  gtag?: Gtag;
};

function trackConversion(sendTo: string) {
  (window as RuntimeWindow).gtag?.("event", "conversion", {
    send_to: sendTo,
  });
}

function trackPhoneConversion(destination: string) {
  const gtag = (window as RuntimeWindow).gtag;
  if (!gtag) {
    window.location.href = destination;
    return;
  }

  let navigated = false;
  const navigate = () => {
    if (navigated) return;
    navigated = true;
    window.location.href = destination;
  };

  gtag("event", "conversion", {
    send_to: PHONE_CONVERSION,
    event_callback: navigate,
    event_timeout: 900,
  });

  window.setTimeout(navigate, 900);
}

export function GoogleAdsConversions() {
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const link = target.closest<HTMLAnchorElement>("a[href]");
      if (!link) return;

      const href = link.getAttribute("href") || "";
      const destination = link.href;

      if (href.startsWith("tel:")) {
        event.preventDefault();
        trackPhoneConversion(destination);
        return;
      }

      try {
        const url = new URL(destination, window.location.href);
        if (url.hostname === "wa.me" || url.hostname.endsWith("whatsapp.com")) {
          trackConversion(WHATSAPP_CONVERSION);
        }
      } catch {
        // Ignore malformed/non-URL href values.
      }
    };

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, []);

  return null;
}
