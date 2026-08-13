# NEXUS V3 — Orchestration

## 1. Pipeline

```text
Graph state + incoming observations + policies + model outputs
        |
        v
   TaskProposal
        |
        v
   PolicyEngine
        |
        +--> Denied
        +--> RequiresApproval --> HumanApprovalGate --> Denied | Approved
        +--> Allowed
                    |
                    v
              simulation dry run
                    |
                    v
              signed EdgeTask
```

The orchestrator never sends bytes to a device. It emits an `EdgeTask` built
from the typed command set in `nexus-edge-protocol`. There is no field into
which arbitrary payload can be placed.

## 2. Permitted actions

```text
inspect zone                 capture sensor sample
navigate to waypoint         collect image
stop (safe stop)             collect thermal reading
return to base               run diagnostic
manipulate industrial fixture inside a defined workspace
```

`ActionKind` classifies each as read-only or physical. `SafeStop` is
deliberately *not* physical for the purpose of preconditions: requiring a
simulation pass before a robot is allowed to stop would be a safety defect,
not a control. Stopping is always permitted.

## 3. Policy evaluation

Two layers, fixed order.

**Layer 1 — hard invariants.** Non-configurable, evaluated first, can only
deny:

| Invariant | Denies |
|---|---|
| `no_weapon_capability` | Weapon, munition, ordnance, fire-control terms anywhere in the request |
| `no_human_targeting` | Targeting, tracking, pursuit, biometric identification of people |
| `no_expired_command` | Anything past `expires_at` |
| `no_unknown_signer` | A signer outside the trusted set |
| `no_replayed_nonce` | A nonce already observed |
| `no_unsupported_capability` | A capability the device does not declare |
| `no_high_impact_without_approval` | High-impact action with no recorded approval |
| `no_physical_action_without_simulation` | Physical action that has not passed a dry run |
| `no_action_without_safety_envelope` | Physical action with no safety envelope |

Prohibited-term matching is substring-based across the action name, the zone,
every requested capability and every free-text intent annotation, in any
casing. Blunt on purpose: a false positive costs a rename in review, a false
negative would put a weapon capability on a device.

**Layer 2 — configurable rules.** Device capability, zone, action kind, time
window (wrapping past midnight correctly), operator role, risk class,
simulation result, task expiry. First match wins.

**The engine fails closed.** An action matching no rule is denied. A test
asserts that a rule set containing nothing but "allow everything" still cannot
get a weapons request or an unapproved high-impact action past layer 1.

## 4. HumanApprovalGate

Approvals are requests with an identity, an expiry and an approver role, and
they are recorded in the audit trail before the task is signed. An approval
that has expired is not an approval. An approval granted by an identity
lacking the required role is refused.

The gate is mandatory for anything `high_impact` and for any action a rule
marks `RequireApproval`. A recorded approval upgrades a `RequiresApproval`
decision to `Allowed`; it can never upgrade a `Denied` one.

## 5. Simulation as a precondition

A `BehaviorPlan` is never executed directly. It passes schema validation,
policy validation, the safety envelope, a `nexus-sim` dry run, the approval
gate where applicable, and only then is signed as an `EdgeTask`.

The dry run predicts the resulting world state and reports collisions and
constraint violations. A failed simulation is a hard denial through
`no_physical_action_without_simulation`.

## 6. Audit

Every stage writes to the hash-chained trail before the next begins:
`task_proposed`, `policy_evaluated`, `approval_requested`, `approval_granted`
or `approval_denied`, `simulation_run`, `task_signed`, `task_dispatched`,
`task_executed` or `task_failed`.

Filtering by `trace_id` returns the complete causal chain for one incident,
from the sensor reading to the execution result.
