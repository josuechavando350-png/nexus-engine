# Experience Compiler V2

`compileExperiencePlan()` accepts:

- Experience Brief
- Experience DNA
- resolved capabilities
- one selected Recipe
- optional premium-capability requests
- additional constraints

It outputs a UI-agnostic `ExperiencePlan` containing:

- narrative sequence
- capability placements
- media strategy
- interaction strategy
- responsive strategy
- motion strategy
- Adaptive Luxury request
- constraints
- originality seed
- unresolved decisions

The compiler does **not** choose JSX, React components, CSS, fonts, colors, border radius or layout values. That boundary is deliberate: the compiler orchestrates intent and makes decisions inspectable without becoming a page builder.
