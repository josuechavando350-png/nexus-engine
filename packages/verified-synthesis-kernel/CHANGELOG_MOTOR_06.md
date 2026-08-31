# Motor #6 — Verified Synthesis Kernel

Adds `@nexus/verified-synthesis-kernel` as a bounded synthesis and verification layer that reuses NEXUS's existing formal/evidence architecture rather than replacing topology or proof-carrying experience.

The kernel provides typed IR validation, bounded equality saturation, internal bounded solving, real external SMT/SyGuS process adapters, runtime/browser counterexample adapters, CEGIS refinement, deterministic verification, structural proof-carrying outputs, an operational runtime, and CLI execution.

No external solver, browser harness, runtime harness, Lean proof, zkVM proof, deployment, provider action, or business outcome is fabricated. Missing external infrastructure remains `UNAVAILABLE`, exhausted bounded search remains `NOT_VERIFIED`, and timeouts remain `TIMEOUT`.
