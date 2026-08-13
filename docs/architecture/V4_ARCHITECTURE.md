# NEXUS V4 — Autonomous Intelligence Engine

V4 adds a cognitive plane above V3 without adding a second physical execution path.

```text
observations / ontology / provenance
        -> memory
        -> persistent goal
        -> planner candidates
        -> world branches + simulation
        -> evaluator / replanning / recovery
        -> CognitiveDecision
        -> V3 policy -> simulation -> approval -> signed EdgeTask -> sandbox
```

The V4 crates own cognitive semantics; external model, memory-index and durable-execution products remain adapters. `nexus-intelligence` intentionally has no dependency on `nexus-edge-protocol`.

## Invariants
- model text is never an action;
- evidence is required before autonomous plan preparation;
- memory records require provenance;
- simulated facts never become observations implicitly;
- replay never permits physical dispatch;
- delegation cannot increase capabilities;
- V3 policy/approval/edge gates remain the only physical execution path.
