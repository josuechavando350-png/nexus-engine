# V5 Trust Boundaries

1. Human/browser ↔ API gateway: untrusted input.
2. API ↔ IdentityVerifier: authentication boundary.
3. Principal ↔ AuthorizationEngine: authorization boundary.
4. Control plane ↔ registry: state mutation boundary with expected-version checks.
5. Control plane ↔ SecretBroker: reference/lease boundary; secret plaintext must not traverse generic control APIs.
6. Control plane ↔ V4/V3 runtime: administrative intent cannot bypass runtime policy/simulation/approval.
7. Control plane ↔ observability exporter: telemetry exporter cannot become source-of-truth evidence.
