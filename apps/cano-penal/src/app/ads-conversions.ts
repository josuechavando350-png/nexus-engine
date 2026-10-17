/**
 * Google Ads conversion reporting for CANO contact actions.
 *
 * The labels belong to the client's Google Ads account "EDUARDO CANO | ESTRATEGIA PENAL"
 * (AW-11458109085). They were created on 2026-09-04 as "WhatsApp - canopenal",
 * "Clic telefono - canopenal" and "Formulario web - canopenal" and were live on the
 * previous production branch; the current site only loaded the base tag, so no contact
 * was being reported.
 *
 * Contract: reporting never blocks a visitor from reaching the lawyer. It never throws,
 * never cancels a navigation, and a navigation the page performs itself waits at most
 * CONVERSION_NAVIGATION_WAIT_MS for the hit to leave.
 */
export const GOOGLE_ADS_ID = "AW-11458109085";

export const GOOGLE_ADS_CONVERSIONS = {
  whatsapp: `${GOOGLE_ADS_ID}/91BuCLXLwO4cEJ2909cq`,
  phone: `${GOOGLE_ADS_ID}/O_A8CLjLwO4cEJ2909cq`,
  form: `${GOOGLE_ADS_ID}/tbcxCLLLwO4cEJ2909cq`,
} as const;

export type AdsConversionKind = keyof typeof GOOGLE_ADS_CONVERSIONS;
export type ContactLinkKind = Extract<AdsConversionKind, "whatsapp" | "phone">;

/** Upper bound a page-initiated navigation waits for gtag before continuing anyway. */
export const CONVERSION_NAVIGATION_WAIT_MS = 800;

const WHATSAPP_HOSTS = new Set(["wa.me", "api.whatsapp.com", "web.whatsapp.com", "whatsapp.com", "www.whatsapp.com"]);

/** Classifies an href as a WhatsApp or phone contact link; anything else is not a conversion. */
export function classifyContactHref(href: string | null | undefined, baseUrl = "https://canopenal.com/"): ContactLinkKind | null {
  if (!href) return null;
  const value = href.trim();
  if (/^tel:/iu.test(value)) return "phone";
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return null;
  }
  if (url.protocol === "whatsapp:") return "whatsapp";
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return WHATSAPP_HOSTS.has(url.hostname.toLowerCase()) ? "whatsapp" : null;
}

/** Resolves the contact link (if any) a click landed on, including clicks on nested icons or text. */
export function contactKindForClickTarget(target: EventTarget | null, baseUrl: string): ContactLinkKind | null {
  if (!target || typeof (target as Element).closest !== "function") return null;
  const anchor = (target as Element).closest("a[href]");
  if (!anchor) return null;
  return classifyContactHref(anchor.getAttribute("href"), baseUrl);
}

type ConversionGtag = (command: "event", eventName: "conversion", params: Readonly<Record<string, unknown>>) => void;
type Schedule = (callback: () => void, delayMs: number) => unknown;

/**
 * Sends one conversion to Google Ads. When `onReported` is given (the page is about to
 * navigate by itself), it runs exactly once: when gtag confirms the hit, or after the
 * bounded wait, or immediately if gtag is unavailable or fails.
 */
export function reportAdsConversion(
  kind: AdsConversionKind,
  gtag: unknown,
  onReported?: () => void,
  schedule: Schedule = (callback, delayMs) => setTimeout(callback, delayMs),
): void {
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    onReported?.();
  };

  if (typeof gtag !== "function") {
    settle();
    return;
  }

  try {
    (gtag as ConversionGtag)("event", "conversion", {
      send_to: GOOGLE_ADS_CONVERSIONS[kind],
      transport_type: "beacon",
      event_callback: settle,
    });
  } catch {
    settle();
    return;
  }

  if (onReported) schedule(settle, CONVERSION_NAVIGATION_WAIT_MS);
}

/** The page's gtag function, if the base tag defined it. */
export function pageGtag(): unknown {
  return typeof window === "undefined" ? undefined : (window as Window & { gtag?: unknown }).gtag;
}
