use std::env;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs;
use std::process::{Command, ExitCode};

use walle_core::is_valid_sha256;
use walle_runtime_linux::guest_protocol::GUEST_SECCOMP_POLICY_ID;

const RUN_ID_PREFIX: &str = "walle.run_id=";
const SOURCE_SHA_PREFIX: &str = "walle.source_sha256=";
const PROTOCOL_ARG: &str = "walle.guest_protocol=1";
const ATTESTATION_PREFIX: &str = "WALLE_GUEST_ATTESTATION_V1";

const PR_SET_SECCOMP: i32 = 22;
const PR_SET_NO_NEW_PRIVS: i32 = 38;
const SECCOMP_MODE_FILTER: usize = 2;

const BPF_LD: u16 = 0x00;
const BPF_W: u16 = 0x00;
const BPF_ABS: u16 = 0x20;
const BPF_JMP: u16 = 0x05;
const BPF_JEQ: u16 = 0x10;
const BPF_K: u16 = 0x00;
const BPF_RET: u16 = 0x06;

const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
const EPERM: u32 = 1;
const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
const SECCOMP_DATA_NR_OFFSET: u32 = 0;
const SECCOMP_DATA_ARCH_OFFSET: u32 = 4;

// x86_64 syscall numbers deliberately denied by the first WALLE guest policy.
// The policy blocks namespace changes, kernel/module mutation, privileged mount
// operations, cross-process memory writes, BPF/perf attack surfaces and newer
// mount APIs while leaving ordinary process/file operations available.
const DENIED_SYSCALLS: &[u32] = &[
    101, // ptrace
    103, // syslog
    155, // pivot_root
    161, // chroot
    163, // acct
    164, // settimeofday
    165, // mount
    166, // umount2
    167, // swapon
    168, // swapoff
    169, // reboot
    170, // sethostname
    171, // setdomainname
    172, // iopl
    173, // ioperm
    175, // init_module
    176, // delete_module
    179, // quotactl
    227, // clock_settime
    246, // kexec_load
    248, // add_key
    249, // request_key
    250, // keyctl
    272, // unshare
    298, // perf_event_open
    304, // open_by_handle_at
    308, // setns
    310, // process_vm_readv
    311, // process_vm_writev
    313, // finit_module
    320, // kexec_file_load
    321, // bpf
    323, // userfaultfd
    428, // open_tree
    429, // move_mount
    430, // fsopen
    431, // fsconfig
    432, // fsmount
    433, // fspick
    438, // pidfd_getfd
    442, // mount_setattr
];

unsafe extern "C" {
    fn prctl(option: i32, arg2: usize, arg3: usize, arg4: usize, arg5: usize) -> i32;
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SockFilter {
    code: u16,
    jt: u8,
    jf: u8,
    k: u32,
}

#[repr(C)]
struct SockFprog {
    len: u16,
    filter: *const SockFilter,
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
    SeccompPolicyTooLarge,
    SeccompInstallFailed,
    SeccompStateMismatch,
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
            Self::NoNewPrivilegesFailed => {
                "failed to enforce PR_SET_NO_NEW_PRIVS before workload spawn"
            }
            Self::SeccompPolicyTooLarge => "guest seccomp BPF program length overflowed u16",
            Self::SeccompInstallFailed => "failed to install WALLE guest seccomp filter",
            Self::SeccompStateMismatch => {
                "guest seccomp/no-new-privileges state does not match WALLE policy"
            }
            Self::InvalidProcessStatus => {
                "failed to read canonical Seccomp/NoNewPrivs process state"
            }
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
    install_guest_seccomp_filter()?;
    let process_status =
        fs::read_to_string("/proc/self/status").map_err(|_| AgentError::InvalidProcessStatus)?;
    let security = parse_process_security_state(&process_status)?;
    if security.seccomp_mode != 2 || !security.no_new_privs {
        return Err(AgentError::SeccompStateMismatch);
    }

    let status = Command::new(workload)
        .args(workload_args)
        .status()
        .map_err(|_| AgentError::WorkloadSpawnFailed)?;
    let workload_exit_code = status.code().unwrap_or(128);

    let network_non_loopback_interfaces = count_non_loopback_interfaces("/sys/class/net")?;
    let completion = if workload_exit_code == 0 {
        "SUCCESS"
    } else {
        "FAILURE"
    };

    println!(
        "{ATTESTATION_PREFIX} run_id={} source_sha256={} seccomp_mode={} seccomp_policy={} no_new_privs={} network_non_loopback_interfaces={} workload_exit_code={} completion={completion}",
        identity.run_id,
        identity.source_sha256,
        security.seccomp_mode,
        GUEST_SECCOMP_POLICY_ID,
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

fn install_guest_seccomp_filter() -> Result<(), AgentError> {
    let filter = build_guest_seccomp_filter();
    let len = u16::try_from(filter.len()).map_err(|_| AgentError::SeccompPolicyTooLarge)?;
    let program = SockFprog {
        len,
        filter: filter.as_ptr(),
    };
    // SAFETY: `program` and its backing filter vector remain alive for the
    // duration of this synchronous prctl call. The kernel copies the classic
    // BPF program before returning. Linux x86_64 is the only supported target.
    let result = unsafe {
        prctl(
            PR_SET_SECCOMP,
            SECCOMP_MODE_FILTER,
            (&raw const program) as usize,
            0,
            0,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(AgentError::SeccompInstallFailed)
    }
}

fn build_guest_seccomp_filter() -> Vec<SockFilter> {
    let mut filter = Vec::with_capacity(5 + DENIED_SYSCALLS.len() * 2);
    filter.push(bpf_stmt(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_ARCH_OFFSET));
    filter.push(bpf_jump(
        BPF_JMP | BPF_JEQ | BPF_K,
        AUDIT_ARCH_X86_64,
        1,
        0,
    ));
    filter.push(bpf_stmt(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS));
    filter.push(bpf_stmt(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_NR_OFFSET));
    for syscall in DENIED_SYSCALLS {
        filter.push(bpf_jump(BPF_JMP | BPF_JEQ | BPF_K, *syscall, 0, 1));
        filter.push(bpf_stmt(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM));
    }
    filter.push(bpf_stmt(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
    filter
}

const fn bpf_stmt(code: u16, k: u32) -> SockFilter {
    SockFilter {
        code,
        jt: 0,
        jf: 0,
        k,
    }
}

const fn bpf_jump(code: u16, k: u32, jt: u8, jf: u8) -> SockFilter {
    SockFilter { code, jt, jf, k }
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
    fn guest_seccomp_filter_has_arch_guard_and_denies_every_policy_syscall() {
        let filter = build_guest_seccomp_filter();
        assert_eq!(filter.len(), 5 + DENIED_SYSCALLS.len() * 2);
        assert_eq!(
            filter[0],
            bpf_stmt(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_ARCH_OFFSET)
        );
        assert_eq!(
            filter[1],
            bpf_jump(
                BPF_JMP | BPF_JEQ | BPF_K,
                AUDIT_ARCH_X86_64,
                1,
                0
            )
        );
        assert_eq!(
            filter[2],
            bpf_stmt(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS)
        );
        assert_eq!(
            filter[3],
            bpf_stmt(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_NR_OFFSET)
        );
        for (index, syscall) in DENIED_SYSCALLS.iter().enumerate() {
            let offset = 4 + index * 2;
            assert_eq!(
                filter[offset],
                bpf_jump(BPF_JMP | BPF_JEQ | BPF_K, *syscall, 0, 1)
            );
            assert_eq!(
                filter[offset + 1],
                bpf_stmt(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
            );
        }
        assert_eq!(
            *filter.last().expect("allow tail"),
            bpf_stmt(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
        );
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
