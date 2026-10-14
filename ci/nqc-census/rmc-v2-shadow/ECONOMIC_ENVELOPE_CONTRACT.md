# NQC V2 — Economic envelope contract (historical sensitivity only)

## Evidence and identity

The ONLY accepted producer is PR #698, workflow 38498693805 (SUCCESS), commit
156e106c2efcd8bcb7f4931be3daa98309bd770b, tree
233afb3f65f562f9a045ad2f4e03ee35b71da7a8, artifact 11865385506, ZIP
SHA-256 6778f8e190d13c739331f731ca532d8607e3f653ca000de746b058b4903c7d7d.

The GitHub Actions gate independently authenticates workflow, commit, artifact
metadata and ZIP. The analyzer authenticates SHA-256 of the ZIP, all 112
content-addressed manifest members, producer commit/tree, parent dependency
digests, exact two-endpoint output parity, repayment identity, flash-fee
rounding, selected-case numeric witnesses, rollback and all negative claim
fields. The full prior attribution workflow PR #696 FAILED on provider 429:
the successful subsequent PR #698 route gate does not convert that failure
into PASS.

## Measured historical evidence (not NQC profits)

| Case | Token surplus after DEX fill and flash fee | Internal gasleft delta | Historic block base fee |
|---|---:|---:|---:|
| WETH collateral / USDC debt, block 26,142,067 | 2,273.989378 USDC | 1,115,038 gas | 1,086,577,108 wei/gas |
| WETH collateral / USDT debt, block 26,149,038 | 150.882941 USDT | 948,267 gas | 2,504,340,523 wei/gas |

The internal gasleft delta is NOT a standalone transaction receipt gasUsed
or defensible upper/lower bound on production gas: the test deploys a harness,
warms storage and runs a local fork. It EXCLUDES calldata/intrinsic gas,
deployment, EOA cold accesses, gas refunds, builder inclusion fees, sponsorship
and failed submissions. The observed historical swaps belonged to other
operators and were retrospectively selected.

## Explicitly synthetic grid

- Assumed full transaction gas: 1,250,000 / 1,750,000 / 2,500,000 units.
- Assumed priority fees: 1 / 5 / 25 gwei, in addition to authenticated
  historical block base fees.
- Assumed ETH/USD: 2,000 / 3,000 / 4,000 USD per ETH.
- Assumed builder payment: 0 or 100 USD.
- Assumed failed-attempt allowance: 0 or 100 USD.
- Assumed sponsor fee: 0 or 100 USD; no sponsor is contracted.
- USDT and USDC tentatively valued at exactly one dollar solely for sensitivity.

All mathematics uses integers; gas USD micro-units are rounded upward.
There are 216 parameter combinations per historical candidate. Positive
residuals in the grid ARE NOT probabilities or expected P&L.

When processed against the exact producer ZIP, the observed envelope is:
USDC 216/216 hypothetical positive residuals (1713.123606 to
2268.772935 USD-equivalent under assumptions); USDT 69/216 hypothetical
positive residuals (-424.160465 to 142.122089 USD-equivalent under
assumptions). No count is a win rate or probability of profitable capture.

## Non-negotiable negative authority

Outputs MUST carry status HISTORICAL_SENSITIVITY_ONLY_NO_NET_OR_CAPTURE_AUTHORITY.
Even 216/216 positive hypothetical residuals cannot certify realized net
income, zero-operator-capital funding, prospectively accessible trigger or
competitive win rate. Negative flags are fixed for gasUsed authority, ETH/USD
and stablecoin prices, builder payments, failed attempts, sponsor, prospective
detection/inclusion, capital feasibility, Shadow P2, RMC closure, Canary,
commercial score upgrade and real P&L (USD 0). No keys, signatures, on-chain
writes, orders, RPC scans, server deployments or costs are introduced.

This analyzer NEVER ranks 216 scenarios as market samples or aggregates the two
historic competitors into a monthly NQC forecast.

## Reproduction

Download the exact artifact 11865385506 from its GitHub Actions page.
Use Python 3 standard library only:

    python3 -m unittest discover -s ci/nqc-census/rmc-v2-shadow \
      -p test_postwindow_economic_envelope.py -v

    python3 ci/nqc-census/rmc-v2-shadow/postwindow_economic_envelope.py \
      --source-artifact /path/to/11865385506.zip \
      --out /path/to/new-sensitivity-output.json

CI verifies the downloaded archive and preserves the source-code SHA, tree,
all tests, source ZIP, negative output, errors and content-addressed manifest.
A failed or expired upstream artifact MUST block the gate rather than fall
back to unauthenticated figures.

## Next falsifiable result

Measure full, cold, standalone transaction gas at the exact historical
pre-winner state (including calldata and deployment strategy), establish how
the ETH/USD oracle transaction becomes accessible before inclusion, and
obtain actual external non-recourse gas funding. Until then economic capture,
probabilities and monthly USD 45k–55k are unproven, realized P&L remains USD 0.
