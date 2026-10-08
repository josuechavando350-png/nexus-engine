# RMC-016: On-chain Aave V3 historical flashLoanSimple premium truth

Status: READ-ONLY HISTORICAL PROTOCOL FEE INPUT, NOT FLASH LOAN FEASIBILITY OR NEXUS REVENUE.

The previous RMC-016 same-token winner diagnostic assumed a **hypothetical 5-basis-point** fee. Aave V3 documents that the total Pool flash premium can change by governance, and the fee is obtained from `FLASHLOAN_PREMIUM_TOTAL()`. Its Ethereum selector is `0x074b2e43`. This workflow independently calls that function on the canonical Aave V3 Ethereum Pool `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2` using two independently operated archival public RPC providers, dRPC and BlastAPI.

## Historical selected transactions (retrospective diagnostic only)

The source-locked nine WETH/WETH winner ledger has nine historical after-competitor-gas positives. The price-authenticated highest three correspond to:

1. Rank 1: `0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba`, winner block 25938048, price reference from block 25938047.
2. Rank 2: `0xb5b3f61e5a0becc1e2007d87cbea708fe40139478fac4c5eea5633b4b4beb1fb`, winner block 26024990, price reference from block 26024989.
3. Rank 3: `0x3c8757b8e83e098f64d88d0244709c7cdcf50ef67238e24d32357bcb679b5adb`, winner block 26071849, price reference from block 26071848.

All three historical price/block references are bound to previously immutable source evidence. The new inquiry requires two-operator exact agreement on Aave Pool premium (uint128 in basis points) and exact canonical previous-block hashes; it does NOT use winner-block end state as if known before execution.

## Authenticated input source artifacts

- Original 9-WETH economic audit: workflow 37732376404 SUCCESS, artifact 11530691544, SHA-256 `79cd8ee2056df668d31169444271bafb8f8ff3552e993000cf4e7df63ad28cb3`, source head `d90922e0bb030c9b56836bcacde0d8dfe52e2236`.
- Missing rank-two independent two-provider WETH oracle: workflow 37732663268 SUCCESS, artifact 11530582289, SHA-256 `ece575718b4834293ffb0a6e42f4329f41b39fef4b1befcad96eac507df1a92f`, source head `40e0918026c5fbfec0611d872dbb6d7258007948`.
- Originally priced rank-one and rank-three sample: workflow 37726618359 SUCCESS, artifact 11527902751, SHA-256 `5ae6c45b53ded26f327270758c248f7f4ec0ff1365f550e54dcf28feb4a83a03`, source head `a569b0a6ba11c0d12de3a1ac0d16d85b896933f6`.

Check the archive digests and internal report commitments and deny any missing, duplicate or altered source.

## Exact computation and prohibited promotion

For each ranked historical competitor's original debt amount and observed historical after-gas margin:

- query the Aave V3 `FLASHLOAN_PREMIUM_TOTAL()` at **the end of the previous block**;
- recompute the hypothetical Aave flashLoanSimple premium using Aave `PercentageMath.percentMul` half-up integer rounding: `(debt_wei * premium_bps + 5000) // 10000`;
- subtract it from original WETH collateral-minus-debt-minus-observed-competitor-gas;
- convert the remainder using the separately source-authenticated previous-block WETH/USD oracle reference, exclusively as a conditional historical value.

This is a candidate *cost input* from real on-chain protocol state, **not** a delivered flash loan quote. It does not prove previous-block available aToken liquidity, reserve flash eligibility, protocol caps, same-block atomic settlement, any gas sponsor, actual NQC calldata and revert conditions, inclusion, competition-adjusted capture or complete costs. In particular, replacing a hypothetical premium with an observed bps must NEVER promote a historical competitor to an executable NQC candidate.

Zero capital own funds including gas remains mandatory. No live trading, signed transaction, wallets, deployment, new paid infrastructure, profit expectation or RMC-017 closeout is authorized by this read-only workflow.

Official Aave docs: https://aave.com/docs/aave-v3/guides/flash-loans and https://aave.com/docs/aave-v3/smart-contracts/pool .
