# NEXUS V6 Threat Model

## New assets
Cluster membership, consensus log, replica watermarks, placement decisions, discovery leases, federation grants, workload identities, fleet state and release metadata.

## Primary threats
- split brain and stale leaders;
- Byzantine or compromised edge node attempting stale re-enrollment;
- replayed membership/federation/update messages;
- forged workload identity;
- malicious discovery registration;
- poisoned placement metadata;
- region partition and asymmetric connectivity;
- offline journal tampering or rollback;
- duplicate execution after reconnection;
- federation privilege escalation;
- compromised update repository/signing workflow;
- rollback/freeze attacks on updates;
- mesh credential theft;
- compromised scheduler attempting policy bypass;
- supply-chain compromise of consensus/network/update adapters.

## Non-negotiable controls
- distribution cannot bypass V3 policy/simulation/approval;
- workload identity is short-lived and attested where supported;
- membership/federation/update state is versioned and replay-resistant;
- stale node resurrection requires explicit re-enrollment;
- signed release verification occurs before staging;
- rollback floors are enforced locally;
- offline reconciliation surfaces conflicts;
- all control transitions emit evidence/audit records when integrated with V5;
- no unmeasured claims of Byzantine fault tolerance, zero trust, five-nines availability or real-time behavior.
