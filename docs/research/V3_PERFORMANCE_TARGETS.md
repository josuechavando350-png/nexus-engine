# NEXUS V3 — Performance: Method, Not Claims

## 1. Position

**No throughput or latency figure is claimed for NEXUS V3.**

Not "millions of events per second", not a p99, not a comparison to any other
system. The runtime was designed to scale horizontally, and that design
intention is not evidence. This document defines how a number would be
produced so that any figure later quoted has a method behind it.

## 2. Execution status

`runtime/bench/` contains a load generator and measurement harness. It has
**not been executed**. The environment in which V3 was built has no Rust
toolchain and no network access to install one, so nothing was compiled and
nothing was measured. See `NEXUS_V3_VALIDATION.txt`.

Every row in the results table below is therefore `NOT MEASURED`. They are
placeholders for real data, not estimates.

| Stage | p50 | p95 | p99 | Throughput | Memory | CPU |
|---|---|---|---|---|---|---|
| Envelope validate + hash | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED |
| Deduplication | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED |
| Normalize + resolve | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED |
| Graph mutation (in-memory) | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED |
| Graph mutation (Neo4j) | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED |
| Task proposal | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED |
| Policy evaluation | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED |
| Simulation dry run | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED |
| Edge execution (SIMULATION) | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED |

## 3. Method

1. **Generate load.** `nexus-bench` produces synthetic telemetry and
   detections at a configured rate with a configured asset cardinality.
   Cardinality matters more than volume for resolution cost and must be
   reported alongside every figure.
2. **Measure per stage**, not end to end only, so a regression is
   attributable.
3. **Report p50 / p95 / p99**, never a mean alone. A mean latency on a queueing
   system hides the behaviour that matters.
4. **Report memory and CPU** at steady state and at peak.
5. **Document the hardware**: CPU model, core count, RAM, storage class, OS,
   Rust version, release profile, and whether the broker and graph are local
   or remote.
6. **Report the limit found**, not the maximum achieved. The useful number is
   where latency degrades or the queue stops draining.

## 4. Honest measurement rules

- Histograms report **bucket upper bounds**, never interpolated percentiles.
  A p99 from coarse buckets is an upper bound and is labelled as one.
- Warm-up iterations are discarded and the count is stated.
- The in-memory backend is not a proxy for a durable one. A figure from
  `InMemoryGraph` is labelled as such and never quoted as system throughput.
- Benchmarks with the optional features enabled must state which features.
- A benchmark that did not run is `NOT MEASURED`. It is never estimated,
  extrapolated or inferred from a similar system.

## 5. Where the limits are expected

Design-level expectations, to be confirmed or refuted by measurement — not
predictions to be quoted:

- **Graph writes** are the likely first bottleneck; mutations are batched and
  idempotent so batch size is the tuning knob.
- **Entity resolution** scales with candidate set size; the candidate query is
  the thing to index.
- **Dedup and nonce windows** trade memory against duplicate-detection range.
- **Policy evaluation** is first-match over a small rule vector and should be
  negligible; if it is not, the rule set has grown past what a linear scan
  suits.

## 6. Horizontal scaling

Partition by `source_id` so per-source ordering survives. `graphd` remains the
only writer per partition. Nothing in the design requires a global order,
which is what makes partitioning possible.
