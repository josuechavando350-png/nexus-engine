# Visual Entropy — research note, not implemented

## The question asked

Can we measure how concentrated an Experience is around a few repeated
composition patterns, versus a coherent variety of them? Not a quality
score — a descriptive signal only.

## Is the underlying math real?

Yes. Shannon entropy over a finite, well-defined set of categories is
legitimate and well-precedented (it is how "type-token ratio" works in
linguistics, and how several HCI "visual complexity" metrics are built).
Given a page broken into composition-primitive occurrences — say
`card`, `media-block`, `editorial-text`, `structured-list`,
`interactive-region`, `negative-space-block` — entropy
`H = -Σ p_i · log(p_i)` over the observed distribution is a real,
computable, meaningful number *for that alphabet*.

So: **not pseudoscience as a construct.** The risk is entirely in how it
would be applied here, today.

## Why it would be premature right now

1. **No defined alphabet yet.** The categories above are illustrative,
   not derived from real Experiences. Whatever alphabet gets chosen
   directly determines the number — an arbitrary or too-coarse/fine
   alphabet makes the entropy value arbitrary too, before any real
   analysis happens.
2. **No sample to compute it from.** Zero reference implementations exist
   today. A statistic computed from n=0 (or n=1, once `_template-client`
   is the only real specimen) is not evidence of anything.
3. **It would conflate "rich" with "just used more Style Fingerprint
   tags."** If entropy is computed directly from `StyleFingerprintV0`
   dimension values, a page could score "high entropy" simply by
   touching more `custom` labels, without that meaning anything about
   actual visual richness or coherence.
4. **High entropy is not a quality signal, and the user is already
   correct to flag that risk.** A cluttered, incoherent page can have
   high entropy; a calm, intentional, minimal page can have deliberately
   low entropy. Nothing here should be read as "more entropy = better."

## Conclusion

Do not discard the concept outright — the math holds up and the question
("are we structurally repeating ourselves?") is a real one worth having
an answer to eventually. But do not give it a number yet. Revisit only
after:

- `StyleFingerprintV0` has been applied by hand to at least the three
  planned reference implementations plus a small number of real client
  sites (enough samples for a distribution to mean anything), and
- a composition-primitive alphabet has been derived from what was
  actually observed, not invented in advance.

Until then, treat "visual entropy" as a research direction referenced in
this document, not a metric NEXUS reports anywhere.

## Explicitly out of scope for V1.1 Phase 1

No implementation, no formula wired into any tool, no score attached to
any Experience.
