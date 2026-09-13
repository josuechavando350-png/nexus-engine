pub mod capsule;
mod hardware;
pub mod isolation;

use std::env;
use std::process::ExitCode;
use std::str::FromStr;

use capsule::{
    classify_exit, CancellationOwner, CancellationPolicy, CapabilityRequest,
    ChildProcessCapability, ExecutionCapsule, ExitObservation, FilesystemCapability,
};
use hardware::{
    assess_target, collect_host_facts, OPERATOR_SECONDARY_CAPACITY_BYTES,
    OPERATOR_SECONDARY_CAPACITY_LABEL, TARGET_CPU_VENDOR, TARGET_INSTALLED_RAM_BYTES,
    TARGET_SILICON_PROCESS,
};
use isolation::{assess_isolation_host, collect_isolation_host_facts, IsolationHostVerdict};
use walle_core::{
    is_valid_sha256, CertificationProfile, NetworkPolicy, ResourcePlan, RunMachine, RunState,
    WorkloadContract, ENGINE_NAME, ENGINE_VERSION,
};

fn usage() {
    eprintln!(
        "WALLE control core\n\n\
         Usage:\n\
           walle-core version\n\
           walle-core doctor\n\
           walle-core validate-sha <sha256:...>\n\
           walle-core transition <FROM> <TO>\n\
           walle-core plan <workload-id> <sha256:...> <FAST|HARDENED|CERTIFICATION>\n\
           walle-core capsule-contract <run-id> <workload-id> <sha256:...> <FAST|HARDENED|CERTIFICATION>\n\
           walle-core classify-exit <exit-code|NONE> <timed-out> <cancelled> <policy-violation> <well-formed>\n\
           walle-core hardware-contract\n\
           walle-core host-attest\n\
           walle-core isolation-host-preflight"
    );
}

fn command_version(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("version takes no arguments".to_owned());
    }
    println!("{ENGINE_NAME} {ENGINE_VERSION}");
    Ok(())
}

fn command_doctor(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("doctor takes no arguments".to_owned());
    }

    const SELF_TEST_SHA: &str =
        "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    let profile = CertificationProfile::Certification;
    let contract = WorkloadContract {
        workload_id: "walle-self-test",
        source_sha256: SELF_TEST_SHA,
        profile,
        network_policy: NetworkPolicy::DenyAll,
        resources: ResourcePlan::baseline(profile),
    };
    contract.validate().map_err(|error| error.to_string())?;

    let mut machine = RunMachine::new();
    for next in [
        RunState::Preparing,
        RunState::Isolated,
        RunState::Executing,
        RunState::Verifying,
        RunState::Certifying,
        RunState::Certified,
    ] {
        machine
            .transition(next)
            .map_err(|error| error.to_string())?;
    }

    println!("WALLE_DOCTOR=PASS");
    println!("ENGINE={ENGINE_NAME}");
    println!("VERSION={ENGINE_VERSION}");
    println!("DOCTOR_SCOPE=STATE_MACHINE_SELF_TEST");
    println!("STATE_MACHINE_SELF_TEST_FINAL_STATE={}", machine.state());
    println!("WALLE_CERTIFICATION_STATUS=NOT_EVALUATED");
    Ok(())
}

fn command_validate_sha(args: &[String]) -> Result<(), String> {
    if args.len() != 1 {
        return Err("validate-sha requires exactly one sha256 value".to_owned());
    }
    if !is_valid_sha256(&args[0]) {
        return Err("invalid lowercase sha256 identity".to_owned());
    }
    println!("VALID_SHA256={}", args[0]);
    Ok(())
}

fn command_transition(args: &[String]) -> Result<(), String> {
    if args.len() != 2 {
        return Err("transition requires FROM and TO states".to_owned());
    }
    let from = RunState::from_str(&args[0]).map_err(|error| error.to_string())?;
    let to = RunState::from_str(&args[1]).map_err(|error| error.to_string())?;
    if !from.can_transition_to(to) {
        return Err(format!("invalid WALLE state transition: {from} -> {to}"));
    }
    println!("TRANSITION={from}->{to}");
    Ok(())
}

fn command_plan(args: &[String]) -> Result<(), String> {
    if args.len() != 3 {
        return Err(
            "plan requires workload-id, lowercase sha256 identity, and certification profile"
                .to_owned(),
        );
    }

    let profile = CertificationProfile::from_str(&args[2]).map_err(|error| error.to_string())?;
    let resources = ResourcePlan::baseline(profile);
    let contract = WorkloadContract {
        workload_id: &args[0],
        source_sha256: &args[1],
        profile,
        network_policy: NetworkPolicy::DenyAll,
        resources,
    };
    contract.validate().map_err(|error| error.to_string())?;

    println!("engine={ENGINE_NAME}");
    println!("version={ENGINE_VERSION}");
    println!("workload_id={}", contract.workload_id);
    println!("source_sha256={}", contract.source_sha256);
    println!("profile={}", contract.profile);
    println!("network_policy={}", contract.network_policy);
    println!("cpu_cores={}", contract.resources.cpu_cores);
    println!("memory_mib={}", contract.resources.memory_mib);
    println!("wall_time_seconds={}", contract.resources.wall_time_seconds);
    println!("pid_limit={}", contract.resources.pid_limit);
    println!("scratch_disk_mib={}", contract.resources.scratch_disk_mib);
    Ok(())
}

fn command_capsule_contract(args: &[String]) -> Result<(), String> {
    if args.len() != 4 {
        return Err(
            "capsule-contract requires run-id, workload-id, lowercase sha256 identity, and certification profile"
                .to_owned(),
        );
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
            filesystem: FilesystemCapability::ReadOnlyInputs,
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

    println!(
        "{}",
        capsule
            .canonical_json()
            .map_err(|error| error.to_string())?
    );
    Ok(())
}

fn command_classify_exit(args: &[String]) -> Result<(), String> {
    if args.len() != 5 {
        return Err(
            "classify-exit requires exit-code|NONE, timed-out, cancelled, policy-violation, and well-formed"
                .to_owned(),
        );
    }

    let exit_code = if args[0] == "NONE" {
        None
    } else {
        Some(
            args[0]
                .parse::<i32>()
                .map_err(|_| "exit-code must be an i32 or NONE".to_owned())?,
        )
    };
    let observation = ExitObservation {
        exit_code,
        timed_out: parse_bool("timed-out", &args[1])?,
        cancelled: parse_bool("cancelled", &args[2])?,
        policy_violation: parse_bool("policy-violation", &args[3])?,
        output_well_formed: parse_bool("well-formed", &args[4])?,
    };
    println!("EXIT_CLASS={}", classify_exit(observation).as_str());
    Ok(())
}

fn parse_bool(name: &str, value: &str) -> Result<bool, String> {
    match value {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(format!("{name} must be exactly true or false")),
    }
}

fn command_hardware_contract(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("hardware-contract takes no arguments".to_owned());
    }

    println!("engine={ENGINE_NAME}");
    println!("target_cpu_vendor_id={TARGET_CPU_VENDOR}");
    println!("target_silicon_process={TARGET_SILICON_PROCESS}");
    println!("target_installed_ram_bytes={TARGET_INSTALLED_RAM_BYTES}");
    println!("target_virtualization=Intel VT-x / VMX");
    println!("operator_secondary_capacity_label={OPERATOR_SECONDARY_CAPACITY_LABEL}");
    println!("operator_secondary_capacity_bytes={OPERATOR_SECONDARY_CAPACITY_BYTES}");
    println!("operator_secondary_capacity_component=UNRESOLVED");
    Ok(())
}

fn command_host_attest(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("host-attest takes no arguments".to_owned());
    }

    let assessment = assess_target(collect_host_facts().map_err(|error| error.to_string())?);

    println!("engine={ENGINE_NAME}");
    println!("target_silicon_process={TARGET_SILICON_PROCESS}");
    println!("target_installed_ram_bytes={TARGET_INSTALLED_RAM_BYTES}");
    println!("observed_architecture={}", assessment.facts.architecture);
    print_optional(
        "observed_cpu_vendor_id",
        assessment.facts.cpu_vendor_id.as_deref(),
    );
    print_optional(
        "observed_cpu_model_name",
        assessment.facts.cpu_model_name.as_deref(),
    );
    println!("observed_vmx_present={}", assessment.facts.vmx_present);
    print_optional_u64(
        "observed_usable_memory_bytes",
        assessment.facts.usable_memory_bytes,
    );
    print_optional(
        "observed_system_vendor",
        assessment.facts.system_vendor.as_deref(),
    );
    print_optional(
        "observed_product_name",
        assessment.facts.product_name.as_deref(),
    );
    println!("vendor_verified={}", assessment.vendor_verified);
    println!("vmx_verified={}", assessment.vmx_verified);
    println!(
        "silicon_process_verified={}",
        assessment.silicon_process_verified
    );
    println!(
        "installed_ram_verified={}",
        assessment.installed_ram_verified
    );
    println!(
        "secondary_capacity_component_resolved={}",
        assessment.secondary_capacity_component_resolved
    );
    println!(
        "secondary_capacity_verified={}",
        assessment.secondary_capacity_verified
    );
    println!("hardware_verdict={}", assessment.verdict.as_str());
    println!("hardware_reason={}", assessment.reason);

    Err(format!(
        "target hardware is not fully attested: {}",
        assessment.reason
    ))
}

fn command_isolation_host_preflight(args: &[String]) -> Result<(), String> {
    if !args.is_empty() {
        return Err("isolation-host-preflight takes no arguments".to_owned());
    }

    let assessment = assess_isolation_host(collect_isolation_host_facts());
    println!("engine={ENGINE_NAME}");
    println!("isolation_backend_target=FIRECRACKER_MICROVM");
    println!("observed_os={}", assessment.facts.os);
    println!("observed_architecture={}", assessment.facts.architecture);
    print_optional_u32("observed_effective_uid", assessment.facts.effective_uid);
    println!("kvm_exists={}", assessment.facts.kvm_exists);
    println!(
        "kvm_is_character_device={}",
        assessment.facts.kvm_is_character_device
    );
    println!(
        "kvm_open_read_write={}",
        assessment.facts.kvm_open_read_write
    );
    println!("cgroup_v2={}", assessment.facts.cgroup_v2);
    println!(
        "cgroup_controllers={}",
        assessment.facts.cgroup_controllers.join(",")
    );
    println!(
        "seccomp_actions={}",
        assessment.facts.seccomp_actions.join(",")
    );
    println!("linux_verified={}", assessment.linux_verified);
    println!("x86_64_verified={}", assessment.x86_64_verified);
    println!(
        "privileged_supervisor_verified={}",
        assessment.privileged_supervisor_verified
    );
    println!("kvm_verified={}", assessment.kvm_verified);
    println!("cgroup_v2_verified={}", assessment.cgroup_v2_verified);
    println!(
        "cgroup_controllers_verified={}",
        assessment.cgroup_controllers_verified
    );
    println!("seccomp_verified={}", assessment.seccomp_verified);
    println!("isolation_host_verdict={}", assessment.verdict.as_str());
    println!("isolation_host_reason={}", assessment.reason);

    if assessment.verdict == IsolationHostVerdict::Ready {
        Ok(())
    } else {
        Err(format!(
            "microVM host prerequisites are not ready: {}",
            assessment.reason
        ))
    }
}

fn print_optional(key: &str, value: Option<&str>) {
    println!("{key}={}", value.unwrap_or("UNAVAILABLE"));
}

fn print_optional_u64(key: &str, value: Option<u64>) {
    match value {
        Some(value) => println!("{key}={value}"),
        None => println!("{key}=UNAVAILABLE"),
    }
}

fn print_optional_u32(key: &str, value: Option<u32>) {
    match value {
        Some(value) => println!("{key}={value}"),
        None => println!("{key}=UNAVAILABLE"),
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    let Some(command) = arguments.next() else {
        usage();
        return Err("missing command".to_owned());
    };
    let rest: Vec<String> = arguments.collect();

    match command.as_str() {
        "version" => command_version(&rest),
        "doctor" => command_doctor(&rest),
        "validate-sha" => command_validate_sha(&rest),
        "transition" => command_transition(&rest),
        "plan" => command_plan(&rest),
        "capsule-contract" => command_capsule_contract(&rest),
        "classify-exit" => command_classify_exit(&rest),
        "hardware-contract" => command_hardware_contract(&rest),
        "host-attest" => command_host_attest(&rest),
        "isolation-host-preflight" => command_isolation_host_preflight(&rest),
        _ => {
            usage();
            Err(format!("unknown command: {command}"))
        }
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("WALLE_ERROR={error}");
            ExitCode::from(2)
        }
    }
}
