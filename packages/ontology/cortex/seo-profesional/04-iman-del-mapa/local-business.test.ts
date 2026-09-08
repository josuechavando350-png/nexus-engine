import { describe, expect, it } from "vitest";
import {
  buildLocalBusinessJsonLd,
  createLocalBusinessPresenceSnapshot,
  createLocalBusinessProfile,
  serializeLocalBusinessJsonLd,
  type LocalBusinessProfile,
} from "./local-business.js";

function attorneyProfile(): LocalBusinessProfile {
  return {
    schemaType: "Attorney",
    name: "CANO </script> Estrategia Penal",
    websiteUri: "https://cano.example/",
    primaryPhone: "+52 55 1234 5678",
    email: "contacto@cano.example",
    storefrontAddress: {
      regionCode: "MX",
      addressLines: ["Montecito 38, piso 28, oficina 16"],
      locality: "Benito Juárez",
      administrativeArea: "CDMX",
      postalCode: "03810",
    },
    areaServed: ["Ciudad de México"],
    sameAs: ["https://www.linkedin.com/company/cano-example"],
    priceRange: "$$$",
    openingHours: [
      { dayOfWeek: "Monday", opens: "09:00", closes: "18:00" },
      { dayOfWeek: "Tuesday", opens: "09:00", closes: "18:00" },
    ],
  };
}

describe("Iman del Mapa LocalBusiness JSON-LD", () => {
  it("builds a bounded LocalBusiness subtype without inventing ratings or reviews", () => {
    const jsonLd = buildLocalBusinessJsonLd(attorneyProfile());
    expect(jsonLd).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Attorney",
      "@id": "https://cano.example/#local-business",
      url: "https://cano.example/",
      telephone: "+52 55 1234 5678",
      address: {
        "@type": "PostalAddress",
        streetAddress: "Montecito 38, piso 28, oficina 16",
        addressLocality: "Benito Juárez",
        addressRegion: "CDMX",
        postalCode: "03810",
        addressCountry: "MX",
      },
    });
    expect(jsonLd).not.toHaveProperty("aggregateRating");
    expect(jsonLd).not.toHaveProperty("review");
  });

  it("serializes JSON-LD safely for an application/ld+json script", () => {
    const serialized = serializeLocalBusinessJsonLd(attorneyProfile());
    expect(serialized).not.toContain("</script>");
    expect(serialized).toContain("\\u003c/script\\u003e");
    expect(JSON.parse(serialized)).toMatchObject({ "@type": "Attorney", name: "CANO </script> Estrategia Penal" });
  });

  it("creates a stable presence snapshot with canonical origin and digest", () => {
    const snapshot = createLocalBusinessPresenceSnapshot(attorneyProfile());
    expect(snapshot.canonicalWebsiteOrigin).toBe("https://cano.example");
    expect(snapshot.profileDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(snapshot.jsonLd).toEqual(buildLocalBusinessJsonLd(snapshot.profile));
  });

  it("allows a legitimate service-area business without publishing a storefront address", () => {
    const profile = createLocalBusinessProfile({
      schemaType: "HomeAndConstructionBusiness",
      name: "Servicio Autorizado",
      websiteUri: "https://service.example/",
      primaryPhone: "+52 55 5555 5555",
      areaServed: ["CDMX", "Estado de México"],
    });
    expect(profile.storefrontAddress).toBeUndefined();
    expect(buildLocalBusinessJsonLd(profile)).toMatchObject({ areaServed: ["CDMX", "Estado de México"] });
  });

  it("rejects unsupported schema types and profiles with neither storefront nor real service area", () => {
    expect(() => createLocalBusinessProfile({
      schemaType: "FakeBusiness" as never,
      name: "Fake",
      websiteUri: "https://fake.example/",
      areaServed: ["CDMX"],
    })).toThrow(/schemaType/u);

    expect(() => createLocalBusinessProfile({
      schemaType: "LocalBusiness",
      name: "No Location",
      websiteUri: "https://noloc.example/",
    })).toThrow(/storefrontAddress|areaServed/u);
  });

  it("rejects oversized sameAs input and unexpected profile fields before they can enter JSON-LD", () => {
    const tooMany = Array.from({ length: 21 }, (_, index) => `https://social.example/profile-${index}`);
    expect(() => createLocalBusinessProfile({
      schemaType: "LocalBusiness",
      name: "Bounded Business",
      websiteUri: "https://bounded.example/",
      areaServed: ["CDMX"],
      sameAs: tooMany,
    })).toThrow(/sameAs/u);

    expect(() => createLocalBusinessProfile({
      schemaType: "LocalBusiness",
      name: "No Hidden Fields",
      websiteUri: "https://bounded.example/",
      areaServed: ["CDMX"],
      aggregateRating: { ratingValue: 5 },
    } as never)).toThrow(/unsupported local business profile field aggregateRating/u);
  });
});
