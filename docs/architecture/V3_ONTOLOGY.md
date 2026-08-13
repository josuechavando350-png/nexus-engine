# NEXUS V3 — Ontology and Knowledge Graph

## 1. Position

`nexus-ontology` defines what the system knows. It does not know where that
knowledge is stored. No type, string or dependency in the crate names a
database, a driver, a connection string or a query language, and CI fails the
build if one appears.

`nexus-graph` holds the backends: an in-memory store (default), Cypher
generation, and a Neo4j/Memgraph adapter behind a feature.

## 2. Entities

Closed set, non-military by construction:

```text
Asset  Sensor  Camera  Robot  Vehicle  Facility  Zone
Observation  Detection  Incident  Task  Operator  Policy  Model  TelemetryStream
```

There is no `Target`, `Threat`, `Combatant` or `PersonOfInterest` kind, and
`EntityKind::parse` rejects them rather than accepting an unknown label.

## 3. Relationships

```text
LOCATED_IN  OBSERVED_BY  REPORTED  DERIVED_FROM  ASSIGNED_TO
GENERATED   DEPENDS_ON   VIOLATES  APPROVED_BY   EXECUTED_BY
SAME_AS     CONCERNS
```

Each declares which `(from_kind, to_kind)` pairs are legal.
`Relationship::validate` enforces it, so a bad correlation cannot quietly
create nonsense topology — an `Operator LOCATED_IN Asset` edge is refused.

## 4. Provenance

Every node and edge carries `Provenance`: originating `event_id`, `source_id`,
`trace_id`, the integrity hash of the originating envelope, the pipeline stage
that wrote it, and a confidence in `0.0..=1.0`.

This is what makes lineage answerable. Given an incident, `lineage()` walks
`DERIVED_FROM`, `GENERATED` and `OBSERVED_BY` back to the frames and readings
that produced it, and each step names the producer and the event.

## 5. Temporal facts

Properties are versioned. `set_property` closes the previous fact's validity
interval instead of overwriting it, so the graph answers *what did we believe
at 14:03* and not only *what do we believe now*. Intervals are half-open:
`[valid_from, valid_to)`.

## 6. Entity resolution

```text
Raw event -> normalize -> candidates -> resolve -> enrich -> mutations -> commit
```

### Deterministic, not theatrical

There is no learned matcher and none is implied. Matching is a set of named
rules with fixed, documented weights:

| Rule | Weight |
|---|---|
| `exact_natural_key` | 1.00 |
| `serial_number` | 0.95 |
| `device_identity` | 0.90 |
| `asset_tag` | 0.80 |
| `normalized_natural_key` | 0.70 |
| `zone_and_stream` | 0.30 |

Weights combine with a noisy-or, so several weak signals cannot be summed into
false certainty while one strong signal is sufficient. Thresholds:
`>= 0.90` merges automatically, `>= 0.60` is flagged for review, below that a
new entity is created.

Every score carries the list of rules that fired, and `MatchScore::explanation`
renders it as `serial_number(0.95) + normalized_natural_key(0.70)`. A human
reading a merge audit record can reconstruct the decision exactly.

If a learned matcher is added later it plugs in as another named rule with its
own weight; the audit record will still say what contributed what.

### Refusing to guess

Two candidates scoring equally well produce `Ambiguous`, which cannot be
committed. Resolution is also order-independent: candidate lists are sorted
with a stable tiebreak so a replay produces the same answer.

### Key normalization

`Press_04`, `PRESS-4` and `  press 04  ` all normalize to `press-4`:
lowercase, trimmed, separators unified, numeric segments stripped of leading
zeros. Idempotent.

### Conflict resolution

When merged records disagree on a property: higher provenance confidence wins;
if equal, the more recent observation wins; if still equal, **both are
retained** as concurrent temporal facts and the conflict is reported. Nothing
is silently discarded.

## 7. Merges are recorded, not destructive

The Cypher path writes a `SAME_AS` edge and sets `merged_into`; reads follow
it. A destructive merge would destroy the evidence that a merge happened,
which makes an incorrect resolution impossible to unwind. No generated
statement contains `DELETE` or `DROP` — asserted by test.

## 8. Query surface

The ports expose upsert, neighbourhood, path, lineage, latest asset state and
events-in-zone. Cypher for each is generated in `nexus-graph::cypher` and unit
tested without a database.

Injection safety: every user-controlled value is a **parameter**. Labels and
relationship types cannot be parameterised in Cypher, so they come exclusively
from the closed enums and are additionally validated by `safe_label`.
Variable-length path depths are clamped, since Cypher will not accept a
parameter there.
