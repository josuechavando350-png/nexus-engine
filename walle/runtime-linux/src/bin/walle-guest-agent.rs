use std::env;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs;
use std::process::{Command, ExitCode};

use walle_core::is_valid_sha256;

const RUN_ID_PREFIX: &str = "walle.run_id=";
const SOURCE_SHA_PREFIX: &str = "walle.source_sha256=";
const PROTOCOL_ARG: &str = "walle.guest_protocol=1";
const ATTESTATION_PREFIX: &str = "WALLE_GUEST_ATTESTATION_V1";
const PR_SET_NO_NEW_PRIVS: i32 = 38;

unsafe extern "C" {
    fn prctl(option: i32, arg2: u64, arg3: u64, arg4: u64, arg5: u64) -> i32;
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BootIdentity {
    run_id: String,
    source_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ProcessSecurityState {
    seccomp_mode: u8,
    no_new_privs: bool,
}

#[derive(Debug)]
enum AgentError {
    Usage,
    InvalidKernelCommandLine,
    InvalidRunId,
    InvalidSourceSha256,
    NoNewPrivilegesFailed,
    InvalidProcessStatus,
    NetworkInspectionFailed,
    NetworkInterfaceOverflow,
    WorkloadSpawnFailed,
}

impl Display for AgentError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Usage => "usage: walle-guest-agent <workload> [args...]",
            Self::InvalidKernelCommandLine => {
                "guest kernel command line is missing or duplicates WALLE identity/protocol bindings"
            }
            Self::InvalidRunId => "guest run id is invalid",
            Self::InvalidSourceSha256 => "guest source SHA-256 is invalid",
            Self::NoNewPrivilegesFailed => "failed to enforce PR_SET_NO_NEW_PRIVS before workload spawn",
            Self::InvalidProcessStatus => "failed to read canonical Seccomp/NoNewPrivs process state",
            Self::NetworkInspectionFailed => "failed to inspect guest network interfaces",
            Self::NetworkInterfaceOverflow => "guest network interface count overflowed u32",
            Self::WorkloadSpawnFailed => "failed to spawn or wait for guest workload",
        })
    }
}

impl Error for AgentError {}

fn main() -> ExitCode {
    match run() {
        Ok(code) => exit_code(code),
        Err(error) => {
            eprintln!("WALLE_GUEST_AGENT_ERROR={error}");
            ExitCode::from(125)
        }
    }
}

fn run() -> Result<i32, AgentError> {
    let mut args = env::args_os();
    let _program = args.next();
    let workload = args.next().ok_or(AgentError::Usage)?;
    let workload_args: Vec<_> = args.collect();

    let cmdline =
        fs::read_to_string("/proc/cmdline").map_err(|_| AgentError::InvalidKernelCommandLine)?;
    let identity = parse_boot_identity(&cmdline)?;

    enforce_no_new_privileges()?;

    let status = Command::new(workload)
        .args(workload_args)
        .status()
        .map_err(|_| AgentError::WorkloadSpawnFailed)?;
    let workload_exit_code = status.code().unwrap_or(128);

    let process_status =
        fs::read_to_string("/proc/self/status").map_err(|_| AgentError::InvalidProcessStatus)?;
    let security = parse_process_security_state(&process_status)?;
    let network_non_loopback_interfaces = count_non_loopback_interfaces("/sys/class/net")?;
    let completion = if workload_exit_code == 0 {
        "SUCCESS"
    } else {
        "FAILURE"
    };

    println!(
        "{ATTESTATION_PREFIX} run_id={} source_sha256={} seccomp_mode={} no_new_privs={} network_non_loopback_interfaces={} workload_exit_code={} completion={completion}",
        identity.run_id,
        identity.source_sha256,
        security.seccomp_mode,
        u8::from(security.no_new_privs),
        network_non_loopback_interfaces,
        workload_exit_code,
    );

    Ok(workload_exit_code)
}

fn parse_boot_identity(cmdline: &str) -> Result<BootIdentity, AgentError> {
    let mut run_id = None;
    let mut source_sha256 = None;
    let mut protocol_count = 0_u8;

    for argument in cmdline.split_ascii_whitespace() {
        if let Some(value) = argument.strip_prefix(RUN_ID_PREFIX) {
            if run_id.replace(value.to_owned()).is_some() || value.is_empty() {
                return Err(AgentError::InvalidKernelCommandLine);
            }
        } else if let Some(value) = argument.strip_prefix(SOURCE_SHA_PREFIX) {
            if source_sha256.replace(value.to_owned()).is_some() || value.is_empty() {
                return Err(AgentError::InvalidKernelCommandLine);
            }
        } else if argument == PROTOCOL_ARG {
            protocol_count = protocol_count
                .checked_add(1)
                .ok_or(AgentError::InvalidKernelCommandLine)?;
        } else if argument.starts_with("walle.guest_protocol=") {
            return Err(AgentError::InvalidKernelCommandLine);
        }
    }

    if protocol_count != 1 {
        return Err(AgentError::InvalidKernelCommandLine);
    }

    let run_id = run_id.ok_or(AgentError::InvalidKernelCommandLine)?;
    if !valid_run_id(&run_id) {
        return Err(AgentError::InvalidRunId);
    }
    let source_sha256 = source_sha256.ok_or(AgentError::InvalidKernelCommandLine)?;
    if !is_valid_sha256(&source_sha256) {
        return Err(AgentError::InvalidSourceSha256);
    }

    Ok(BootIdentity {
        run_id,
        source_sha256,
    })
}

fn valid_run_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn enforce_no_new_privileges() -> Result<(), AgentError> {
    // SAFETY: prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) has no pointer arguments
    // and affects only the calling process; successful state is inherited by
    // the workload child and cannot be unset.
    let result = unsafe { prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if result == 0 {
        Ok(())
    } else {
        Err(AgentError::NoNewPrivilegesFailed)
    }
}

fn parse_process_security_state(status: &str) -> Result<ProcessSecurityState, AgentError> {
    let mut seccomp_mode = None;
    let mut no_new_privs = None;

    for line in status.lines() {
        if let Some(value) = line.strip_prefix("Seccomp:") {
            if seccomp_mode.is_some() {
                return Err(AgentError::InvalidProcessStatus);
            }
            let parsed = value
                .trim()
                .parse::<u8>()
                .map_err(|_| AgentError::InvalidProcessStatus)?;
            if parsed > 2 {
                return Err(AgentError::InvalidProcessStatus);
            }
            seccomp_mode = Some(parsed);
        } else if let Some(value) = line.strip_prefix("NoNewPrivs:") {
            if no_new_privs.is_some() {
                return Err(AgentError::InvalidProcessStatus);
            }
            no_new_privs = Some(match value.trim() {
                "0" => false,
                "1" => true,
                _ => return Err(AgentError::InvalidProcessStatus),
            });
        }
    }

    Ok(ProcessSecurityState {
        seccomp_mode: seccomp_mode.ok_or(AgentError::InvalidProcessStatus)?,
        no_new_privs: no_new_privs.ok_or(AgentError::InvalidProcessStatus)?,
    })
}

fn count_non_loopback_interfaces(path: &str) -> Result<u32, AgentError> {
    let entries = fs::read_dir(path).map_err(|_| AgentError::NetworkInspectionFailed)?;
    let mut count = 0_u32;
    for entry in entries {
        let entry = entry.map_err(|_| AgentError::NetworkInspectionFailed)?;
        if entry.file_name() == "lo" {
            continue;
        }
        count = count
            .checked_add(1)
            .ok_or(AgentError::NetworkInterfaceOverflow)?;
    }
    Ok(count)
}

fn exit_code(code: i32) -> ExitCode {
    let normalized = u8::try_from(code).unwrap_or(1);
    ExitCode::from(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUN_ID: &str = "run-0123456789abcdef0123456789abcdef";
    const SOURCE_SHA: &str =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn cmdline() -> String {
        format!(
            "console=ttyS0 {RUN_ID_PREFIX}{RUN_ID} {SOURCE_SHA_PREFIX}{SOURCE_SHA} {PROTOCOL_ARG}"
        )
    }

    #[test]
    fn boot_identity_requires_exact_single_protocol_and_identity_bindings() {
        let identity = parse_boot_identity(&cmdline()).expect("identity");
        assert_eq!(identity.run_id, RUN_ID);
        assert_eq!(identity.source_sha256, SOURCE_SHA);

        assert!(parse_boot_identity(&format!("{} {PROTOCOL_ARG}", cmdline())).is_err());
        assert!(
            parse_boot_identity(&cmdline().replace(PROTOCOL_ARG, "walle.guest_protocol=2"))
                .is_err()
        );
        assert!(parse_boot_identity(&format!("{} {RUN_ID_PREFIX}{RUN_ID}", cmdline())).is_err());
        assert!(parse_boot_identity(&cmdline().replace(SOURCE_SHA, "sha256:deadbeef")).is_err());
    }

    #[test]
    fn process_status_parser_is_exact_and_bounded() {
        let state = parse_process_security_state(
            "Name:\twalle\nNoNewPrivs:\t1\nSeccomp:\t2\nSeccomp_filters:\t1\n",
        )
        .expect("security state");
        assert_eq!(
            state,
            ProcessSecurityState {
                seccomp_mode: 2,
                no_new_privs: true,
            }
        );

        assert!(parse_process_security_state("NoNewPrivs:\t1\nSeccomp:\t9\n").is_err());
        assert!(parse_process_security_state("NoNewPrivs:\t1\n").is_err());
        assert!(parse_process_security_state("Seccomp:\t2\n").is_err());
    }

    #[test]
    fn run_id_validation_matches_control_plane_shape() {
        assert!(valid_run_id(RUN_ID));
        assert!(!valid_run_id(""));
        assert!(!valid_run_id("../escape"));
        assert!(!valid_run_id(&"a".repeat(65)));
    }

    #[test]
    fn exit_code_mapping_never_wraps_negative_or_large_codes() {
        assert_eq!(exit_code(0), ExitCode::from(0));
        assert_eq!(exit_code(125), ExitCode::from(125));
        assert_eq!(exit_code(-1), ExitCode::from(1));
        assert_eq!(exit_code(999), ExitCode::from(1));
    }
}
