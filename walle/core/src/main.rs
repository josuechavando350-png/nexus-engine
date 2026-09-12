mod hardware;

use std::env;
use std::process::ExitCode;
use std::str::FromStr;

use hardware::{
    assess_target, collect_host_facts, OPERATOR_SECONDARY_CAPACITY_BYTES,
    OPERATOR_SECONDARY_CAPACITY_LABEL, TARGET_CPU_VENDOR, TARGET_INSTALLED_RAM_BYTES,
    TARGET_SILICON_PROCESS,
};
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
           walle-core hardware-contract\n\
           walle-core host-attest"
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
    println!("STATE={}", machine.state());
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
    print_optional("observed_cpu_vendor_id", assessment.facts.cpu_vendor_id.as_deref());
    print_optional("observed_cpu_model_name", assessment.facts.cpu_model_name.as_deref());
    println!("observed_vmx_present={}", assessment.facts.vmx_present);
    print_optional_u64(
        "observed_usable_memory_bytes",
        assessment.facts.usable_memory_bytes,
    );
    print_optional("observed_system_vendor", assessment.facts.system_vendor.as_deref());
    print_optional("observed_product_name", assessment.facts.product_name.as_deref());
    println!("vendor_verified={}", assessment.vendor_verified);
    println!("vmx_verified={}", assessment.vmx_verified);
    println!(
        "silicon_process_verified={}",
        assessment.silicon_process_verified
    );
    println!("installed_ram_verified={}", assessment.installed_ram_verified);
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

fn print_optional(key: &str, value: Option<&str>) {
    println!("{key}={}", value.unwrap_or("UNAVAILABLE"));
}

fn print_optional_u64(key: &str, value: Option<u64>) {
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
        "hardware-contract" => command_hardware_contract(&rest),
        "host-attest" => command_host_attest(&rest),
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
