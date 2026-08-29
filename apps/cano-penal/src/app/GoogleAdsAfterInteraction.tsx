"use client";

import { useEffect } from "react";

const GOOGLE_ADS_ID = "AW-11458109085";

export function GoogleAdsAfterInteraction() {
  useEffect(() => {
    let activated = false;

    const activate = () => {
      if (activated) return;
      activated = true;

      const dataLayer = ((window as typeof window & { dataLayer?: unknown[] }).dataLayer ||= []);
      const gtag = (...args: unknown[]) => dataLayer.push(args);
      gtag("js", new Date());
      gtag("config", GOOGLE_ADS_ID);

      const script = document.createElement("script");
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}`;
      script.dataset.canoGoogleAds = "true";
      document.head.appendChild(script);

      window.removeEventListener("pointerdown", activate);
      window.removeEventListener("keydown", activate);
    };

    window.addEventListener("pointerdown", activate, { passive: true, once: true });
    window.addEventListener("keydown", activate, { once: true });

    return () => {
      window.removeEventListener("pointerdown", activate);
      window.removeEventListener("keydown", activate);
    };
  }, []);

  return null;
}
