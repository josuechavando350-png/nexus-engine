#![forbid(unsafe_code)]

pub const NEXUS_KERNEL_CONTRACT_VERSION: &str = "7.0.0";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MaturityState {
    Planned,
    Experimental,
    Implemented,
    Tested,
    Benchmarked,
    Integrated,
    OperationallyEvidenced,
    ProductionProven,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvidenceLevel {
    Claim,
    SourceInspection,
    StaticGate,
    UnitTest,
    IntegrationTest,
    BenchmarkReport,
    OperationsRecord,
    ProductionAudit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FabricDomain {
    EnterpriseOntology,
    ConnectorFabric,
    DecisionMemory,
    PolicyGraph,
    DurableWorkflows,
    AgentGovernance,
    ExecutionFabric,
    EvidencePlane,
    OutcomeIntelligence,
    Identity,
    MultiTenancy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdapterBoundary {
    SpecOnly,
    ReplaceableAdapter,
    ImplementationBoundary,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KernelContractRef {
    pub id: String,
    pub version: &'static str,
    pub domain: FabricDomain,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TenantRef {
    pub tenant_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrincipalRef {
    pub principal_id: String,
    pub tenant_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvidenceRef {
    pub evidence_id: String,
    pub level: EvidenceLevel,
    pub source: String,
    pub collected_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PolicyDecision {
    Allow,
    Deny,
    RequiresApproval,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyDecisionEnvelope {
    pub decision_id: String,
    pub tenant: TenantRef,
    pub principal: Option<PrincipalRef>,
    pub decision: PolicyDecision,
    pub reasons: Vec<String>,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FabricContractDescriptor {
    pub contract: KernelContractRef,
    pub maturity: MaturityState,
    pub evidence: Vec<EvidenceRef>,
    pub adapter_boundary: AdapterBoundary,
}

pub const FABRIC_DOMAINS: [FabricDomain; 11] = [
    FabricDomain::EnterpriseOntology,
    FabricDomain::ConnectorFabric,
    FabricDomain::DecisionMemory,
    FabricDomain::PolicyGraph,
    FabricDomain::DurableWorkflows,
    FabricDomain::AgentGovernance,
    FabricDomain::ExecutionFabric,
    FabricDomain::EvidencePlane,
    FabricDomain::OutcomeIntelligence,
    FabricDomain::Identity,
    FabricDomain::MultiTenancy,
];

pub fn contract_id_for(domain: FabricDomain) -> &'static str {
    match domain {
        FabricDomain::EnterpriseOntology => "nexus.v7.enterprise-ontology",
        FabricDomain::ConnectorFabric => "nexus.v7.connector-fabric",
        FabricDomain::DecisionMemory => "nexus.v7.decision-memory",
        FabricDomain::PolicyGraph => "nexus.v7.policy-graph",
        FabricDomain::DurableWorkflows => "nexus.v7.durable-workflows",
        FabricDomain::AgentGovernance => "nexus.v7.agent-governance",
        FabricDomain::ExecutionFabric => "nexus.v7.execution-fabric",
        FabricDomain::EvidencePlane => "nexus.v7.evidence-plane",
        FabricDomain::OutcomeIntelligence => "nexus.v7.outcome-intelligence",
        FabricDomain::Identity => "nexus.v7.identity",
        FabricDomain::MultiTenancy => "nexus.v7.multi-tenancy",
    }
}

pub fn fabric_contract_descriptor(domain: FabricDomain) -> FabricContractDescriptor {
    FabricContractDescriptor {
        contract: KernelContractRef {
            id: contract_id_for(domain).to_string(),
            version: NEXUS_KERNEL_CONTRACT_VERSION,
            domain,
        },
        maturity: MaturityState::Implemented,
        evidence: vec![EvidenceRef {
            evidence_id: format!("ev.v7.{:?}.contract", domain),
            level: EvidenceLevel::SourceInspection,
            source: "runtime/crates/nexus-kernel/src/lib.rs".to_string(),
            collected_at: "2026-08-15T00:00:00.000Z".to_string(),
        }],
        adapter_boundary: AdapterBoundary::SpecOnly,
    }
}

pub fn assert_kernel_ref(reference: &KernelContractRef) -> Result<(), &'static str> {
    if !reference.id.starts_with("nexus.v7.") {
        return Err("kernel contract id must use the nexus.v7 namespace");
    }

    if reference.version != NEXUS_KERNEL_CONTRACT_VERSION {
        return Err("kernel contract version is not supported by this crate");
    }

    if contract_id_for(reference.domain) != reference.id {
        return Err("kernel contract id does not match its domain");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_fabric_domains_have_spec_only_descriptors() {
        for domain in FABRIC_DOMAINS {
            let descriptor = fabric_contract_descriptor(domain);
            assert_eq!(descriptor.maturity, MaturityState::Implemented);
            assert_eq!(descriptor.adapter_boundary, AdapterBoundary::SpecOnly);
            assert_ne!(descriptor.maturity, MaturityState::ProductionProven);
            assert_kernel_ref(&descriptor.contract).unwrap();
        }
    }

    #[test]
    fn kernel_references_are_namespaced_and_versioned() {
        let bad = KernelContractRef {
            id: "nexus.v8.enterprise-ontology".to_string(),
            version: NEXUS_KERNEL_CONTRACT_VERSION,
            domain: FabricDomain::EnterpriseOntology,
        };

        assert!(assert_kernel_ref(&bad).is_err());
    }

    #[test]
    fn policy_decision_envelope_carries_evidence_without_authorizing_by_itself() {
        let envelope = PolicyDecisionEnvelope {
            decision_id: "decision-1".to_string(),
            tenant: TenantRef {
                tenant_id: "tenant-a".to_string(),
            },
            principal: Some(PrincipalRef {
                principal_id: "principal-a".to_string(),
                tenant_id: "tenant-a".to_string(),
            }),
            decision: PolicyDecision::RequiresApproval,
            reasons: vec!["high impact action".to_string()],
            evidence: vec![EvidenceRef {
                evidence_id: "ev-1".to_string(),
                level: EvidenceLevel::UnitTest,
                source: "runtime/crates/nexus-kernel/src/lib.rs".to_string(),
                collected_at: "2026-08-15T00:00:00.000Z".to_string(),
            }],
        };

        assert_eq!(envelope.decision, PolicyDecision::RequiresApproval);
        assert_eq!(envelope.evidence.len(), 1);
    }
}
