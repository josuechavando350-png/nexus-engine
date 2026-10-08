# RMC-015 — Counterfactual time-only Aave health-factor test

**Goal:** isolate whether passage of time alone, between the preceding Ethereum block and the winning block, could have caused a historically observed WETH/WETH borrower to cross below HF=1. This is NOT a liquidation or tradable ex-ante opportunity claim.

## Immutable prerequisite

[PR #635](https://github.com/josuechavando350-png/nexus-engine/pull/635) found and independently reauthenticated the three highest WETH/WETH historical competitor liquidation winners from 139 Aave V3 events/127 winning txs. Their original preceding-block HF values were all ABOVE 1:

1. Rank 1 winner block 25938048, preceding 25938047: `1000000001993818630` WAD.
2. Rank 2 winner block 26024990, preceding 26024989: `1000701093031081909` WAD.
3. Rank 3 winner block 26071849, preceding 26071848: `1000489719586999148` WAD.

Exact successful producer: run **37739986399**, head `1048bb5558138429873b4459b9339f2527abbd13`, artifact **11533556749**, SHA-256 `069652fdb01f6921979edad188634a2fd6d72860163cbf6b3d47fab5fabe6fd6`. Require this exact GitHub run/head/workflow/name/SHA, plus archive member manifest, report commitment and original double-operator agreement. Source selection is retrospective from future competitor winning txs and must never be relabeled ex-ante.

## Two-provider time anchors

Requery the exact predecessor and winner blocks from independent dRPC/BlastAPI Ethereum operators. Both must match the original authenticated header/block/state-root hashes, parent relation and timestamp fields. Refuse any nonmonotone/impossible timestamp. Per sample, source public borrower address and original previous HF are pinned to the verified report. This step is read-only and yields exact epoch-seconds for time-only fork environment.

## Fork-only counterfactual

Pinned Foundry 1.7.1 and Solidity 0.8.24, deployed Ethereum Aave V3 Pool `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2`, at each original predecessor block. **No original historical intervening transactions are replayed or invented.** The EVM local fork:

1. Verifies actual previous HF with `getUserAccountData(borrower)` equals independent source WAD exactly, original borrower has debt and collateral, and previous HF ≥ 1e18.
2. Applies only `vm.warp(winnerTimestamp)` and `vm.roll(winnerBlockNumber)` without mutating token balances, oracles, liquidator capital or pool storage through a simulated transaction.
3. Reads the same real Pool risk function again and records the new HF. If it drops below 1, **time/index accrual under the unchanged predecessor state is sufficient in this local simulation**. If not, some other within-block state mechanism or causal trigger is required to explain eventual historical liquidatability. In either case, this does not by itself identify which original transaction triggered the change.

## Hard nonclaims

A change caused by `roll/warp` is a counterfactual reading under a local fork, NOT validated exact intra-transaction state at the winning tx index. This cannot establish earlier awareness by a searcher, builder inclusion, opportunity lifetime, accessible flash funding, third-party native gas sponsorship, swap/slippage/MEV costs, captured execution, realized profit or reliable monthly capacity. Do not mark any historic competitor opportunity `SHADOW_ELIGIBLE` on this basis.

This tests temporal feasibility only, no `vm.deal` for tokens, no signed transaction, no wallet, no paid server, no deployment and no original chain mutation. RMC-014/015/016/017 terminal closeout and OWN_CAPITAL=0 operational constraint remain unchanged.
