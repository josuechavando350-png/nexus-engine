# RMC-016 — historical rank-one WETH liquidation previous-block fork candidate

**Purpose:** Identify one exact on-chain competitor's borrower and **canonical prior-block state** for an adversarial counterfactual replay. A retrospective competitor win is NOT an ex-ante executable opportunity nor a signal Nexus knew about at that prior block.

The chosen Ethereum Aave V3 LiquidationCall is transaction `0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba`, winner block **25938048**, exact block hash `0xf143f9988199037938e4dff57aaf24301a4c26770aefc0ec64774954cbf2dbe4`. WETH collateral and WETH debt, original repaid debt principal **10.684013854557827871 WETH**. The prior-block snapshot is block **25938047**, whose actual block hash MUST equal the winning block's `parentHash` on two separately operated RPCs.

**Immutable source commitments:**
- Full historical 139 events / 127 unique winners: [run 37718661409](https://github.com/josuechavando350-png/nexus-engine/actions/runs/37718661409), artifact 11524139188, SHA-256 `6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204`.
- 127 dRPC historical receipts: [run 37719091371](https://github.com/josuechavando350-png/nexus-engine/actions/runs/37719091371), **run FAILED overall** after a complete immutable dRPC stage; artifact 11524199698, SHA-256 `182b5e81b00ca04e53c9193c1496a725dc152ade9a17d3ab2dfaeb5045ac86b6`. Never treat the overall failed workflow as independently complete dual-provider receipt parity.
- All 139 real raw debt/collateral Aave liquidation ABI decoded events: [run 37722878737](https://github.com/josuechavando350-png/nexus-engine/actions/runs/37722878737), artifact 11525823668, SHA-256 `b5927f49a5099a9fe8971df82f1ea5fa2c4a169b11a846f2f3c2671b1efa71ee`.

**Verification:** independently fetch the *actual winning transaction receipt* through dRPC and BlastAPI. Decode the exact indexed Aave event topics, reconcile all raw event bytes to immutable original event commitment, compare the normalized transaction receipt to the authenticated prior dRPC receipt, and ensure the two operators agree on the public borrower identity, predecessor hash and canonical state root. No trading, wallet operation or key.

**Hard economic boundaries:** This stage does not yet execute a fork liquidation; subsequent replay must check health factor at the **previous** block without using same-block end state or winner's future effects. Do NOT use this retrospective choice to estimate a searcher's ex-ante capture, frequency or profitability. No available third-party gas sponsor/flash principal authorization, transaction inclusion or complete route cost is claimed. OWN_CAPITAL=0 must apply to the eventual entire execution, including gas. RMC-017 remains unclosed.

The borrower's address is public Ethereum on-chain data, used only as a local fork fixture. User information, keys and private RPC credentials are not required. This proposal does not alter any prior D08 compatibility evidence or executable source admission.
