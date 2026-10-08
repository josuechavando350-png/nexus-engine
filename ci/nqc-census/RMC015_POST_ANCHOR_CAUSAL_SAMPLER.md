# RMC-015B — Decision-time fixed cohort, real post-anchor Aave observation (research-only)

## Why this is different from competitor-winner hindsight

The authenticated D08/D09 Ethereum Aave anchor is **block 26,095,351** (hash `0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781`). Its full 246,929 state-verified account manifest contains 28,275 debt-bearing accounts. Exact original [PR #605](https://github.com/josuechavando350-png/nexus-engine/pull/605) material frontier source Git blob `5542bbec0840335994cbbab272e6228756ba6eb0` pinpoints **857 HEALTHY, MATERIAL-RISK accounts**, health factors in [1,1.2), each at least 10,000 Aave oracle-base currency units of debt. Original D08 and D09 independent full account ZIP sources are source and sha checked before materializing an ephemeral local watchlist in CI. Previous summary outputs intentionally contained no addresses and no positive income claims.

This PR is the first strictly post-selection **sampled** follow-up of this exact pre-existing watchlist: choose six lowest health factors AT THE ANCHOR and six deterministic SHA256-selected controls AT THE ANCHOR. **No future winning transaction, liquidation receipt, builder observation or eventual state enters sampling.** Then authenticate the Aave V3 Pool real `getUserAccountData(address)` with two independent Ethereum RPC providers at anchor block, anchor+1, and anchor+7200. The 12 sampled addresses are derived inside CI and never published as an artifact. The public onchain identities remain public but are not needed for user-facing reporting.

Each provider must agree on chain, canonical anchor/future block hashes and state roots, and exact six-word Aave account state. The Aave original D09 source debt and health factor must match the true deployed Pool onchain `eth_call` at anchor. Reorg, wrong chain, counterfeit provider, changed account, malformed ABI and lookahead fail closed.

This is not a bot. It samples two later endpoint states and counts snapshot HF<1, healthy or debt closed. **It does not show when HF crossed, whether a liquidation was possible during the period, whether any third-party won, gas availability, bid schedule, or NQC profits.** Historical calls made in October 2026 are not timestamped evidence that an actual NQC system saw the event in real time. Two endpoints are **NOT** an exhaustive period census.

## Source authority

- D08 workflow run 36964016388, source head `36c732a36789e1967ce7178010889427ad7cf0f2`, artifact 11237887761, ZIP SHA256 `9431ea07144ae78e68e0ffcc7f650fa32068ee63fb53ca41ff8a062b87845913`.
- D09 workflow run 36823489219, source head `6db82ca89d4ef3a66a1b236de95670a6967eb3ea`, artifact 11159396055, ZIP SHA256 `9aa6a4beb3ebc90f40d07d1889f84c1bcf94b3dea90b0e7b596dc6ff70fda0f6`.
- Original exactly source-authenticated PR #605 material frontier selector source blob `5542bbec0840335994cbbab272e6228756ba6eb0`. Retrieved and sha checked, not copied into PR branch.
- This probe is appended to the exact #644 head `a2e7efd233682efc051c1ace4284c9a8156d9c77`, which reports unclosed Census terminal sources.

## Output authority and the next economic step

Produces a hashed aggregate sample report with statuses and timestamp provenance only, never a URL/API key/private position list or winning address. Hard flags: no endogenous source-financing admission, no generated shadow signals, no genuine builder bids, no actual Nexus liquidation, no realized profit, and no certified monthly target. A positive HF crossing must later pass *full actionability and cost/inclusion* to be worth pursuing.

To convert to a credible economic opportunity study: expand from 12 fixed upfront candidates to all 857 and then complete event-driven trigger **episode** timelines with independently proven block-by-block visibility; evaluate the actual opportunity before transaction inclusion; bring in real gas sponsor liability economics and builder/auction bids. Apply out-of-sample competition calibration before Shadow can estimate capture.

The technical literature [Aave V3/V4 bot forum August–September 2026](https://governance.aave.com/t/aave-v3-v4-liquidation-bot/25565) provides a cautionary **researcher-reported** specific example: $614.56 gross bonus, but $530.10 builder payment and zero retained value in one traced winner. This is not an average and is not taken as a certified NQC transaction economics input. Aave's own [SVR research](https://aave.org/blog/historical-liquidations) confirms protocol recapture changes the execution economics. To beat established searchers we need demonstrable net retained value and distinctive early visibility, not headline gross bonuses.

**Terminal gates remain unchanged:** zero NQC external approved gas sponsors, Census not closed, no confirmed Nexus income. No trade, no costly service signup, no user capital, no main merge.
