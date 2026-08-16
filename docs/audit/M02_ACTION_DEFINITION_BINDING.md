# M-02 — Action policy definition binding

Policies must fail closed when an action keeps the same id but its executable definition changes.

The active policy now carries an `actionDefinitionId` derived deterministically from the complete `ActionType`. Authorization compares that binding against the active schema action before permission or approval evaluation. Reusing only an `actionId` is insufficient.

Behavioral coverage includes direct authorization and executor-level regression tests proving a stale policy cannot authorize an action whose permission/definition changed while retaining the same action id.
