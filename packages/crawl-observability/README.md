# @nexus/crawl-observability

Evidence-bound crawl diagnostics from normalized server or edge access observations.

## Trust boundary

This package does **not** claim that a URL is indexed, ranked, selected for a result, or even fetched by a verified search-engine identity merely because a user-agent string says so. `actor` is upstream classification metadata and the assessment is explicitly marked `OBSERVED_SERVER_OR_EDGE_REQUEST_DIAGNOSTIC_NOT_SEARCH_ENGINE_INDEXING_OR_RANKING_EVIDENCE`.

`SERVER_ACCESS_LOG` and `EDGE_LOG` observations are treated as operational observations supplied by the caller. `CONTROLLED_TEST` exists only for tests. Missing logs are not synthesized: the operational consumer reports `UNAVAILABLE`.

## Operational consumer

```bash
node scripts/audit-crawl-observability.mjs \
  --input /path/to/normalized-access.ndjson \
  --site https://example.com \
  --start 2026-08-30T00:00:00Z \
  --end 2026-08-31T00:00:00Z
```

Each NDJSON line must contain only the normalized observation fields accepted by `parseObservationJsonLine()`. The package validates bounds, same-origin scope, observation windows, HTTP status semantics, optional redirect semantics, replay digests and the final assessment digest.

The analyzer surfaces observed search-bot 4xx/5xx responses, long redirect paths/loops, slow responses, robots-attribution conflicts and insufficient search-bot evidence. It fails closed on malformed or tampered evidence.
