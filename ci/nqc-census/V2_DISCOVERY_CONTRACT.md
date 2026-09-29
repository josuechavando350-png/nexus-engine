# RMC-007 — Reconciled V2 Discovery Contract

Status: implementation in progress. This node is limited to one explicitly
declared Ethereum-mainnet Uniswap V2 factory deployment and does not claim all
V2 forks, all DEXes, or economic opportunity.

Authoritative parent: `8ebf6860e0a16964f5293df0ef40695b303b286d`.

## Authorities reused

- D01 canonical market identity (`CanonicalMarketKey::v2_pair`)
- D03 typed observations
- D04 durable evidence/checkpoints
- D05 deployment registry/admission
- shared `nqc-census-chain` acquisition/replay layer

No parallel identity, evidence, checkpoint, or admission model is permitted.

## Discovery surfaces

A. Current factory enumeration: `allPairsLength()` + `allPairs(uint256)`.
B. Historical creation history: canonical `PairCreated(address,address,address,uint256)` logs.
C. `getPair(address,address)` is a direct membership cross-check, not an
independent universe enumerator.

Selectors/topics are derived from exact signatures; their presence in runtime
bytecode is only evidence. Live calls/log decoding are still required.

## Reconciliation

A pair is identified by D01 using factory deployment + pair address + canonical
token0/token1. Tickers/symbols are never identity.

PASS requires, inside the declared scope:

- current enumeration and canonical PairCreated history reconcile;
- every union pair passes direct getPair membership;
- every union pair has runtime-code evidence;
- no pair identity conflict;
- no enumeration-index / PairCreated ordinal conflict;
- zero unexplained deltas.

Uniswap V2 factory pairs are append-only in the supported semantics. Therefore
an EVENT_ONLY or ENUMERATION_ONLY pair is not auto-explained as lifecycle drift;
it remains UNEXPLAINED until concrete evidence proves another cause.

## Current implementation milestone

The crate implements strict PairCreated decoding, runtime interface evidence,
D05-gated deterministic reconciliation, canonical output, duplicate-log
deduplication and fail-closed adversarial cases. Live full-factory acquisition,
archive start proof and exact-head evidence remain required before RMC-007 may
be reported PASS or merged as complete.
