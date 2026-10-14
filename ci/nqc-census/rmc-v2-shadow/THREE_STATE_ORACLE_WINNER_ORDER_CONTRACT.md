# NQC V2 — Three-state source-authenticated one-shot EVM ordering gate

This experiment tests the SAME original 18,732-byte one-shot CREATE initcode in three historical Ethereum states. It does not sign or broadcast any transaction; contract creation is simulated with eth_call on ephemeral 127.0.0.1:18546 Anvil v1.8.5.

## Original immutable producer

- PR726 exact head b6db90946d18e8199268acc1a5eb5ee3f4c541f4; source tree 8630f41fa1df8e2f3afbcd3928bd04236c2cc49f; GitHub Actions SUCCESS run 38631895351.
- Original ZIP artifact 11925719701, SHA256 1486986943d79a5e52da86e015a7c720f35ac979c062b658699853820e17b2b4, 30/30 SHA256 manifest members checked.
- Complete source EOA CREATE initcode plus constructor args: 18,732 bytes; SHA256 c4727076394f1e0f00a771171682c67665c840ab49457f8d3f5f274cb9dac706.
- Nested authentic PR698 Aave route archive SHA256 6778f8e190d13c739331f731ca532d8607e3f653ca000de746b058b4903c7d7d.
- History: Chainlink oracle tx0 0x20dd5bccadb185dbac34c94c8d00bf363a4a0b779fe1fddcdcfd8a3066d96c8b, original liquidator winner tx1 0x08db2e5d5f4e627f9fb4d12a780aac26aed725fab36b70fb9647119872d74625, Ethereum block 26,142,067. Canonical parent at 26,142,066 hash 0x772dfe7b438a71374fb11f4b02ed1a8a27b480e0e5eb7f561480650a5abb6a17.
- Before winning competitor but after oracle, exact source Aave borrower health factor 0.996350145012801388. PR725 earlier proved one actual isolated LOCAL EOA CREATE at the *subsequent synthetic block* 26,142,068 consumed 3,914,680 gas, paid 2,273.989378 synthetic USDC from liquidations, with 37 locally authenticated event logs. This is not a mainnet trade.

## Three independent controls

PRE_ORACLE_NO_TX0: fork at the canonical prior block 26,142,066 and mine exactly ONE empty synthetic local block, resulting in synthetic height 26,142,067 without the oracle update. Original six-word borrower risk must be different, HF>=1. The exact original 18,732-byte one-shot constructor simulation must REVERT with a known risk guard. A transport error never counts as a source risk failure.

AFTER_ORACLE_TX0_BEFORE_WINNER_TX1: fork v1.8.5 at original Chainlink oracle tx0, freeze state before original liquidator tx1. The Aave six-word ABI must match PR698 original byte-for-byte, and the exact one-shot transaction construction MUST return valid EVM bytecode from simulated eth_call. Such a simulation is not a receipt, new payout or production execution.

AFTER_WINNER_TX1: fork v1.8.5 at the original winning liquidator tx1, with the original competitor already having executed. The same borrower six-word ABI must differ from the original source and the identical one-shot constructor simulation MUST REVERT with a known original source-state guard. Do not assume postwinning HF is necessarily above one; measure it.

All three forks require canonical original Ethereum chainId1, parent header identity and exact one-shot CREATE calldata hash. Any unexpected positive postwinning result, wrong historical height, stale source, provider error, missing source, altered risk or reorg remains INCOMPLETE/FAIL. No synthetic Aave oracle, position storage or collateral changes are permitted.

## Security and commercial limits

Only local Anvil node listening on 127.0.0.1:18546, exact public read-only fork URL and strictly allowlisted RPC. One PRE_ORACLE empty locally-mined block and test-only ETH balance on the original ephemeral synthetic EOA are allowed. No public Ethereum broadcast, signing, private user key, real deposit or fee; only eth_call executes original CREATE bytecode. Pin official Foundry v1.8.5 with checked GitHub release asset SHA256 and independent checksum asset. Preserve all raw source files, each transcript, UTC timestamps, exact code commit/tree and content-addressed ZIP.

The original transaction is retrospectively selected. This experiment can validate causal on-chain eligibility under precisely these three historic states but **NOT** private SVR/MEV-Share access, first-seen before builder deadline, relay accepting CREATE backruns, winning competitor ordering, calibrated capture, nonrecourse external gas financing, or monthly net income. OWN_CAPITAL=USD0 including gas, owner MXN2,000 untouched. PFT CLOSED; RMC OPEN; Shadow P2 UNCERTIFIED; LIVE unauthorized; Commercial 5.9 unchanged, realized NQC P&L USD0. NQC algorithms retained exclusively; no external executor rights granted.
