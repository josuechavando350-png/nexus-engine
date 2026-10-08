# RMC-016 — Historical winner net-economics evidence gate

**Status: AUDIT FOUNDATION / AGGREGATE VERIFIED / INDIVIDUAL TRANSACTION LEDGER NOT PUBLISHED.**

## What this does

This read-only, no-network Python arithmetic layer consumes the **exact raw ZIP
bytes** from two immutable GitHub Actions artifacts, plus the **exact Git blob**
`ci/nqc-census/rmc016-production-evidence.json` at D16 commit
`96a0b3e3c0b55df1b1d890f8c70a7a9014e2ff9a`. It authenticates both
ZIPs against pinned SHA-256 and checks every SHA-256 line inside each archive.
It reconciles D15B → D16 authority commitments, window anchors, production
snapshot identity, 127 winning transactions, 139 liquidation events and
conservatively unproven Nexus capacity.

The D16 source aggregate states:

- 127 observed historical winning liquidation *transactions*, across 139 events
  (count by transaction hash, never sum multiple `LiquidationCall` logs as
  separate wins).
- `138045174690310000000000` USD-WAD gross **oracle edge** (not actual profit).
- `1144134260592713842029` USD-WAD observed winner gas.
- `136901040429717286157971` USD-WAD remains after subtracting just observed
  winner gas. This is a **partially costed historical market benchmark**, not
  a rigorously certified profit upper bound across all possible routes.
- Conservative Nexus capture capacity, capture probability lower bound, and
  realized profit certification are zero/uncalibrated. The $300K month-one
  target is **not proven**.

The 127-row `transaction-economics.jsonl` and per-winner transaction receipts,
route cost bases and prestate witnesses are **not included** in D15B artifact
`11504276505` or D16 artifact `11505504820`. D16 repository evidence names a
`transaction_economics_sha256` but does **not publish those bytes**. The hash is
not a substitute for the actual data. These are the blocking facts, not a
negative profitability finding.

## Canonical additional ledger gate

The optional `--winner-ledger` can only ingest a **canonical JSONL** whose
byte-for-byte SHA-256 equals D16's `transaction_economics_sha256`. Each row must
represent one unique historical winner transaction hash and include its exact
block/order, prestate and receipt evidence commitments, gross oracle edge,
observed gas, all fifteen integer-denominated cost categories and nonzero
content-addressed evidence for every cost (including zero costs). The
transaction count, sum of oracle gross and sum of observed gas must match the
pinned historical aggregates exactly. Duplicate transactions, look-ahead
windows, unverifiable evidence, noncanonical/negative/float monetary values,
missing cost categories or per-tx/aggregate divergence fail closed.

The *existing* raw historical economics file might use a different record
schema; if so, implement a **separately verified, deterministic adapter** from
its authentic bytes, preserving the source hash, before any per-row claim.
Never manufacture rows to satisfy this interface.

Passing arithmetic checks does not mean that cost receipts were independently
replayed or that Nexus would have landed a transaction. All numerical
historical market winner results remain separate from Nexus. This model never
certifies a positive Nexus P&L.

## Requirements for a Nexus-specific result

1. Recover and independently verify the real 127-row transaction ledger,
   winner receipts, prestate states and full source provenance.
2. Reconstruct every *candidate's historical decision-time state*; no future
   oracle price, post-winner state, post-block token balance or endpoint sample
   can influence an earlier decision.
3. Simulate exact Nexus calldata in fork pinned to that prestate with real
   route/venue execution, price impact, protocol/flash fees, gas and bundle
   payments; prove all operating and gas capital comes from external sources.
4. Model mempool/relay inclusion and competition conservatively, and distinguish
   `Nexus feasible`, `positive success-path net`, `capturable` and `captured`.
5. Reconcile simultaneous capital, shared DEX liquidity and overlapping
   opportunities without double counting, partition by economic regimes and
   out-of-sample windows, and report explicit uncertainty.

**Never infer the $300,000 target from gross oracle edge, capital availability,
127 market winner transactions, or synthetic tests.** `OWN_CAPITAL = 0 USD`
remains hard and Nexus operational gas funding is not proven. D14 and D17
terminal authority remain separate and unchanged.

## Reproduction

```bash
python3 ci/nqc-census/test_rmc016_winner_net_audit.py
python3 ci/nqc-census/rmc016_winner_net_audit.py \
  --d15-archive /path/to/artifact-11504276505.zip \
  --d16-archive /path/to/artifact-11505504820.zip \
  --economic-source ci/nqc-census/rmc016-production-evidence.json \
  --out /tmp/nqc-winner-baseline.json
```

The GitHub workflow additionally checks exact remote run, commit/tree and
artifact provenance with GitHub's API, re-downloads both ZIPs, verifies their
outer SHA-256 and independently reproduces the JSON report twice before
publishing an append-only **aggregate only** archive. No live transaction is
signed, broadcast or funded by this code.
