# Experience DNA V2

`ExperienceDNA` describes **intent**, never component selection.

It captures normalized, justified dimensions for composition, density, geometry, typography, media, navigation, interaction, CTA grammar and motion, plus open vocabulary for the art direction.

Every numeric intent is constrained to `0..1` and every dimension requires a rationale answering the standing Design Originality Gate question:

> Why does THIS Experience need this decision?

A DNA value such as `composition.asymmetry = 0.9` does not mean “use this layout”. It means the implementation should preserve a high degree of deliberate imbalance for the reason attached to that decision.

## Open vocabulary

Labels such as `editorial`, `cinematic`, `industrial`, `brutalist`, `quiet luxury` or a completely new term are descriptive vocabulary only. The engine contains no mapping from those words to Hero/Card/Button variants.

## Not allowed

Experience DNA must not carry implementation fields such as `component`, `className`, `CSS`, `fontFamily`, `borderRadius`, `buttonVariant`, `cardVariant` or `heroVariant`. Runtime guards and tests enforce this direction.
