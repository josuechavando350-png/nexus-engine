# NQC V2 — Full 83-owner Aave Withdraw risk refresh (zero new market-history scan)

## Why it changes commercial confidence without inflating it

PR717 corrected a real false coverage failure and authenticated 149 Aave Withdraw events over exactly 384 Ethereum blocks, 106 event-bearing canonical block headers and 83 distinct aToken withdrawing owners. At exact successful head e0f589b8f1e47ffda04ef6e2c9031f695222fa42 it measured 64/64 current HF states via dRPC and PublicNode and left 19 previously omitted owners UNKNOWN (24 Withdraw events). We should **not** declare those 19 healthy, liquidatable or absent.

The objective here is to authenticate that unchanged evidence and read all **83** previously indexed owners at the *same newly pinned* Ethereum block. The 83 are already known before this run's HF observations, avoiding market-event rescans and result-driven sampling.

## Single exact source authority

- Producer PR717: [run 38585339954](https://github.com/josuechavando350-png/nexus-engine/actions/runs/38585339954) SUCCESS, head e0f589b8f1e47ffda04ef6e2c9031f695222fa42, tree 6e0ce2e5056d98f9b0218a0d788babd564ad2115.
- Source ZIP artifact **11905790765** SHA256 **0cf05f5acf279948dbdf92b5b52183c129175850fdd311c13e3356d7ede289a2**, all 18 producer-manifest members verified, producer report 149/83/64 complete.
- Source artifact contains exact original read-only source transcripts, both immutable canonical headers, 149 indexed Aave events, 106 verified event-bearing block hashes, two per-RPC positive receipts, prior 64 six-word Aave risk reads and SHA256 source tree.
- New source consumer authenticates **every ZIP member** against the exhaustive SHA256 manifest, exact source commit/tree, no duplicated ZIP members / JSON keys / symlink paths, dual-source event and risk state parity, prior selected 64 in source order, and the 19 omitted owners' exact 24 events.
- GitHub Actions independently checks exact producer run/commit/artifact/digest/ownership and downloads immutable ZIP before running any source-side risk measurements.

## New bounded observation

1. The fixed 83 owners are determined solely by prior on-chain Withdraw events; **no current HF or winner information** enters selection, and all 83 will be read or the outcome remains INCOMPLETE.
2. Ethereum chainId and current tips from **dRPC and PublicNode**, require <=12 block divergence. Fix one minimum-tip-minus-three **current** block before querying risk state, and confirm both providers have the exact same number/hash/parent/stateRoot/timestamp.
3. Recheck the original producer's first and last event-window canonical headers on both endpoints, then individually call only Aave V3 Pool getUserAccountData(address) for each of the 83 preselected owners with EIP-1898 requireCanonical=true and the new exact shared blockHash. The original previous-event window cannot silently change after a reorg.
4. Recheck pinned state header after all 83 reads and time-based freshness <=180s. Use a two-thread design, **one sequential reader per public provider**, reducing stale-block drift without flooding either source. Max 95 strictly allowlisted public read requests per provider. No read batching or alternate provider identity after throttling.
5. Success requires 83/83 raw account read parity; classify active-debt vs repaid, HF<1, HF 1–1.005, 1.005–1.02, 1.02–1.10, and higher. Separately report 19 new accounts' debt/near-HF. For 64 prior accounts, compare only accounts that had debt in **both** state snapshots; this is a historical trend, not causal attribution of any Withdraw, oracle update or profit.
6. Incomplete canonical headers, stale end state, absent receipts/provenance, 429, partial reads or disagreement **cannot be reclassified as zero HF candidates**. Preserve source errors, exact provider RPC transcripts, source SHA, current head and traceable censored output.

## What remains unproven

This is not an entire Aave borrower census, live pending signal or before-inclusion observation. A Withdraw event may be unrelated to effective collateral or liquidation risk. An HF<1 state is not route feasibility. We still need cold complete NQC transaction gasUsed, capital flash constraints, swap output, MEV/builder inclusion, failed bids, competitor collisions and an external **nonrecourse** gas sponsor. No real trading, wallet use, signing, broadcasts, new hosts, paid RPC or operational spending. MXN2,000 user reserve is not authorized for use; OWN_CAPITAL=USD0 including gas still applies.

PFT CLOSED; RMC OPEN; P2 Shadow NOT CERTIFIED; LIVE NOT AUTHORIZED; NQC realized P&L USD0, Comercial 5.9 unchanged. No research lane frozen; no PR merged. Success here will be a measured **cohort coverage improvement**, not a commercial-score upgrade.
