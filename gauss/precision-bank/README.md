# GAUSS independent precision bank — phase 1

This is a **measured subset**, not a universal mathematical accuracy certificate. The subject is the 1,000-operator registry on the GAUSS integration branch; this phase exercises exactly **12** finite-field polynomial operators, selected by immutable IDs. The other **988** operators remain **NOT EVALUATED by this bank** (irrespective of prior unit/integration tests).

## Run

From repository root with Node 24:

```sh
node --test gauss/tests/precision-bank-finite-polynomials-v1.test.mjs
node gauss/precision-bank/finite-polynomials-v1.mjs > precision-bank-v1.json
```

The first command runs exact comparisons, malformed-input rejection checks, a deliberate defective-implementation control, and determinism checks. The second command emits a JSON report and returns a nonzero exit code for any mismatch. The report captures the fixed seed, SHA-256 digest of ordered cases + expected results, per-operator counts, failures (first 20 fully described), and separate denominators for valid and malformed inputs. CI may capture the `GAUSS_PRECISION_BANK_V1=` line from the test log; this first phase does **not** write into the Git checkout during tests.

## Measurement contract

- **Population:** 12 named polynomial operators out of 1,000. All tests compare exact integer/array outputs, with zero tolerance. Numbers such as `1200/1200` describe only the 1,200 valid evaluated cases; `36/36` describes correct rejection of malformed inputs, separately. Neither is a claim that all 1,000 operators are correct.
- **Reference independence:** reference expected outputs use separate BigInt modular arithmetic and direct polynomial evaluation, do not import GAUSS's calculation helpers, and never derive expected values from GAUSS outputs. Product expands monomial pairs independently (same mathematical convolution identity, not a wholly different mathematical theorem). No third-party numerical oracle is used in this phase.
- **Data:** 100 deterministic cases per covered operator, seeded separately by operator ID, with varying prime moduli 2–13, negative coefficients, zero polynomials, leading zeros, and contract-boundary values. Three malformed-input controls per operator test composite modulus, unexpected keys, and nonintegral coefficients. Cases are visible, not a secret held-out data set; future external/held-out validation is still required.
- **Failure policy:** no result is discarded as “not applicable” after execution; every mismatch or unexpected throw counts as a failed valid case. Every malformed input accepted counts as a failed invalid-rejection case. Missing operators or changed registry denominator abort immediately. A deliberate defective target must be detected by the harness, not counted as Gauss evidence.
- **Limitations:** performance, numerical approximations, hardware quantum computation, cross-language reference checking, and the other 988 operators are **not evaluated here**. Next phases must pre-register the operators, domains, oracles, input distributions, condition-number/tolerance policy for approximate operators, and evaluation budgets before reporting their outcomes.
