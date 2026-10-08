# RMC-016: Real previous-block borrower health factor (no hindsight promotion)

Read-only exact Aave V3 `getUserAccountData(address)` at Ethereum block **25938047**, immediately before the first-ranked retrospective WETH/WETH competitor winning liquidation in block **25938048**.

## Immutable selected borrower authority

Source lineage is the successful historical independent receipt/block witness [run 37739155239](https://github.com/josuechavando350-png/nexus-engine/actions/runs/37739155239), commit `806484f1df1d9b10c4ed392a60c9bdfbff496009`, artifact **11532149885**, outer ZIP SHA-256 `01778616235930c3ac02f0aa1f3d1e8a7e5185317022ecf74707a278bd9be964`. That source had reauthenticated 139 historical liquidation logs, 127 normalized dRPC competitor winner receipts and all 139 raw Aave ABI legs, then independently matched the actual winning receipt log and borrower through dRPC and BlastAPI, with exact winner-parent/predecessor block hash binding.

The borrower was chosen **retrospectively using the future winning transaction** `0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba` (repaid WETH debt 10.684013854557827871 WETH). This choice alone is NEVER an ex-ante signal or capture estimate.

## Exact source-bound measurement

Authenticate source run/head/artifact/name/digest and ZIP internal SHA manifest. At exactly block 25938047, query separately operated Ethereum mainnet archive RPC providers dRPC and BlastAPI; independently verify block hash and state root equal the previous report. Query original Aave V3 Pool `0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2` with selector `0xbf92857c` (`getUserAccountData(address)`), ABI address argument the previously independently observed borrower. Require six valid `uint256` return fields: total collateral base, total debt base, available borrows base, liquidation threshold, LTV and health factor in WAD. All six must agree exactly across operators, and total debt must be nonzero.

**Two allowable source-grounded outcomes:**
- `RMC016_RANK1_PREBLOCK_HEALTH_FACTOR_BELOW_ONE`: the actual previous-block health factor is strictly below 1e18, so a subsequent fork liquidation may be *attempted*.
- `RMC016_RANK1_PREBLOCK_HEALTH_FACTOR_NOT_BELOW_ONE`: the borrower was not liquidatable by the ordinary below-one criterion at that predecessor state. Do not infer that Nexus could reproduce the future winning transaction from that earlier state; a same-block trigger may be required.

A passed view query does **not** establish actual execution, a solvent route, aToken redemption, enough flash principal, sponsor-funded gas, inclusion, competition-adjusted capture, net P&L or that Nexus knew this candidate existed at decision time. Even below-one health factor may face other liquidation restrictions.

OWN_CAPITAL=0 remains mandatory for any future real transaction. No orders, wallets, source-admission promotions, deployments, secrets or changes to RMC-014/017 terminal state.
