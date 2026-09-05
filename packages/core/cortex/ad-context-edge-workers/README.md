# CORTEX #7 — Ad-Context Edge Workers

CORTEX #7 evaluates advertising context at the HTTP edge and selects only predeclared landing experiences. It never turns query-string content into copy.

## Runtime contract

The edge-safe engine consumes a URL plus a validated policy. It recognizes bounded UTM fields and the presence of common advertising click identifiers. Raw click-identifier values, UTM values and arbitrary query text are never returned by the decision object, persisted, hashed for identity, or reflected into HTML.

Recognized Google/Bing click signals and approved source/medium combinations can classify a request as paid search. Recognized Meta/TikTok click signals and approved source/medium combinations can classify a request as paid social. Conflicting channel evidence fails to the deterministic default experience.

Exact campaign routing is possible only through server-controlled rules whose experience IDs are allowlisted at policy construction. Duplicate recognized parameters, oversized query strings, oversized values and malformed context fall back rather than selecting a personalized experience.

## Control plane

- `ACTIVE`: a governed candidate experience may be applied.
- `OBSERVE_ONLY`: classification occurs, but the default experience is served while the candidate remains available as non-user-controlled decision metadata.
- `KILLED`: all requests receive the deterministic default experience.

Invalid runtime-mode configuration in CANO is interpreted as `KILLED`.

## CANO production integration

`apps/cano-penal/src/middleware.ts` runs the policy on the real incoming landing request. It overwrites any client-supplied internal context headers, passes only safe internal enums/IDs downstream and emits safe response headers for operational measurement. Applied variants receive `Cache-Control: private, no-store, max-age=0` to prevent personalized HTML from leaking through shared caches.

The CANO home route is explicitly configured for the Edge runtime. It reads only the internal experience ID and maps it to fixed compiled copy. Unknown IDs fall back to the existing production hero. The rendered hero includes `data-nexus-ad-experience` so browser/analytics tooling can measure which governed experience was actually served without exposing the originating click ID.

The initial CANO policy deliberately contains no invented campaign names. It activates the paid-search experience from real Google Ads click signals (`gclid`, `gbraid`, `wbraid`) or approved Google paid-search UTM classification. Exact campaign rules can be added later only when real campaign identifiers are available.
