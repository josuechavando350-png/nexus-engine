# H-06 schema write contracts

The active schema is executable policy for writes, not documentation.

Object CREATE/UPDATE must enforce declared property membership, scalar value kind, required cardinality, immutable semantics and uniqueness inside the ontology scope. Invalid writes must fail before commit and must not partially mutate state.
