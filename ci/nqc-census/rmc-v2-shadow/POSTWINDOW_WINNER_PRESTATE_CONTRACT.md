# Historical predecessor account gate

The two authenticated WETH/USDC and WETH/USDT competitor receipts from PR #694
prove successful historical execution, but do not show that the borrowers were
already below HF=1 at the end of the previous block. That is the next falsifiable
gate for reconstructing these selected cases.

`postwindow_winner_prestate.py` authenticates the exact indexer and receipt ZIPs,
revalidates receipt/event identity and winner headers, links each predecessor,
and reads Aave's six-word `getUserAccountData` ABI at its canonical block hash.
Two allowed RPC endpoints must match all normalized state bytes and identities.
Before/after header and chain checks reject inconsistent observations. Endpoint
agreement is not independently verified RPC-operator independence.

The result retains exact ABI, integer HF, account totals, parent timestamp and
state root, winner transaction index, raw RPC result objects, observation times,
request duration, source hashes, code commit/tree and errors. Transport JSON
formatting is not retained; transcript stores parsed RPC result objects. Every
attempt uses a new output directory; no state override, latest fallback, signing,
submission, gas payment, wallet, deployment or recurring service is supported.

## Interpretation

- `NO_DEBT_AT_PREDECESSOR`: no prior debt, no HF trigger.
- `HF_NOT_BELOW_ONE_AT_PREDECESSOR`: no prior HF trigger. Same-block oracle changes,
  interest/time and earlier transactions may matter; their causal role is UNKNOWN.
- `HF_BELOW_ONE_REQUIRES_EXECUTION_RECONSTRUCTION`: necessary HF condition observed;
  reserve rules, exact liquidation size, route, repayment, gas and net outcome remain
  unverified. This is never automatic trading eligibility.

End-of-parent state is NOT the state immediately before the winner transaction.
Even a transaction at index zero runs with the winner block timestamp/environment.
A subsequent fork test must explicitly distinguish time-only advancement from
replay of earlier transactions/oracle changes and avoid overwriting oracle state.
Selection was made using future winning transactions; this is retrospective.

## Reproduction

Run `python3 -m unittest discover -s ci/nqc-census/rmc-v2-shadow -p
 'test_postwindow_winner_prestate.py' -v` (on one line), then the producer with
`--indexer-artifact`, `--receipt-artifact` and a fresh `--out-dir`.

Source indexer run 38487719497 / artifact 11860545203 / commit
ccd91241ceaa342ed40767be8104860fd4886715. Source receipt run 38490008728 /
artifact 11860624437 / commit 1908bfc36375e79ddf057278f6f02fd9d829a0dc.
Both ZIP digests are pinned in the producer/source module and the CI workflow.
Unavailable or expired source evidence blocks reproduction rather than permitting
synthetic substitution. The workflow archives positive and negative attempts.

RMC OPEN; Shadow P2 uncertified; LIVE not authorized; NQC P&L USD 0.
This gate does not establish monthly income, capture, sponsor or full census.
