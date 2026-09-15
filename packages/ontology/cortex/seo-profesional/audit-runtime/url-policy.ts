export class SeoAuditUrlPolicyError extends Error {
  constructor(public readonly code: "INVALID_CONFIG" | "URL_DENIED", message: string) {
    super(message);
    this.name = "SeoAuditUrlPolicyError";
  }
}

export function canonicalOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SeoAuditUrlPolicyError("INVALID_CONFIG", "canonicalOrigin must be an absolute HTTPS origin");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new SeoAuditUrlPolicyError("INVALID_CONFIG", "canonicalOrigin must be an HTTPS origin without credentials, path, query, or fragment");
  }
  return parsed.origin;
}

export class FirstPartySeoAuditUrlPolicy {
  readonly origin: string;

  constructor(value: string) {
    this.origin = canonicalOrigin(value);
  }

  authorize(value: string | URL): URL {
    let parsed: URL;
    try {
      parsed = value instanceof URL ? new URL(value.toString()) : new URL(value);
    } catch {
      throw new SeoAuditUrlPolicyError("URL_DENIED", "audit URL must be absolute");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.origin !== this.origin) {
      throw new SeoAuditUrlPolicyError("URL_DENIED", `audit URL must stay on the configured first-party origin ${this.origin}`);
    }
    parsed.hash = "";
    return parsed;
  }

  resolve(value: string, base: string | URL): URL {
    let parsed: URL;
    try {
      parsed = new URL(value, base);
    } catch {
      throw new SeoAuditUrlPolicyError("URL_DENIED", "discovered URL is malformed");
    }
    return this.authorize(parsed);
  }
}
