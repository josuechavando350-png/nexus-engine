#[path = "../capsule.rs"]
mod capsule;
#[path = "../isolation.rs"]
mod isolation;
#[path = "../microvm.rs"]
mod microvm;

use std::env;
use std::process::ExitCode;
use std::str::FromStr;

use capsule::{
    CancellationOwner, CancellationPolicy, CapabilityRequest, ChildProcessCapability,
    ExecutionCapsule, FilesystemCapability,
};
use isolation::collect_isolation_host_facts;
use microvm::{build_microvm_plan, MicroVmImageSet};
use walle_core::{CertificationProfile, NetworkPolicy, ResourcePlan};

fn usage() {
    eprintln!(
        "Usage: walle-microvm-plan <run-id> <workload-id> <source-sha256> <FAST|HARDENED|CERTIFICATION> <kernel-sha256> <rootfs-sha256>"
    );
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() != 6 {
        usage();
        return Err("microVM plan requires exactly six arguments".to_owned());
    }

    let profile = CertificationProfile::from_str(&args[3]).map_err(|error| error.to_string())?;
    let resources = ResourcePlan::baseline(profile);
    let timeout_ms = resources
        .wall_time_seconds
        .checked_mul(1_000)
        .ok_or_else(|| "resource wall-time overflow".to_owned())?;
    let capsule = ExecutionCapsule {
        run_id: &args[0],
        attempt: 1,
        adapter_id: "generic-command-v1",
        adapter_version: "1.0.0",
        workload_id: &args[1],
        source_sha256: &args[2],
        profile,
        resources,
        capabilities: CapabilityRequest {
            filesystem: FilesystemCapability::ScratchAndDeclaredOutput,
            network: NetworkPolicy::DenyAll,
            network_allowlist: &[],
            child_processes: ChildProcessCapability::Bounded,
            secret_names: &[],
            device_names: &[],
        },
        timeout_ms,
        max_stdout_bytes: 64 * 1024 * 1024,
        max_stderr_bytes: 64 * 1024,
        cancellation: CancellationPolicy {
            owner: CancellationOwner::WalleControlPlane,
            grace_ms: 5_000,
        },
    };
    let images = MicroVmImageSet {
        kernel_sha256: &args[4],
        rootfs_sha256: &args[5],
    };
    let plan = build_microvm_plan(capsule, collect_isolation_host_facts(), images)
        .map_err(|error| error.to_string())?;
    println!("{}", plan.canonical_json());
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("WALLE_MICROVM_PLAN_ERROR={error}");
            ExitCode::from(2)
        }
    }
}
