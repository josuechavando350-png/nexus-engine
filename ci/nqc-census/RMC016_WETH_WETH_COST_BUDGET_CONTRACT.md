# RMC-016: Nine immutable WETH/WETH winners and nine historical after-gas positives

**Authority: read-only historical competitor diagnostic only. Never NQC revenue, forward trading signal, Shadow success or Census closeout.**

This narrowly scoped continuation joins the original 139-event / 127-transaction Aave V3 Ethereum archive, all 127 separately verified dRPC receipts preserved in a failed overall dual-provider workflow, the 139 authenticated raw debt/collateral legs, and the independently cross-checked pre-block WETH prices for two historically largest WETH/WETH margins. No live RPC requests, new resources, private keys, transactions or payable services are used.

The release job independently authenticates the exact source run, head SHA, artifact identity and SHA-256, and rechecks all ZIP member digests. The code verifies **all 139 raw event commitments** against the original source, **all 127 winner receipt identities**, and exactly **nine WETH/WETH events**, with **all nine** having strictly positive collateral-minus-debt-minus-historical-winner-gas differences (two are extremely small). The transaction gas is charged **once per historical winning transaction**, not per event. The two retrospectively selected WETH/WETH cases must be the two largest historical collateral-minus-debt-minus-competitor-gas observations among all nine, must retain the exact raw debt/gas/margin anchors, and must be bound to the two independent oracle price observations at the previous block. All arithmetic is integer wei and USD-WAD.

Source archive identities:
- Source event run 37718661409, artifact 11524139188, SHA256 `6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204`.
- dRPC receipt run 37719091371 (**overall FAILED**, although 127 dRPC receipts completed), artifact 11524199698, SHA256 `182b5e81b00ca04e53c9193c1496a725dc152ade9a17d3ab2dfaeb5045ac86b6`.
- Historical exact raw event legs run 37722878737, artifact 11525823668, SHA256 `b5927f49a5099a9fe8971df82f1ea5fa2c4a169b11a846f2f3c2671b1efa71ee`.
- Two independently priced historical WETH winner observations run 37726618359, artifact 11527902751, SHA256 `5ae6c45b53ded26f327270758c248f7f4ec0ff1365f550e54dcf28feb4a83a03`.

**Reported conditional cost budget:** historical raw seized WETH minus raw WETH repaid minus the historical competitor's whole-transaction gas, minus a **hypothetical** five-basis-point flash fee rounded *up*. This is not a historical flash borrowing quote. Additional protocol/route/MEV, financing, failed-inclusion, inventory and sponsor fees may consume or exceed the remainder. The oracle USD conversion is a **previous-block reference**, not the liquidation's exact transaction prestate. Aave `receiveAToken=true` requires a separately proven exit and is marked, not assumed to be liquid WETH.

**Terminal blockers remain:** authorized third-party gas sponsorship, exact external flash principal availability/premium and atomic settlement, complete Nexus counterfactual calldata/prestate route, competition capture, out-of-sample full-month net capacity and independent RMC-017 certification. OWN_CAPITAL=0 is not relaxed. This PR must remain draft until source-authenticated push evidence and CI pass. No positive Nexus P&L is claimed regardless of observed cost budget size.
