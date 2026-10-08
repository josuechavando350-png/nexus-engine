# RMC-016 — Historical winner RPC access / recovery preflight

## Mission

Recover the real transaction identities and receipts for the **127 historical Aave V3 Ethereum winning liquidation transactions** and **139 LiquidationCall events** observed by RMC-015B, without manufacturing individual observations from RMC-016 aggregate totals.

This initial changeset is an independent, **read-only network-access preflight**, not a reconstruction claim. It performs actual JSON-RPC calls against three named providers, requires at least two independently operated providers, and preserves the exact Ethereum mainnet source window `25880316..26095351` (inclusive) and both block hashes. Both block headers require parent hash and state root. It checks event retrieval over only the **last 32 blocks**, plus one independently verifiable historical Aave V3 liquidation transaction receipt. Empty sampled logs are allowed, but do not prove historical completeness.

Sources: exact D15B run `37669899465`, artifact `11504276505`; D16 run `37673653265`, artifact `11505504820`; D16 source blob `5d5ed3635a426d686c8a98aa3547fd5b9b95aa` at commit `96a0b3e3c0b55df1b1d890f8c70a7a9014e2ff9a`. Source contract and full economic provenance remain in `ci/nqc-census/RMC016_WINNER_NET_EVIDENCE_CONTRACT.md`.

## Required evidence before full 127-transaction reconstruction

- Two independent RPC providers must return exact matching canonical headers, one valid `LiquidationCall` receipt, and identical sampled logs/receipt gas.
- Blockscout Ethereum mainnet explorer exposes a separate public `/api/eth-rpc` endpoint supporting `eth_getBlockByNumber`, `eth_getLogs` and `eth_getTransactionReceipt` (official Blockscout API documentation). It is classified as its own data operator, not silently combined with dRPC. A provider's self-declared identity never replaces actual matching independent evidence. Each failed request must identify the failing JSON-RPC method and bounded HTTP error body.
- Ethereum Pool V3 address: `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2`.
- The Aave `LiquidationCall` topic must be exact and stable; source: official `IPool.sol` ABI and independently published Ethereum transaction event decoding.
- On successful preflight, expand to complete historical `eth_getLogs` over the entire pinned window, preserve every event's tx hash, block hash, ordering and receipt, check full cross-provider agreement, enforce `139` events and exactly `127` unique winner transactions or fail closed. No post-hoc filtering to force those counts.
- Verify receipts' exact event membership and gas in **wei**, as well as historical block hashes. Then reconcile events and transaction IDs against recovered original ledger digest `55d5d6be9e09f2e499e1ca8949c4305d05824dffa61e363f4371c615537dcb1c`. The original private historical archive might be inaccessible, in which case label an independent reconstruction, **not a hash match**.
- Oracle-USD gross and gas values require independent historical timestamp/pinned oracle or pool-state proofs; receipt gas in ETH must **not** be labeled USD without that conversion.
- External principal/gas, exact routes, flash premiums, swaps, MEV, bundle inclusion, competition, censored opportunities and Nexus-specific counterfactual remain unproven. `OWN_CAPITAL=0` is a strict admission requirement.
- No observed transaction may automatically become a Nexus win. Historical market volume is **not** Nexus capture probability, P&L, or monthly revenue.

## Security and failure classification

This preflight uses Python standard library only, sends `eth_chainId`, `eth_getBlockByNumber`, `eth_getLogs`, `eth_getTransactionReceipt`, never signs or broadcasts, and requires exact block-hash and provider-operator agreement. HTTP 401/403, unavailable historical data, RPC errors, changed block hashes, data drift and missing independent providers fail closed. The GitHub workflow publishes a diagnostic archive even upon failure. A preflight PASS certifies **only** availability of this tiny sampled historical RPC surface, never the completeness of 127 winners.

The workflows must not modify Cano Penal, Vercel, user funds, D14/D17 closeout, PFT, or any capital/economics admission rules.

## Reproduce

```bash
python3 ci/nqc-census/test_rmc016_probe_historical_rpc.py
python3 ci/nqc-census/rmc016_probe_historical_rpc.py --out /tmp/nqc-rpc-preflight.json
```
