import { describe, expect, it } from "vitest";
import {
  buildGoogleConsentModeDefaults,
  extractGoogleClickIds,
  type TrackingConsent,
} from "./index.js";

describe("runtime contract hardening", () => {
  it("rejects a consent object with a missing required decision", () => {
    const incomplete = {
      analyticsStorage: "granted",
      adStorage: "granted",
      adUserData: "granted",
    } as unknown as TrackingConsent;

    expect(() => buildGoogleConsentModeDefaults(incomplete)).toThrow(
      /adPersonalization must be granted or denied/u,
    );
  });

  it("treats Google click IDs as opaque values while still rejecting control characters", () => {
    expect(
      extractGoogleClickIds("https://example.com/?gclid=opaque%2Bvalue%3D%3D&wbraid=w%2B1%3D"),
    ).toEqual({ gclid: "opaque+value==", wbraid: "w+1=" });

    expect(() => extractGoogleClickIds("https://example.com/?gclid=bad%0Avalue")).toThrow(
      /control characters/u,
    );
    expect(() => extractGoogleClickIds("https://example.com/?gclid=bad%7Fvalue")).toThrow(
      /control characters/u,
    );
  });
});
