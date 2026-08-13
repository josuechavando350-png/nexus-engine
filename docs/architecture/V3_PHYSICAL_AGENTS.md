# NEXUS V3 — Physical Agents and Behaviour Models

## 1. The abstraction

```text
WorldState + TaskGoal + RobotCapabilities + SafetyEnvelope
        |
        v
   BehaviorModel  (trait)
        |
        v
    BehaviorPlan
```

`BehaviorModel` abstracts any physical behaviour model: a classical planner, a
scripted routine, or a learned policy served over a network. The runtime
depends on the trait, never on a particular model.

## 2. No pretend foundation model

`MockBehaviorModel` is the in-tree implementation. It is a deterministic
planner used by tests, the examples and CI, and it is described as exactly
that.

There is no large behaviour model in this repository and none is claimed. If
one is integrated later it implements the same trait and passes through the
same validation chain — which is the reason the chain is defined
model-independently.

## 3. A plan is not an authorisation

`BehaviorPlan` is never executed directly. It must pass, in order:

1. schema validation
2. policy validation
3. safety envelope check
4. simulation / dry run
5. `HumanApprovalGate` where applicable
6. signing as an `EdgeTask`

A model that emits a dangerous plan produces a denied task, not a dangerous
action. This is the design's central safety property: the model is untrusted
by construction, and no improvement in model quality is required for the
system to be safe.

## 4. Safety envelope

The envelope bounds the plan independently of what the model wanted:
permitted zones, maximum speed, workspace limits for manipulation, standoff
distances, maximum duration, and the conditions that force a safe stop.

`DetectionClass::PersonnelPresenceInRestrictedZone` and
`DetectionClass::Fire` force a safe stop regardless of the plan in flight.
Occupancy is treated as a stop condition and never as a tracking input: the
class carries no identity, no re-identification and no cross-frame tracking of
individuals. It exists so a robot can be told to stop, never so anything can
be told to follow.

A physical action with no safety envelope is denied by hard invariant.

## 5. Simulation

`nexus-sim` provides a minimal world model — facility, zone, robot, sensor,
obstacle, temperature source — sufficient to validate the chain without
hardware:

- deterministic replay
- dry run of a `BehaviorPlan`
- basic collision and constraint checks
- expected state transition
- failure injection

It is not a physics engine and is not represented as one. Passing simulation
means the plan is consistent with the modelled constraints; it does not mean
the plan is safe in the physical world. That is why simulation is one
precondition among several rather than the only gate.

## 6. Task adaptation

`RobotCapabilities` describes what a device can actually do. The same
`TaskGoal` produces different plans on different devices, and a goal a device
cannot satisfy is refused at proposal time rather than dispatched and failed
at the edge.
