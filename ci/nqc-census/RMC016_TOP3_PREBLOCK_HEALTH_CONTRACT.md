# RMC-016 — Actual previous-block health factors for top-three WETH/WETH winners

Source-bound, retrospective, non-authoritative temporal feasibility diagnostic. **This is NOT an ex-ante opportunity classifier or trading strategy.**

## Why

Independent evidence from [PR #634](https://github.com/josuechavando350-png/nexus-engine/pull/634) shows that the highest historical WETH/WETH competitor winner's borrower had Aave V3 `healthFactor=1.000000001993818630` at previous Ethereum block 25938047, marginally **above** the liquidation threshold. Therefore the competitor's eventual positive margin cannot be treated as a preblock-available Nexus candidate. Detecting and acting on the exact **intrablock trigger** could matter more than static market census breadth. This result requires adversarial checks of the other two leading winners.

## Exact input authority

Original immutable historical 139 LiquidationCall events / 127 unique competitor winning transactions, decoded 139 exact raw Aave liquidation legs, and the full normalized prior dRPC receipt archive:
- Event run 37718661409, artifact 11524139188, SHA256 `6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204`.
- dRPC receipt stage from FAILED-overall run 37719091371, artifact 11524199698, SHA256 `182b5e81b00ca04e53c9193c1496a725dc152ade9a17d3ab2dfaeb5045ac86b6`. Do NOT call this overall workflow successful or claim complete original multi-operator parity.
- Exact raw-legs run 37722878737, artifact 11525823668, SHA256 `b5927f49a5099a9fe8971df82f1ea5fa2c4a169b11a846f2f3c2671b1efa71ee`.
- Prior independently authenticated rank-one above-one HF result: run 37739525958, artifact 11533585303, SHA256 `fea8c534a1386dafbc180e626c8af4d2ea339b0a752cae5860306647a8fff344`, head `4e4983f2c937f6d3f1c65bcdfc699b18afb5dbbd`.

## Fixed retrospective top-three WETH margin ranks

The script must reconstruct all **nine** WETH/WETH events from original decoded legs and receipts, calculate actual historical competitor **collateral-minus-debt-minus-whole-transaction-gas** integer margins, rank them deterministically and source-bind the following exact top-three identities:

1. `0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba`, winning Ethereum block 25938048, predecessor block 25938047, 10.684013854557827871 WETH repaid.
2. `0xb5b3f61e5a0becc1e2007d87cbea708fe40139478fac4c5eea5633b4b4beb1fb`, winning block 26024990, predecessor 26024989, 1.827043650017560428 WETH repaid.
3. `0x3c8757b8e83e098f64d88d0244709c7cdcf50ef67238e24d32357bcb679b5adb`, winning block 26071849, predecessor 26071848, 0.866504893554112580 WETH repaid.

These are **future winners selected with hindsight**, not a detection backtest.

For every candidate, independently use dRPC and BlastAPI to verify the exact original winning receipt and indexed borrower, original ABI debt/collateral integer amounts and event commitment, winning block header, and its canonical parent/predecessor hash. At that **predecessor end state only**, query real Aave V3 `getUserAccountData` with the original indexed borrower. Every six `uint256` account values and the block header must agree across independent operators. Preserve health factor WAD and classify the ordinary below-one threshold. The prior rank-one HF exact value is an immutable replay assertion.

## Strict outcome

The output is **the number of top-three historical competitors with health factor below one at predecessor end**, plus exact per-case state witnesses. It is deliberately valid even if **zero of the three** was previously liquidatable. A successful health observation alone is not a physical flash+liquidation+swap route, a verified sponsor, feasible real gas, forecast win rate or Nexus P&L. A previously healthy winner may have become liquidatable due to an intrablock oracle/config/balance/index change that requires transaction-prestate replay.

Any missing source, noncanonical header, disagreement, uncovered same-asset event, failure to recover all nine, or counterfeit original historical margin fails closed. The separate RMC-017 terminal authority stays BLOCKED. OWN_CAPITAL=0 is not weakened. No signing, trading, service provisioning, deployment, or user funds.
