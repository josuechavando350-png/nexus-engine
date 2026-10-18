import type { SeoAuditHttpPort, SeoAuditHttpResponse } from "./contracts.js";
import { FirstPartySeoAuditUrlPolicy } from "./url-policy.js";

export class SeoAuditHttpAdapterError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "FETCH_FAILED" | "REDIRECT_DENIED", message: string) {
    super(message);
    this.name = "SeoAuditHttpAdapterError";
  }
}

export class FirstPartyFetchSeoAuditAdapter implements SeoAuditHttpPort {
  private readonly policy: FirstPartySeoAuditUrlPolicy;

  constructor(canonicalOrigin: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.policy = new FirstPartySeoAuditUrlPolicy(canonicalOrigin);
    if (typeof fetchImpl !== "function") throw new SeoAuditHttpAdapterError("INVALID_INPUT", "fetch implementation is required");
  }

  async fetch(url: string, init: Readonly<{ userAgent: string; timeoutMs: number }>): Promise<SeoAuditHttpResponse> {
    if (!init || typeof init.userAgent !== "string" || !init.userAgent.trim() ||
      !Number.isSafeInteger(init.timeoutMs) || init.timeoutMs < 1_000 || init.timeoutMs > 30_000) {
      throw new SeoAuditHttpAdapterError("INVALID_INPUT", "SEO audit HTTP options are invalid");
    }
    let current = this.policy.authorize(url);

    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), init.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "user-agent": init.userAgent,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.1",
          },
        });
      } catch (error) {
        throw new SeoAuditHttpAdapterError("FETCH_FAILED", `SEO audit request failed: ${error instanceof Error ? error.message : "unknown error"}`);
      } finally {
        clearTimeout(timer);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return this.wrap(response);
        if (redirect === 5) throw new SeoAuditHttpAdapterError("FETCH_FAILED", "SEO audit request exceeded five redirects");
        try {
          current = this.policy.resolve(location, current);
        } catch {
          throw new SeoAuditHttpAdapterError("REDIRECT_DENIED", "cross-origin or invalid redirect was denied by the SEO audit boundary");
        }
        continue;
      }
      return this.wrap(response);
    }
    throw new SeoAuditHttpAdapterError("FETCH_FAILED", "unreachable redirect state");
  }

  private wrap(response: Response): SeoAuditHttpResponse {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    return Object.freeze({
      status: response.status,
      url: response.url,
      headers: Object.freeze(headers),
      text: () => response.text(),
    });
  }
}
