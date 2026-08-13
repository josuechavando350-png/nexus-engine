# V5 Threat Model

Assets: tenant resources, identities, permissions, secret references, audit evidence, control commands, cost records.

Threats: tenant breakout, IDOR, confused deputy, privilege escalation, stale authorization, replayed mutations, stolen sessions, workload impersonation, malicious admin, secret-reference abuse, audit deletion, compromised authz adapter, poisoned control-plane state, cost spoofing, API enumeration and supply-chain compromise.

Controls in candidate: organization encoded in every resource reference; baseline cross-tenant deny; closed action enum; versioned API; optimistic concurrency; audit on allowed/denied mutation path; secret references without plaintext; provider-neutral identity/authz ports.

Not yet proven: cryptographic authentication, distributed cache consistency, external audit anchoring, rate limiting, HA, storage durability, actual FGA adapter security. These remain NOT TESTED/NOT IMPLEMENTED, not marketing claims.
