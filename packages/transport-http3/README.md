# @nexus/transport-http3

Deterministic HTTP/3 + QUIC + 103 Early Hints capability for NEXUS.

## Trust boundary

Configuration is not evidence. A `PASS` is issued only from an observation that records all of the following:

- the probe was actually available;
- HTTP/3 was observed (no HTTP/2 or HTTP/1.1 fallback);
- an informational `103` status was observed;
- every configured Link hint was present in the 103 response;
- every configured Link hint was also present in the final response;
- the final response status was successful (2xx/3xx).

If the live probe is unavailable, the result is `UNAVAILABLE`, never `PASS`. `curlHttp3OnlyCommand()` intentionally uses `curl --http3-only` so failed QUIC negotiation cannot silently fall back to an earlier HTTP version.

`writeNodeEarlyHints()` uses Node's `response.writeEarlyHints()` surface for origins that emit 103 directly. Edge/CDN deployment remains infrastructure-specific; this package does not claim application code can force UDP/443 or HTTP/3 support on an incompatible host.

0-RTT remains disabled by default because replay-safety is an application/infrastructure decision and is not inferred by NEXUS.

## Standards

- RFC 9114: HTTP/3 maps HTTP semantics onto QUIC.
- RFC 8297: 103 Early Hints is informational and its fields do not replace the final response fields.
