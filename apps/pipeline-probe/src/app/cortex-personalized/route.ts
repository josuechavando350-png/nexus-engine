import {
  createAdPersonalizationPolicy,
  personalizeAdContextWithControl,
  recordAdPersonalizationDecision,
  renderPersonalizedLandingDocument,
  type AdPersonalizationControlConfig,
  type AdPersonalizationPolicyInput,
} from "@nexus/core/cortex/ad-context-edge-personalization";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const MAX_POLICY_BYTES = 64 * 1024;

function policyFromEnvironment(): ReturnType<typeof createAdPersonalizationPolicy> {
  const raw = process.env.NEXUS_CORTEX_27_POLICY_JSON?.trim();
  if (!raw) throw new Error("NEXUS_CORTEX_27_POLICY_JSON is required");
  if (new TextEncoder().encode(raw).byteLength > MAX_POLICY_BYTES) throw new Error(`NEXUS_CORTEX_27_POLICY_JSON must be <= ${MAX_POLICY_BYTES} bytes`);
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch { throw new Error("NEXUS_CORTEX_27_POLICY_JSON contains malformed JSON"); }
  return createAdPersonalizationPolicy(parsed as AdPersonalizationPolicyInput);
}

function controlFromEnvironment(): AdPersonalizationControlConfig | null {
  const endpoint = process.env.NEXUS_AD_CONTEXT_CONTROL_ENDPOINT?.trim();
  const token = process.env.NEXUS_AD_CONTEXT_EDGE_TOKEN?.trim();
  if (!endpoint || !token) return null;
  return { endpoint, token, timeoutMs: 350, telemetryTimeoutMs: 250 };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const policy = policyFromEnvironment();
    const controlConfig = controlFromEnvironment();
    const resolved = await personalizeAdContextWithControl(request.url, policy, controlConfig);
    const html = renderPersonalizedLandingDocument(resolved.decision);
    await recordAdPersonalizationDecision(resolved.decision, controlConfig);
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-language": resolved.decision.languageTag,
        "cache-control": "private, no-store",
        "content-security-policy": "default-src 'none'; style-src 'none'; img-src 'none'; script-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-nexus-cortex-27-experience": resolved.decision.profile.experienceId,
        "x-nexus-cortex-27-context-reason": resolved.decision.context.reason,
        "x-nexus-cortex-27-runtime-mode": resolved.control.mode,
        "x-nexus-cortex-27-control-source": resolved.control.source,
      },
    });
  } catch {
    return Response.json({ error: "PERSONALIZATION_UNAVAILABLE" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
