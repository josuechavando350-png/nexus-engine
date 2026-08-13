#![forbid(unsafe_code)]
use nexus_cluster::{Health, MemberState, NodeDescriptor, NodeId, NodeRole};
use nexus_consensus::DeterministicConsensus;
use nexus_distributed::{DistributedRuntime, DistributionIntent};
use nexus_placement::{DeterministicPlacement, WorkloadSpec};
fn node(id: &str, region: &str, cpu: u64) -> MemberState {
    MemberState {
        descriptor: NodeDescriptor {
            id: NodeId(id.into()),
            region: region.into(),
            zone: "z1".into(),
            role: NodeRole::Compute,
            capacity_cpu_millis: cpu,
            capacity_memory_bytes: 8 * 1024 * 1024 * 1024,
            labels: Default::default(),
        },
        health: Health::Healthy,
        epoch: 1,
        last_seen_ms: 0,
    }
}
fn main() {
    let nodes = vec![
        node("mx-edge-a", "mx", 8000),
        node("mx-edge-b", "mx", 4000),
        node("us-core-a", "us", 16000),
    ];
    let consensus = DeterministicConsensus::default();
    let placement = DeterministicPlacement;
    let runtime = DistributedRuntime {
        consensus: &consensus,
        placement: &placement,
    };
    let decision = runtime
        .schedule(
            DistributionIntent {
                request_id: "demo-1".into(),
                workload: WorkloadSpec {
                    id: "inspection".into(),
                    cpu_millis: 1000,
                    memory_bytes: 256 * 1024 * 1024,
                    required_role: Some(NodeRole::Compute),
                    required_region: Some("mx".into()),
                    required_labels: vec![],
                    anti_affinity_key: None,
                    latency_class: 1,
                },
                policy_evidence_id: "policy:v3:v5-approved".into(),
                artifact_digest: "sha256:demo".into(),
            },
            &nodes,
        )
        .expect("placement");
    println!(
        "selected={} commit_index={}",
        (decision.placement.selected).0,
        decision.commit_index
    );
}
