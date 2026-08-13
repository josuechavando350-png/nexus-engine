# V5 Authorization

Authentication and authorization are separate. `IdentityVerifier` proves a principal; `AuthorizationEngine` decides an action on a typed resource.

Baseline invariant: cross-organization access is denied before richer policy. Future OpenFGA/Cedar/OPA adapters may answer fine-grained questions, but they cannot redefine NEXUS resource identity or tenant isolation.

Actions are a closed enum: Read, Create, Update, Delete, Execute, Approve, Delegate, ManageSecrets, ManagePolicy, Audit.

No model/agent output grants permissions. Delegation from V4 cannot enlarge permissions.
