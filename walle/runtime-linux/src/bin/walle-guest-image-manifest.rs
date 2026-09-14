use std::collections::BTreeMap;
use std::env;
use std::fmt::{Display, Formatter};
use std::path::PathBuf;
use std::process::ExitCode;

use walle_runtime_linux::guest_manifest_builder::{
    build_guest_image_manifest, write_guest_image_manifest,
};

const USAGE: &str = concat!(
    "usage: walle-guest-image-manifest ",
    "--kernel-path <absolute-path> --rootfs-path <absolute-path> ",
    "--guest-agent-path <absolute-path> --sha256-program <absolute-path> ",
    "--output <absolute-path>"
);

const EXPECTED_FLAGS: &[&str] = &[
    "--kernel-path",
    "--rootfs-path",
    "--guest-agent-path",
    "--sha256-program",
    "--output",
];

#[derive(Debug, Clone, PartialEq, Eq)]
enum CliError {
    NonUnicodeArgument,
    InvalidFlag(String),
    UnknownFlag(String),
    DuplicateFlag(String),
    MissingValue(String),
    MissingRequired(String),
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
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CliConfig {
    kernel_path: PathBuf,
    rootfs_path: PathBuf,
    guest_agent_path: PathBuf,
    sha256_program: PathBuf,
    output: PathBuf,
}

fn main() -> ExitCode {
    let args = match collect_unicode_args() {
        Ok(args) => args,
        Err(error) => return cli_failure(error),
    };
    if args.len() == 1 && args[0] == "--help" {
        println!("{USAGE}");
        return ExitCode::SUCCESS;
    }

    let config = match parse_config(&args) {
        Ok(config) => config,
        Err(error) => return cli_failure(error),
    };
    let manifest = match build_guest_image_manifest(
        config.sha256_program,
        &config.kernel_path,
        &config.rootfs_path,
        &config.guest_agent_path,
    ) {
        Ok(manifest) => manifest,
        Err(error) => {
            eprintln!("WALLE_GUEST_MANIFEST_ERROR={error}");
            return ExitCode::from(1);
        }
    };
    if let Err(error) = write_guest_image_manifest(&config.output, &manifest) {
        eprintln!("WALLE_GUEST_MANIFEST_ERROR={error}");
        return ExitCode::from(1);
    }

    println!("WALLE_GUEST_MANIFEST=CREATED");
    println!("output={}", config.output.display());
    println!("kernel_sha256={}", manifest.kernel_sha256());
    println!("rootfs_sha256={}", manifest.rootfs_sha256());
    println!("guest_agent_sha256={}", manifest.guest_agent_sha256());
    println!("guest_manifest_sha256={}", manifest.manifest_sha256());
    ExitCode::SUCCESS
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

fn cli_failure(error: CliError) -> ExitCode {
    eprintln!("WALLE_GUEST_MANIFEST_CLI_ERROR={error}");
    eprintln!("{USAGE}");
    ExitCode::from(64)
}

fn parse_config(args: &[String]) -> Result<CliConfig, CliError> {
    let mut values = parse_flag_values(args)?;
    for flag in values.keys() {
        if !EXPECTED_FLAGS.contains(&flag.as_str()) {
            return Err(CliError::UnknownFlag(flag.clone()));
        }
    }

    let config = CliConfig {
        kernel_path: PathBuf::from(take_required(&mut values, "--kernel-path")?),
        rootfs_path: PathBuf::from(take_required(&mut values, "--rootfs-path")?),
        guest_agent_path: PathBuf::from(take_required(&mut values, "--guest-agent-path")?),
        sha256_program: PathBuf::from(take_required(&mut values, "--sha256-program")?),
        output: PathBuf::from(take_required(&mut values, "--output")?),
    };
    debug_assert!(values.is_empty());
    Ok(config)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn complete_args() -> Vec<String> {
        [
            ("--kernel-path", "/opt/walle/images/vmlinux"),
            ("--rootfs-path", "/opt/walle/images/rootfs.ext4"),
            ("--guest-agent-path", "/opt/walle/build/walle-guest-agent"),
            ("--sha256-program", "/usr/bin/sha256sum"),
            ("--output", "/opt/walle/images/guest-manifest.txt"),
        ]
        .into_iter()
        .flat_map(|(flag, value)| [flag.to_owned(), value.to_owned()])
        .collect()
    }

    #[test]
    fn strict_cli_parses_only_manifest_build_inputs() {
        let config = parse_config(&complete_args()).expect("valid config");
        assert_eq!(
            config.kernel_path,
            PathBuf::from("/opt/walle/images/vmlinux")
        );
        assert_eq!(
            config.output,
            PathBuf::from("/opt/walle/images/guest-manifest.txt")
        );
    }

    #[test]
    fn unknown_runtime_or_profile_flags_are_rejected() {
        for flag in ["--profile", "--network", "--guest-agent-runtime-path"] {
            let mut args = complete_args();
            args.extend([flag.to_owned(), "value".to_owned()]);
            assert_eq!(
                parse_config(&args).expect_err("unknown flag must fail"),
                CliError::UnknownFlag(flag.to_owned())
            );
        }
    }

    #[test]
    fn duplicate_inputs_fail_closed() {
        let mut args = complete_args();
        args.extend(["--kernel-path".to_owned(), "/tmp/other-kernel".to_owned()]);
        assert_eq!(
            parse_config(&args).expect_err("duplicate must fail"),
            CliError::DuplicateFlag("--kernel-path".to_owned())
        );
    }
}
