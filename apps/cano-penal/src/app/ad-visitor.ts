import { classifyContactHref } from "./ads-conversions";
import { site } from "./content";
import { AD_CLICK_PARAMS } from "./HomeSplash";

/**
 * Visitors who arrive from a Google Ads click (approved by Josue for the client, Nov 2026):
 * every WhatsApp message they open starts with GOOGLE_ORIGIN_GREETING, so the lawyer can see
 * in his own chat which contacts came from Google, and the hero's main button opens WhatsApp
 * directly instead of scrolling to the contact section.
 *
 * Only the landing URL decides it (the same Google Ads click identifiers the splash uses); the
 * flag then lives in sessionStorage so it holds on the other pages of the same visit. Nothing
 * changes for any other visitor, and nothing here may ever stop a visitor from reaching him.
 */
export const AD_VISIT_SESSION_KEY = "cano:ad-visit:v1";
export const GOOGLE_ORIGIN_GREETING = "Hola, lo encontré en Google.";
export const DEFAULT_AD_MESSAGE = "Me gustaría hablar sobre mi caso.";

const AD_CLICK_PATTERN = new RegExp(`[?&](?:${AD_CLICK_PARAMS.join("|")})=[^&]`, "u");
const LEADING_GREETING = /^¡?hola\b[\s,.!]*/iu;

type SessionStore = Pick<Storage, "getItem" | "setItem">;

export function isAdLandingSearch(search: string): boolean {
  return AD_CLICK_PATTERN.test(search);
}

/** True when this page view belongs to a visit that landed from a Google Ads click. */
export function rememberAdVisit(search: string, storage: SessionStore | null): boolean {
  const landing = isAdLandingSearch(search);
  if (!storage) return landing;
  try {
    if (landing) {
      storage.setItem(AD_VISIT_SESSION_KEY, "1");
      return true;
    }
    return storage.getItem(AD_VISIT_SESSION_KEY) === "1";
  } catch {
    return landing;
  }
}

/** Puts the Google greeting first, without doubling a "Hola" the message already had. */
export function googleTaggedMessage(message: string | null | undefined): string {
  const text = (message ?? "").trim();
  if (text.startsWith(GOOGLE_ORIGIN_GREETING)) return text;
  const rest = text.replace(LEADING_GREETING, "").trim();
  if (!rest) return `${GOOGLE_ORIGIN_GREETING} ${DEFAULT_AD_MESSAGE}`;
  return `${GOOGLE_ORIGIN_GREETING} ${rest.charAt(0).toLocaleUpperCase("es-MX")}${rest.slice(1)}`;
}

/** Returns the same WhatsApp link with the greeting in its prefilled text; any other link is returned untouched. */
export function googleTaggedWhatsappHref(href: string, baseUrl = "https://canopenal.com/"): string {
  if (classifyContactHref(href, baseUrl) !== "whatsapp") return href;
  let url: URL;
  try {
    url = new URL(href.trim(), baseUrl);
  } catch {
    return href;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return href;
  const tagged = googleTaggedMessage(url.searchParams.get("text"));
  // Built by hand with encodeURIComponent: URLSearchParams would write spaces as "+".
  const params = [...url.searchParams]
    .filter(([key]) => key !== "text")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  params.push(`text=${encodeURIComponent(tagged)}`);
  return `${url.origin}${url.pathname}?${params.join("&")}${url.hash}`;
}

/** The WhatsApp link the contact forms open, tagged when the visit came from an ad. */
export function whatsappDestination(message: string, adVisit: boolean): string {
  return `${site.whatsapp}?text=${encodeURIComponent(adVisit ? googleTaggedMessage(message) : message)}`;
}

export function browserSessionStore(): SessionStore | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function isBrowserAdVisit(): boolean {
  try {
    return typeof window !== "undefined" && rememberAdVisit(window.location.search, browserSessionStore());
  } catch {
    return false;
  }
}
