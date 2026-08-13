export const NEXUS_SECURITY_HEADERS_BASE = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
] as const;

/**
 * @status core
 *
 * Generic Content-Security-Policy baseline, structured by directive so a
 * Client Experience can extend it safely (add sources for Maps,
 * analytics, multimedia, fonts, third-party APIs...) without weakening
 * Core's restrictive defaults globally. Added in NEXUS V1.2 — see
 * "SECURE BY DEFAULT. EXTENSIBLE BY NECESSITY." in the hardening report.
 *
 * Intentionally free of client-specific directives (no domains, no
 * script/style sources). Client Experience extends this via buildCsp(),
 * never by hand-writing a parallel CSP string.
 */
export const NEXUS_CSP_DIRECTIVES_BASE: Readonly<Record<string, readonly string[]>> = {
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "frame-ancestors": ["'self'"],
  "object-src": ["'none'"]
};

/**
 * Merges Experience-specific source lists into the Core CSP baseline,
 * per directive, and serializes the result to a header-ready string.
 *
 * Additive only: an extension can ADD sources to a directive (e.g. add
 * a Maps origin to `connect-src`), it can never remove a source Core
 * already declared. Whether to add something permissive (like
 * `'unsafe-inline'`) is the Experience's own decision — Core does not
 * block it, but does not make it the path of least resistance either.
 *
 * @example
 * buildCsp({ "connect-src": ["https://maps.googleapis.com"] })
 */
export function buildCsp(
  extensions: Partial<Record<string, readonly string[]>> = {}
): string {
  const directives = new Map<string, Set<string>>();

  for (const [key, values] of Object.entries(NEXUS_CSP_DIRECTIVES_BASE)) {
    directives.set(key, new Set(values));
  }

  for (const [key, values] of Object.entries(extensions)) {
    if (!values) continue;
    const existing = directives.get(key) ?? new Set<string>();
    for (const value of values) existing.add(value);
    directives.set(key, existing);
  }

  return Array.from(directives.entries())
    .map(([key, values]) => `${key} ${Array.from(values).join(" ")}`)
    .join("; ");
}

/**
 * Precomputed baseline string, equivalent to `buildCsp()` with no
 * extensions. Kept for backward compatibility with any consumer that
 * already references the flat string form.
 */
export const NEXUS_CSP_BASE = buildCsp();
