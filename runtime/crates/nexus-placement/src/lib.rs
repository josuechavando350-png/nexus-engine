//! Deterministic constraint-first workload placement. Schedulers are adapters.
#![forbid(unsafe_code)]
use nexus_cluster::{Health, MemberState, NodeId, NodeRole};
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkloadSpec {
    pub id: String,
    pub cpu_millis: u64,
    pub memory_bytes: u64,
    pub required_role: Option<NodeRole>,
    pub required_region: Option<String>,
    pub required_labels: Vec<(String, String)>,
    pub anti_affinity_key: Option<String>,
    pub latency_class: u8,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateScore {
    pub node: NodeId,
    pub score: i64,
    pub reasons: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlacementDecision {
    pub workload_id: String,
    pub selected: NodeId,
    pub ranked: Vec<CandidateScore>,
}
pub trait PlacementPolicy: Send + Sync {
    fn place(
        &self,
        spec: &WorkloadSpec,
        nodes: &[MemberState],
    ) -> Result<PlacementDecision, String>;
}
#[derive(Debug, Default)]
pub struct DeterministicPlacement;
impl PlacementPolicy for DeterministicPlacement {
    fn place(&self, s: &WorkloadSpec, nodes: &[MemberState]) -> Result<PlacementDecision, String> {
        if s.id.trim().is_empty() {
            return Err("workload id required".into());
        }
        if s.cpu_millis == 0 || s.memory_bytes == 0 {
            return Err("workload CPU and memory requests must be positive".into());
        }
        if s.anti_affinity_key.is_some() {
            return Err("anti-affinity requires placement-state adapter; deterministic baseline refuses to ignore it".into());
        }
        let mut ranked = Vec::new();
        for n in nodes {
            if n.health != Health::Healthy {
                continue;
            }
            if n.descriptor.capacity_cpu_millis < s.cpu_millis
                || n.descriptor.capacity_memory_bytes < s.memory_bytes
            {
                continue;
            }
            if s.required_role.is_some() && s.required_role != Some(n.descriptor.role) {
                continue;
            }
            if let Some(r) = &s.required_region {
                if &n.descriptor.region != r {
                    continue;
                }
            }
            if !s
                .required_labels
                .iter()
                .all(|(k, v)| n.descriptor.labels.get(k) == Some(v))
            {
                continue;
            }
            let spare_cpu = n.descriptor.capacity_cpu_millis - s.cpu_millis;
            let spare_mem = (n.descriptor.capacity_memory_bytes - s.memory_bytes) / 1_048_576;
            let cpu_score = (spare_cpu / 10).min(i64::MAX as u64) as i64;
            let memory_score = spare_mem.min(i64::MAX as u64) as i64;
            ranked.push(CandidateScore {
                node: n.descriptor.id.clone(),
                score: cpu_score.saturating_add(memory_score),
                reasons: vec!["hard constraints satisfied".into()],
            });
        }
        ranked.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.node.cmp(&b.node)));
        let selected = ranked.first().ok_or("no feasible placement")?.node.clone();
        Ok(PlacementDecision {
            workload_id: s.id.clone(),
            selected,
            ranked,
        })
    }
}
