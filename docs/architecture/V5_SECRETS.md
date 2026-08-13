# V5 Secrets

The control plane stores and returns **references**, never secret plaintext. `SecretBroker` issues purpose-scoped leases. Provider adapters may target Vault or another secrets system selected during deployment research.

A future adapter must support revocation, TTL, audit linkage and rotation semantics. Static secrets in repository/config are prohibited.
