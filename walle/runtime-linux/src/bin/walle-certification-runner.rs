use std::collections::BTreeMap;
use std::env;
use std::fmt::{Display, Formatter};
use std::path::PathBuf;
use std::process::ExitCode;

use walle_core::capsule::FilesystemCapability;
use walle_core::certification::FinalCertificationVerdict;
use walle_core::ResourcePlan;
use walle_runtime_linux::certification_entrypoint::{
    execute_certification_entrypoint, CertificationEntrypointConfig,
};

const USAGE: &str = concat!(
    "usage: walle-certification-runner ",
    "--run-id <id> --workload-id <id> --source-sha256 <sha256:...> ",
    "--kernel-path <path> --kernel-sha256 <sha256:...> ",
    "--rootfs-path <path> --rootfs-sha256 <sha256:...> ",
    "--firecracker-path <path> --firecracker-sha256 <sha256:...> ",
    "--jailer-path <path> --jailer-sha256 <sha256:...> ",
    "--run-root <path> --evidence-root <path> --sha256-program <path> ",
    "--guest-manifest-path <path> --guest-manifest-sha256 <sha256:...> ",
    "--debugfs-program <path> --debugfs-sha256 <sha256:...> ",
    "--cgroup-mount <path> --cgroup-parent-relative <path> --chroot-base <path> ",
    "--jail-uid <u32> --jail-gid <u32> ",
    "--cpu-cores <u16> --memory-mib <u64> --wall-time-seconds <u64> ",
    "--pid-limit <u32> --scratch-disk-mib <u64> ",
    "--filesystem <NONE|READ_ONLY_INPUTS|SCRATCH_AND_DECLARED_OUTPUT> ",
    "--timeout-ms <u64> --max-stdout-bytes <u64> --max-stderr-bytes <u64> ",
    "--cancellation-grace-ms <u64> [--mkfs-ext4-program <path>]"
);

const EXPECTED_FLAGS: &[&str] = &[
    "--run-id",
    "--workload-id",
    "--source-sha256",
    "--kernel-path",
    "--kernel-sha256",
    "--rootfs-path",
    "--rootfs-sha256",
    "--firecracker-path",
    "--firecracker-sha256",
    "--jailer-path",
    "--jailer-sha256",
    "--run-root",
    "--evidence-root",
    "--sha256-program",
    "--guest-manifest-path",
    "--guest-manifest-sha256",
    "--debugfs-program",
    "--debugfs-sha256",
    "--cgroup-mount",
    "--cgroup-parent-relative",
    "--chroot-base",
    "--jail-uid",
    "--jail-gid",
    "--cpu-cores",
    "--memory-mib",
    "--wall-time-seconds",
    "--pid-limit",
    "--scratch-disk-mib",
    "--filesystem",
    "--timeout-ms",
    "--max-stdout-bytes",
    "--max-stderr-bytes",
    "--cancellation-grace-ms",
    "--mkfs-ext4-program",
];

#[derive(Debug, Clone, PartialEq, Eq)]
enum CliError {
    NonUnicodeArgument,
    InvalidFlag(String),
    UnknownFlag(String),
    DuplicateFlag(String),
    MissingValue(String),
    MissingRequired(String),
    InvalidNumber { flag: String, value: String },
    InvalidFilesystem(String),
}

impl Display for CliError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NonUnicodeArgument => formatter.write_str("arguments must be valid UTF-8"),
            Self::InvalidFlag(flag) => write!(formatter, "invalid positional argument: {flag}"),
            Self::UnknownFlag(flag) => write!(formatter, "unknown argument: {flag}"),
            Self::DuplicateFlag(flag) => write!(formatter, "duplicate argument: {flag}"),
            Self::MissingValue(flag) => write!(formatter, "missing value for argument: {flag}"),
            Self::MissingRequired(flag) => write!(formatter, "missing required argument: {flag}"),
            Self::InvalidNumber { flag, value } => {
                write!(formatter, "invalid numeric value for {flag}: {value}")
            }
            Self::InvalidFilesystem(value) => write!(
                formatter,
                "invalid --filesystem value: {value}; expected NONE, READ_ONLY_INPUTS, or SCRATCH_AND_DECLARED_OUTPUT"
            ),
        }
    }
}

fn main() -> ExitCode {
    let args = match collect_unicode_args() {
        Ok(args) => args,
        Err(error) => return fail(error),
    };
    if args.len() == 1 && args[0] == "--help" {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }

    let config = match parse_config(&args) {
        Ok(config) => config,
        Err(error) => return fail(error),
    };

    match execute_certification_entrypoint(&config) {
        Ok(outcome) => {
            let evidence_kind = outcome
                .decision
                .evidence_kind
                .map_or("NONE", |kind| kind.as_str());
            println!(
                "WALLE_CERTIFICATION_RESULT verdict={} reason={} state={} evidence_kind={}",
                outcome.decision.verdict.as_str(),
                outcome.decision.reason.as_str(),
                outcome.final_state.as_str(),
                evidence_kind,
            );
            match outcome.decision.verdict {
                FinalCertificationVerdict::Certified => ExitCode::SUCCESS,
                FinalCertificationVerdict::InsufficientData
                | FinalCertificationVerdict::Blocked => ExitCode::from(2),
            }
        }
        Err(error) => {
            eprintln!("WALLE_CERTIFICATION_ERROR={error}");
            ExitCode::from(1)
        }
    }
}

fn collect_unicode_args() -> Result<Vec<String>, CliError> {
    env::args_os()
        .skip(1)
        .map(|value| {
            value
                .into_string()
                .map_err(|_| CliError::NonUnicodeArgument)
        })
        .collect()
}

fn fail(error: CliError) -> ExitCode {
    eprintln!("WALLE_CERTIFICATION_CLI_ERROR={error}");
    eprintln!("{USAGE}");
    ExitCode::from(64)
}

fn parse_config(args: &[String]) -> Result<CertificationEntrypointConfig, CliError> {
    let mut values = parse_flag_values(args)?;

    for flag in values.keys() {
        if !EXPECTED_FLAGS.contains(&flag.as_str()) {
            return Err(CliError::UnknownFlag(flag.clone()));
        }
    }

    let run_id = take_required(&mut values, "--run-id")?;
    let workload_id = take_required(&mut values, "--workload-id")?;
    let source_sha256 = take_required(&mut values, "--source-sha256")?;

    let kernel_source = take_path(&mut values, "--kernel-path")?;
    let kernel_sha256 = take_required(&mut values, "--kernel-sha256")?;
    let rootfs_source = take_path(&mut values, "--rootfs-path")?;
    let rootfs_sha256 = take_required(&mut values, "--rootfs-sha256")?;
    let firecracker_exec = take_path(&mut values, "--firecracker-path")?;
    let firecracker_sha256 = take_required(&mut values, "--firecracker-sha256")?;
    let jailer_exec = take_path(&mut values, "--jailer-path")?;
    let jailer_sha256 = take_required(&mut values, "--jailer-sha256")?;

    let run_root = take_path(&mut values, "--run-root")?;
    let evidence_root = take_path(&mut values, "--evidence-root")?;
    let sha256_program = take_path(&mut values, "--sha256-program")?;
    let guest_manifest_path = take_path(&mut values, "--guest-manifest-path")?;
    let guest_manifest_sha256 = take_required(&mut values, "--guest-manifest-sha256")?;
    let debugfs_program = take_path(&mut values, "--debugfs-program")?;
    let debugfs_sha256 = take_required(&mut values, "--debugfs-sha256")?;
    let cgroup_mount = take_path(&mut values, "--cgroup-mount")?;
    let cgroup_parent_relative = take_path(&mut values, "--cgroup-parent-relative")?;
    let chroot_base = take_path(&mut values, "--chroot-base")?;

    let jail_uid = take_number::<u32>(&mut values, "--jail-uid")?;
    let jail_gid = take_number::<u32>(&mut values, "--jail-gid")?;
    let cpu_cores = take_number::<u16>(&mut values, "--cpu-cores")?;
    let memory_mib = take_number::<u64>(&mut values, "--memory-mib")?;
    let wall_time_seconds = take_number::<u64>(&mut values, "--wall-time-seconds")?;
    let pid_limit = take_number::<u32>(&mut values, "--pid-limit")?;
    let scratch_disk_mib = take_number::<u64>(&mut values, "--scratch-disk-mib")?;
    let filesystem = parse_filesystem(take_required(&mut values, "--filesystem")?)?;
    let timeout_ms = take_number::<u64>(&mut values, "--timeout-ms")?;
    let max_stdout_bytes = take_number::<u64>(&mut values, "--max-stdout-bytes")?;
    let max_stderr_bytes = take_number::<u64>(&mut values, "--max-stderr-bytes")?;
    let cancellation_grace_ms = take_number::<u64>(&mut values, "--cancellation-grace-ms")?;
    let mkfs_ext4_program = values.remove("--mkfs-ext4-program").map(PathBuf::from);

    debug_assert!(values.is_empty());

    Ok(CertificationEntrypointConfig {
        run_id,
        workload_id,
        source_sha256,
        resources: ResourcePlan {
            cpu_cores,
            memory_mib,
            wall_time_seconds,
            pid_limit,
            scratch_disk_mib,
        },
        filesystem,
        timeout_ms,
        max_stdout_bytes,
        max_stderr_bytes,
        cancellation_grace_ms,
        firecracker_exec,
        firecracker_sha256,
        jailer_exec,
        jailer_sha256,
        run_root,
        kernel_source,
        kernel_sha256,
        rootfs_source,
        rootfs_sha256,
        jail_uid,
        jail_gid,
        evidence_root,
        sha256_program,
        cgroup_mount,
        cgroup_parent_relative,
        chroot_base,
        mkfs_ext4_program,
        guest_manifest_path,
        guest_manifest_sha256,
        debugfs_program,
        debugfs_sha256,
    })
}

fn parse_flag_values(args: &[String]) -> Result<BTreeMap<String, String>, CliError> {
    let mut values = BTreeMap::new();
    let mut index = 0;
    while index < args.len() {
        let flag = &args[index];
        if !flag.starts_with("--") {
            return Err(CliError::InvalidFlag(flag.clone()));
        }
        let Some(value) = args.get(index + 1) else {
            return Err(CliError::MissingValue(flag.clone()));
        };
        if value.starts_with("--") {
            return Err(CliError::MissingValue(flag.clone()));
        }
        if values.insert(flag.clone(), value.clone()).is_some() {
            return Err(CliError::DuplicateFlag(flag.clone()));
        }
        index += 2;
    }
    Ok(values)
}

fn take_required(values: &mut BTreeMap<String, String>, flag: &str) -> Result<String, CliError> {
    values
        .remove(flag)
        .ok_or_else(|| CliError::MissingRequired(flag.to_owned()))
}

fn take_path(values: &mut BTreeMap<String, String>, flag: &str) -> Result<PathBuf, CliError> {
    take_required(values, flag).map(PathBuf::from)
}

fn take_number<T>(values: &mut BTreeMap<String, String>, flag: &str) -> Result<T, CliError>
where
    T: std::str::FromStr,
{
    let value = take_required(values, flag)?;
    value.parse::<T>().map_err(|_| CliError::InvalidNumber {
        flag: flag.to_owned(),
        value,
    })
}

fn parse_filesystem(value: String) -> Result<FilesystemCapability, CliError> {
    match value.as_str() {
        "NONE" => Ok(FilesystemCapability::None),
        "READ_ONLY_INPUTS" => Ok(FilesystemCapability::ReadOnlyInputs),
        "SCRATCH_AND_DECLARED_OUTPUT" => Ok(FilesystemCapability::ScratchAndDeclaredOutput),
        _ => Err(CliError::InvalidFilesystem(value)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn complete_args() -> Vec<String> {
        [
            ("--run-id", "run-0123456789abcdef0123456789abcdef"),
            ("--workload-id", "seo-avengers-2500"),
            (
                "--source-sha256",
                "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            ),
            ("--kernel-path", "/opt/walle/images/vmlinux"),
            (
                "--kernel-sha256",
                "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            ),
            ("--rootfs-path", "/opt/walle/images/rootfs.ext4"),
            (
                "--rootfs-sha256",
                "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            ),
            ("--firecracker-path", "/opt/walle/firecracker"),
            (
                "--firecracker-sha256",
                "sha256:3333333333333333333333333333333333333333333333333333333333333333",
            ),
            ("--jailer-path", "/opt/walle/jailer"),
            (
                "--jailer-sha256",
                "sha256:4444444444444444444444444444444444444444444444444444444444444444",
            ),
            (
                "--run-root",
                "/var/lib/walle/runs/run-0123456789abcdef0123456789abcdef",
            ),
            ("--evidence-root", "/var/lib/walle/evidence"),
            ("--sha256-program", "/usr/bin/sha256sum"),
            (
                "--guest-manifest-path",
                "/opt/walle/images/guest-manifest.json",
            ),
            (
                "--guest-manifest-sha256",
                "sha256:5555555555555555555555555555555555555555555555555555555555555555",
            ),
            ("--debugfs-program", "/usr/sbin/debugfs"),
            (
                "--debugfs-sha256",
                "sha256:6666666666666666666666666666666666666666666666666666666666666666",
            ),
            ("--cgroup-mount", "/sys/fs/cgroup"),
            ("--cgroup-parent-relative", "walle"),
            ("--chroot-base", "/srv/walle/jailer"),
            ("--jail-uid", "10001"),
            ("--jail-gid", "10001"),
            ("--cpu-cores", "16"),
            ("--memory-mib", "65536"),
            ("--wall-time-seconds", "3600"),
            ("--pid-limit", "1024"),
            ("--scratch-disk-mib", "65536"),
            ("--filesystem", "SCRATCH_AND_DECLARED_OUTPUT"),
            ("--timeout-ms", "1200000"),
            ("--max-stdout-bytes", "67108864"),
            ("--max-stderr-bytes", "65536"),
            ("--cancellation-grace-ms", "5000"),
            ("--mkfs-ext4-program", "/usr/sbin/mkfs.ext4"),
        ]
        .into_iter()
        .flat_map(|(flag, value)| [flag.to_owned(), value.to_owned()])
        .collect()
    }

    #[test]
    fn strict_cli_builds_operational_config_without_profile_input() {
        let config = parse_config(&complete_args()).expect("valid config");
        assert_eq!(config.run_id, "run-0123456789abcdef0123456789abcdef");
        assert_eq!(config.resources.cpu_cores, 16);
        assert_eq!(
            config.filesystem,
            FilesystemCapability::ScratchAndDeclaredOutput
        );
    }

    #[test]
    fn caller_cannot_supply_profile_override() {
        let mut args = complete_args();
        args.extend(["--profile".to_owned(), "FAST".to_owned()]);
        assert_eq!(
            parse_config(&args).expect_err("profile must not be accepted"),
            CliError::UnknownFlag("--profile".to_owned())
        );
    }

    #[test]
    fn duplicate_arguments_fail_closed() {
        let mut args = complete_args();
        args.extend(["--run-id".to_owned(), "run-other".to_owned()]);
        assert_eq!(
            parse_config(&args).expect_err("duplicate must fail"),
            CliError::DuplicateFlag("--run-id".to_owned())
        );
    }

    #[test]
    fn malformed_filesystem_mode_is_rejected() {
        let mut args = complete_args();
        let position = args
            .iter()
            .position(|arg| arg == "--filesystem")
            .expect("filesystem flag");
        args[position + 1] = "READ_WRITE_ROOT".to_owned();
        assert_eq!(
            parse_config(&args).expect_err("invalid filesystem must fail"),
            CliError::InvalidFilesystem("READ_WRITE_ROOT".to_owned())
        );
    }
}
