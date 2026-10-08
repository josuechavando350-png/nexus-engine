# RMC-015 — Auxiliary material-risk asset compatibility triage

## Admission boundary

This tool is **not** a liquidator, market census closeout, risk forecast,
credit-facility certification, executable token admission or P&L model. It
selects an *engineering work queue* from immutable D08/D09 evidence at the
single Ethereum anchor 26,095,351. Its only legitimate future use is
forward monitoring from block 26,095,352. Historical simulation before that
block must reconstruct the ex-ante universe independently and must not reuse
this hindsight-selected watchlist. The tool and workflow must always emit
`terminal_authority=false`, `execution_eligibility_certified=false`,
`retrospective_backtest_admitted=false` and `realized_profitability_proven=false`.

## Exact inputs

- D08 RMC State Oracle Token Admission: run `36964016388`, artifact
  `11237887761`, sha256 `9431ea07144ae78e68e0ffcc7f650fa32068ee63fb53ca41ff8a062b87845913`,
  commit `36c732a36789e1967ce7178010889427ad7cf0f2`.
- D09 RMC Aave Account Universe: run `36823489219`, artifact
  `11159396055`, sha256 `9aa6a4beb3ebc90f40d07d1889f84c1bcf94b3dea90b0e7b596dc6ff70fda0f6`,
  commit `6db82ca89d4ef3a66a1b236de95670a6967eb3ea`.

The process must independently authenticate both outer artifact ZIP digests,
inner evidence-manifest SHA-256 commitments, the fixed chain/block hash and
oracle-base units, 246,929 state-verified D09 accounts, the 857 healthy
material-risk accounts and the full D08 `token-admission.jsonl` manifest.
Pass/fail may not be manipulated by the desired target income.

## Count semantics and priority

- Debt/collateral participation is **one account per asset**, not money,
  predicted risk probability or number of executable liquidations.
- A single account can use multiple assets; adding raw asset counts may
  double count it. The focus numerator counts a *set union* of accounts.
- Pinned-result observations: 857 near-risk accounts have 26 debt-asset
  underlyings and 36 supplied-asset underlyings (not necessarily eligible collateral); the four most prevalent debt
  underlyings are WETH, USDC, USDT and WBTC, associated with 807 unique accounts.
  These four are not sufficient to execute a liquidation; collateral transfers,
  gas, flash liquidity, route liquidity, oracles and token behaviors must also
  be certified. Priority is based solely on source participation counts.
- All 514,279 D08 token-admission entries are `BLOCKED` under its original
  rules. Even when a bytecode fingerprint is present, missing transfer, hooks,
  rebasing or proxy-semantic proofs remain explicit barriers. This selector
  NEVER changes the D08 admission decision.

## Integrity and determinism

All input records are streamed; every D09 account in the watchlist is
conserved exactly once, its position counts/debt preserved, its underlying
assets matched to D08 authentic Aave role. Missing or duplicate proof, unsafe
or unknown compatibility status, malformed amount, anchor substitution and
look-ahead must fail closed. Ordered priority is count descending, then
canonical asset address ascending, with deterministic SHA-256 commitment.

The GitHub workflow authenticates both actual workflow runs, artifacts and
exact ZIP bytes on every run, executes offline adversarial tests and emits
one aggregate-only triage report, never the account-address watchlist.
The only success marker permitted is
`RMC015_AUXILIARY_COMPATIBILITY_TRIAGE_VERIFIED`; it is not RMC-015B, RMC-016,
or RMC-017 authority and does not demonstrate zero-own-capital profitability.
