#![forbid(unsafe_code)]
use nexus_consensus::DeterministicConsensus;
use nexus_distributed::DistributedRuntime;
use nexus_placement::DeterministicPlacement;
fn main() {
    let consensus = DeterministicConsensus::default();
    let placement = DeterministicPlacement;
    let _runtime = DistributedRuntime {
        consensus: &consensus,
        placement: &placement,
    };
    println!("nexus clusterd: deterministic control skeleton ready; external consensus/network adapters are feature-gated future work");
}
