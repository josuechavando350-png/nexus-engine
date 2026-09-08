import { describe, expect, it } from "vitest";
import {
  createAdPersonalizationPolicy,
  personalizeAdContext,
  personalizeAdContextWithControl,
  recordAdPersonalizationDecision,
  renderPersonalizedLandingDocument,
  type AdPersonalizationControlConfig,
} from "./personalization";

const CONTROL: AdPersonalizationControlConfig = {
  endpoint: "https://control.example",
  token: "edge-token-00000000000000000000000000000000",
  timeoutMs: 350,
  telemetryTimeoutMs: 250,
};
const DIGEST = `sha256:${"a".repeat(64)}`;

function policy(mode: "ACTIVE" | "OBSERVE_ONLY" | "KILLED" = "ACTIVE") {
  return createAdPersonalizationPolicy({
    version: 1,
    languageTag: "es-MX",
    adContext: {
      policyId: "edge-personalization-v1",
      mode,
      defaultExperienceId: "default",
      paidSearchExperienceId: "paid-search",
      paidSocialExperienceId: "paid-social",
      allowedExperienceIds: ["default", "paid-search", "paid-social"],
      exactRules: [{ ruleId: "brand-search", experienceId: "paid-search", source: "google", medium: "cpc", campaign: "brand" }],
    },
    blocks: [
      { blockId: "proof", heading: "Prueba verificable", body: "Resultados y señales aprobadas por el negocio.", bullets: ["Sin copiar identificadores publicitarios al HTML."] },
      { blockId: "services", heading: "Servicios", body: "Opciones predeclaradas para esta experiencia." },
      { blockId: "contact", heading: "Contacto", body: "El siguiente paso usa una ruta interna controlada." },
    ],
    profiles: [
      { experienceId: "default", headline: "Experiencia general", subheadline: "Propuesta verificada para tráfico directo.", ctaLabel: "Contactar", ctaHref: "/contact", blockOrder: ["proof", "services", "contact"], layoutProfileId: "standard" },
      { experienceId: "paid-search", headline: "Experiencia de búsqueda", subheadline: "Propuesta predeclarada para intención de búsqueda pagada.", ctaLabel: "Ver opciones", ctaHref: "/contact?source=paid-search", blockOrder: ["services", "proof", "contact"], layoutProfileId: "intent-first" },
      { experienceId: "paid-social", headline: "Experiencia social", subheadline: "Propuesta predeclarada para contexto social pagado.", ctaLabel: "Explorar", ctaHref: "/contact?source=paid-social", blockOrder: ["proof", "contact", "services"], layoutProfileId: "proof-first" },
    ],
  });
}

function runtimeResponse(mode: "ACTIVE" | "OBSERVE_ONLY" | "KILLED", policyId = "edge-personalization-v1", revision = 7): Response {
  return new Response(JSON.stringify({ policyId, mode, revision, digest: DIGEST }), {
    status: 200,
    headers: { "content-type": "application/json", "content-length": "151" },
  });
}

describe("CORTEX #27 governed ad-context personalization", () => {
  it("renders real predeclared blocks in campaign-selected order without reflecting ad identifiers", () => {
    const decision = personalizeAdContext("https://example.test/?utm_source=google&utm_medium=cpc&utm_campaign=brand&gclid=secret-click-id", policy());
    expect(decision.context).toMatchObject({ experienceId: "paid-search", ruleId: "brand-search", applied: true });
    expect(decision.profile).toMatchObject({ headline: "Experiencia de búsqueda", layoutProfileId: "intent-first" });
    expect(decision.blocks.map((block) => block.blockId)).toEqual(["services", "proof", "contact"]);

    const html = renderPersonalizedLandingDocument(decision);
    expect(html).toContain("<h2>Servicios</h2>");
    expect(html).toContain("Opciones predeclaradas para esta experiencia.");
    expect(html).toContain('href="/contact?source=paid-search"');
    expect(html.indexOf('data-block="services"')).toBeLessThan(html.indexOf('data-block="proof"'));
    expect(html).not.toContain("secret-click-id");
    expect(html).not.toContain("utm_source");
    expect(html).not.toContain("brand-search");
  });

  it("keeps KILLED and OBSERVE_ONLY on default rendered content", () => {
    const killed = personalizeAdContext("https://example.test/?gclid=secret-click-id", policy("KILLED"));
    expect(killed.context).toMatchObject({ reason: "KILL_SWITCH", experienceId: "default", applied: false });
    expect(renderPersonalizedLandingDocument(killed)).toContain("Experiencia general");

    const observed = personalizeAdContext("https://example.test/?gclid=secret-click-id", policy("OBSERVE_ONLY"));
    expect(observed.context).toMatchObject({ reason: "OBSERVE_ONLY_MATCH", experienceId: "default", wouldApplyExperienceId: "paid-search", applied: false });
    expect(renderPersonalizedLandingDocument(observed)).not.toContain("Experiencia de búsqueda");
  });

  it("rejects unknown fields, arbitrary external CTAs, unknown block references and disconnected blocks", () => {
    const base = {
      version: 1 as const,
      languageTag: "es-MX",
      adContext: { policyId: "p", mode: "ACTIVE" as const, defaultExperienceId: "default", allowedExperienceIds: ["default"] },
      blocks: [{ blockId: "content", heading: "Heading", body: "Body" }],
      profiles: [{ experienceId: "default", headline: "Default", subheadline: "Copy", ctaLabel: "Go", ctaHref: "/contact", blockOrder: ["content"], layoutProfileId: "standard" }],
    };
    expect(() => createAdPersonalizationPolicy({ ...base, extra: true } as never)).toThrowError(/unexpected field/u);
    expect(() => createAdPersonalizationPolicy({ ...base, profiles: [{ ...base.profiles[0]!, ctaHref: "https://evil.example" }] })).toThrowError(/root-relative/u);
    expect(() => createAdPersonalizationPolicy({ ...base, profiles: [{ ...base.profiles[0]!, blockOrder: ["missing"] }] })).toThrowError(/unknown block/u);
    expect(() => createAdPersonalizationPolicy({ ...base, blocks: [...base.blocks, { blockId: "unused", heading: "Unused", body: "Unused" }] })).toThrowError(/disconnected/u);
  });

  it("uses the durable remote mode at the final decision boundary and fails closed when control is unavailable", async () => {
    const killed = await personalizeAdContextWithControl(
      "https://example.test/?gclid=secret-click-id",
      policy(),
      CONTROL,
      async () => runtimeResponse("KILLED"),
    );
    expect(killed.control).toEqual({ mode: "KILLED", source: "REMOTE", revision: 7 });
    expect(killed.decision.context).toMatchObject({ reason: "KILL_SWITCH", experienceId: "default" });

    const recovered = await personalizeAdContextWithControl(
      "https://example.test/?gclid=secret-click-id",
      policy(),
      CONTROL,
      async () => runtimeResponse("ACTIVE", "edge-personalization-v1", 8),
    );
    expect(recovered.control).toEqual({ mode: "ACTIVE", source: "REMOTE", revision: 8 });
    expect(recovered.decision.context.experienceId).toBe("paid-search");

    const unavailable = await personalizeAdContextWithControl(
      "https://example.test/?gclid=secret-click-id",
      policy(),
      CONTROL,
      async () => { throw new Error("network unavailable"); },
    );
    expect(unavailable.control).toEqual({ mode: "KILLED", source: "FAIL_CLOSED", revision: null });
    expect(unavailable.decision.context.reason).toBe("KILL_SWITCH");
  });

  it("never lets remote control weaken a locally restricted mode and rejects a mismatched controller policy", async () => {
    const localKilled = await personalizeAdContextWithControl("https://example.test/?gclid=x", policy("KILLED"), CONTROL, async () => runtimeResponse("ACTIVE"));
    expect(localKilled.control.mode).toBe("KILLED");
    expect(localKilled.decision.context.reason).toBe("KILL_SWITCH");

    const mismatch = await personalizeAdContextWithControl("https://example.test/?gclid=x", policy(), CONTROL, async () => runtimeResponse("ACTIVE", "other-policy"));
    expect(mismatch.control).toEqual({ mode: "KILLED", source: "FAIL_CLOSED", revision: null });
  });

  it("records only bounded structured decision telemetry and never the raw request context", async () => {
    const decision = personalizeAdContext("https://example.test/?utm_source=google&utm_medium=cpc&utm_campaign=brand&gclid=secret-click-id", policy());
    let requestUrl = "";
    let body = "";
    await recordAdPersonalizationDecision(
      decision,
      CONTROL,
      async (input, init) => {
        requestUrl = String(input);
        body = String(init?.body ?? "");
        return new Response(JSON.stringify({ accepted: true }), { status: 202, headers: { "content-type": "application/json" } });
      },
      () => new Date("2026-09-08T00:00:00.000Z"),
    );
    expect(requestUrl).toBe("https://control.example/v1/ad-context/observe");
    expect(JSON.parse(body)).toEqual({
      policyId: "edge-personalization-v1",
      mode: "ACTIVE",
      channel: "PAID_SEARCH",
      reason: "EXACT_RULE_MATCH",
      applied: true,
      observedAt: "2026-09-08T00:00:00.000Z",
    });
    expect(body).not.toContain("secret-click-id");
    expect(body).not.toContain("brand");
  });
});
