# NEXUS Provider Execution Boundary

NEXUS uses a single-writer model for repository and motor mutations.

External model providers such as Anthropic Claude are advisory sources only unless they are explicitly elevated by a future governed executor boundary. Their outputs enter NEXUS as bounded, tenant-scoped, digest-bound proposals. A proposal is data, not authority: it cannot write GitHub state, mutate the semantic graph, approve transactions, deploy, or bypass policy.

The NEXUS executor remains the only component authorized to validate a proposal, apply capability checks, enforce budgets and approvals, perform the mutation through the governed GitHub/motor path, and record audit evidence. This keeps provider credentials and repository write authority out of advisory providers.

The same rule applies to any future provider: provider output -> structured proposal -> validation -> tenant/scope -> authorization/capability/budget/approval -> NEXUS executor -> audit/evidence -> output verification. There is no direct provider-to-GitHub or provider-to-graph write path.
