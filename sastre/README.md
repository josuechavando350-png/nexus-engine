# Sastre Live Market V1 — live, bounded site evidence

This is the first **working site-observation slice**, not the finished autonomous market researcher, digital twin, lead predictor, or commercial optimizer. It performs a new HTTP capture on each run. No production client is activated or modified.

## Run

Requires Nexus Node >=24. Use a request file outside the source repository:

```json
{
  "scope": { "tenantId": "probe", "organizationId": "probe", "brandId": "probe" },
  "target": { "id": "client", "url": "https://example.com/" },
  "competitors": [{ "id": "competitor-a", "url": "https://example.org/" }]
}
```

```bash
node sastre/cli.mjs /path/to/market-request.json > /path/to/market-report.json
node --test sastre/live-market.test.mjs
```

The sample URLs are **not** an executed customer audit. The caller supplies known competitor origins; V1 cannot discover the market from a business/industry/city prompt. The input requires no Search Console, Ads or CRM history. A run with zero competitors is honestly `INSUFFICIENT_MARKET_COVERAGE` (exit 2), not zero market demand. `PARTIAL` also exits 2; a blocking failure exits 1.

## Evidence and boundaries

- Reuses Nexus's public-HTTP DNS pinning and private-IP/SSRF rejection from `packages/entity-intelligence/src/competitive-public-http.ts`.
- Reads each site's `robots.txt` before capture and only expands to its same-origin `sitemap.xml` URLs. Unknown/unsupported robots instructions are treated conservatively; no robots access means no capture. A missing sitemap permits homepage-only analysis and is disclosed. Every same-origin redirect destination is also checked against the observed robots policy **before** fetching it; live capture refuses injected discovery.
- Captures at most five pages per origin and five known competitors per run. Captures reject cross-origin redirects, non-HTML bodies, oversized responses and timeouts.
- Each page retains the URL, title, description, visible-term summary, raw-body SHA-256 and observation digest. A failed extra-page capture is disclosed; a failed homepage blocks the run. Synthetic injected test transport cannot be labeled observed HTTP.
- `lexicalGaps` are only terms observed on competitor pages but absent from the captured client pages. They are **not** keyword volumes, ranking data, qualified leads, opportunities, causal claims or client forecasts. Sitemaps are incomplete by nature and absence from a captured page is not proof of absence from a site.
- `reportDigest` hashes the JSON report body before the digest field is added; a SHA-256 checksum is tamper detection, **not independent attestation** of web content or proof that a competing business gets customers.
- Nine controlled native tests include blocked redirects, cancellation and evidence isolation. They do not constitute a live production audit.

## Next distinct capabilities (not part of V1)

Autonomous source/competitor discovery from a niche and location; structured HTML/rendered-page forensics; query-demand evidence from permitted sources; the market twin, Gauss/Axioma commercial scenario calibration; Avengers integration; actual qualified lead/contract feedback. No Google SERP scraping, production site mutation, ranking or customer guarantees are implemented here.
