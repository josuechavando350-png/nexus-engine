import { assertUiAgnostic } from "./shared";

export type JourneyRole = "discovery" | "trust" | "conversion" | "utility" | "proof" | "retention";

export type CapabilityDefinition = {
  id: string;
  name: string;
  outcome: string;
  primaryActor: string;
  journeyRoles: readonly JourneyRole[];
  dataNeeds: readonly string[];
  dependencies?: readonly string[];
  constraints?: readonly string[];
  criticality: "essential" | "supporting" | "optional";
};

export function defineCapability(input: CapabilityDefinition): CapabilityDefinition {
  assertUiAgnostic(input, `Capability(${input.id || "unknown"})`);
  if (!input.id.trim()) throw new Error("Capability.id is required.");
  if (!input.outcome.trim()) throw new Error(`Capability ${input.id} requires an outcome.`);
  if (!input.journeyRoles.length) throw new Error(`Capability ${input.id} requires at least one journeyRole.`);
  return Object.freeze(input);
}

const cap = (
  id: string,
  name: string,
  outcome: string,
  journeyRoles: readonly JourneyRole[],
  criticality: CapabilityDefinition["criticality"] = "supporting"
) => defineCapability({
  id,
  name,
  outcome,
  primaryActor: "visitor",
  journeyRoles,
  dataNeeds: [],
  criticality
});

export const STANDARD_CAPABILITIES: Readonly<Record<string, CapabilityDefinition>> = Object.freeze({
  contact: cap("contact", "Contact", "Let a qualified visitor reach the business.", ["conversion", "utility"], "essential"),
  whatsapp: cap("whatsapp", "WhatsApp", "Start a WhatsApp conversation with context.", ["conversion", "utility"], "essential"),
  booking: cap("booking", "Booking", "Reserve an appointment or time slot.", ["conversion", "utility"], "essential"),
  reservation: cap("reservation", "Reservation", "Reserve capacity for a date or service.", ["conversion", "utility"], "essential"),
  menu: cap("menu", "Menu", "Understand available food/drink offerings.", ["discovery", "conversion"]),
  catalog: cap("catalog", "Catalog", "Explore a structured set of offerings.", ["discovery", "conversion"]),
  gallery: cap("gallery", "Gallery", "Build confidence through visual evidence.", ["discovery", "proof"]),
  location: cap("location", "Location", "Understand where the business is and how to arrive.", ["utility", "trust"]),
  map: cap("map", "Map", "Explore geographic context or directions.", ["utility"]),
  reviews: cap("reviews", "Reviews", "Evaluate third-party or customer proof.", ["proof", "trust"]),
  "lead-capture": cap("lead-capture", "Lead capture", "Capture a qualified prospect for follow-up.", ["conversion"], "essential"),
  "quote-request": cap("quote-request", "Quote request", "Collect enough context to prepare a quote.", ["conversion", "utility"], "essential"),
  ecommerce: cap("ecommerce", "Ecommerce", "Complete a purchase transaction.", ["conversion", "retention"], "essential"),
  analytics: cap("analytics", "Analytics", "Measure meaningful business behavior.", ["proof", "retention"], "optional"),
  search: cap("search", "Search", "Find a known item or answer quickly.", ["utility", "discovery"]),
  authentication: cap("authentication", "Authentication", "Enter a protected or personalized area.", ["utility", "retention"], "essential"),
  "crm-integration": cap("crm-integration", "CRM integration", "Route qualified customer data into business operations.", ["retention"], "supporting"),
  forms: cap("forms", "Forms", "Collect structured visitor input.", ["conversion", "utility"]),
  media: cap("media", "Media", "Communicate meaning through optimized visual/audio assets.", ["discovery", "proof"]),
  video: cap("video", "Video", "Communicate motion, process, atmosphere, or proof.", ["discovery", "proof"]),
  "social-proof": cap("social-proof", "Social proof", "Reduce uncertainty with credible external evidence.", ["proof", "trust"])
});

export function resolveCapabilities(ids: readonly string[]): CapabilityDefinition[] {
  return ids.map((id) => {
    const capability = STANDARD_CAPABILITIES[id];
    if (!capability) throw new Error(`Unknown capability id: ${id}`);
    return capability;
  });
}
