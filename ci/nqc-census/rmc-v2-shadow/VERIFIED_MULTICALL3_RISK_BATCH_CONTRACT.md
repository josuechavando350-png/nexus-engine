# NQC V2 — Verified canonical Ethereum Multicall3 risk batching

## Purpose and source truth

PR729 [successful specialized run 38642172907](https://github.com/josuechavando350-png/nexus-engine/actions/runs/38642172907) authenticated a nine-borrower dual-RPC risk-read comparison: 3.561670151 seconds sequential mean versus 3.606561709 seconds for three parallel workers, on one pinned already-mined Ethereum block. With source-safe 400ms/provider dispatch spacing, parallelism was **1.26% slower**. The source artifact **11931141484**, ZIP SHA256 **cd26e9863aae362f7bda90e4a1343ee1fefa63a5cf66e4384dc33aa31646332c**, is bound to head **222f3c3c67ea2b2217886783731ff1a04debc72e**, tree **79abaf15598ccce39f3e1ca0260cdee78fd4e3dc**, and has **20/20 source member SHA256 manifest checks**. It contains the original PR728 and PR718 authenticated nine-owner selection. The source is a small historical Withdraw-associated debt cohort, NOT all Aave borrowers.

**New hypothesis:** one Multicall3 onchain aggregate3 call may remove nine independent remote RPC round trips without breaching provider pacing or abandoning exact EIP-1898 state truth.

Official source and deployment: https://github.com/across-protocol/multicall3, Ethereum mainnet deployed address **0xcA11bde05977b3631167028862be2a173976ca11**, method aggregate3 with selector **0x82ad56cb**, tuple Call3(address target,bool allowFailure,bytes callData), returning Result(bool success,bytes returnData). Only use via JSON-RPC **eth_call**, which has no persistent onchain effects even though the contract method is payable and not marked view.

## Attestation

1. Reauthenticate exact PR729 source, complete manifest, nested PR728/PR718, former source snapshot and prior commercial nonclaims. Write a NEW immutable nine-borrower precommit before ANY new Ethereum call. Do not choose addresses by current HF or future liquidation.
2. Only dRPC and PublicNode official URLs. Require Ethereum chainId1, tip drift <=3, same already-mined min-tip-minus-2 block number/hash/parent/stateRoot/timestamp, initial and final age <=140 seconds, final exact dual-source header recheck. Both endpoints must agree on raw runtime bytecode obtained by EIP-1898 eth_getCode from canonical Ethereum Multicall3. Record byte length and SHA256. The deployed code's Solidity provenance is NOT independently established by two URL hashes alone.
3. Compare four passes on the same exact canonical blockHash: SEQUENTIAL, MULTICALL3, MULTICALL3, SEQUENTIAL. Each direct pass must read all nine original Pool getUserAccountData(address) calls, returning six exact 32-byte words; each batched pass must issue ONE eth_call to Multicall3 with exactly nine immutable AllowFailure=false Aave Pool subcalls and strict ABI-encoded offsets.
4. Strictly reject missing, failed, duplicate, re-ordered, truncated or mutated Result entries. Require raw identical Aave ABI bytes between dRPC/PublicNode and across all four passes. Require same pool address, borrower list and state hash. No skipped accounts, source substitution or retries after rate limits.
5. Preserve per-request UTC/monotonic clock, all four duration measurements, per-provider RPC count (max 30), complete ABI records, exact Multicall3 calldata hash, runtime code hash and source artifact SHA. The provider-level request dispatcher maintains 400ms between requests; an EVM aggregate contains nine subcalls and is not a free computation. Do not claim provider compute quota exemptions.
6. A passing test proves an authentic, limited public API comparison, and a faster result is specific to its sample only. Four samples are insufficient for a latency distribution. A public mined block is already after inclusion: zero private Chainlink SVR first-seen, builder cutoff, winning bid or income is demonstrated.

## Falsification / permissions

Provider errors, unsupported eth_getCode with blockHash, stale headers, reorgs or any mismatch become INCOMPLETE, never no-market or zero liquidations. No Ethereum broadcast, no local or public deployment, no EOA key, no signing, no ETH or MXN2,000 spent, no gas sponsorship, no merge or new paid service. No license of NQC's proprietary engine to another liquidator. OWN_CAPITAL USD0 including gas; RMC OPEN; Shadow P2 uncertified, LIVE unauthorized, Comercial 5.9 unchanged, NQC realized P&L USD0.

Commercial next step remains legitimate access to pre-inclusion data and nonrecourse operating gas finance; speeding up public already-mined risk scans cannot provide them.
