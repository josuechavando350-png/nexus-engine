use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs::{self, File};
use std::io::{self, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use walle_core::is_valid_sha256;
use walle_core::supervisor::MicroVmSupervisorPlan;
use walle_core::supervisor_lifecycle::{
    GracefulTerminationOutcome, MicroVmSupervisorHost, SpawnAttempt, WaitOutcome,
};

use crate::artifact::{open_regular_no_symlinks, ArtifactError, SystemSha256};
use crate::cgroup::{AppliedCgroup, CgroupError, CgroupLayout};
use crate::firecracker::{
    build_firecracker_config, build_jailer_command, FirecrackerConfigOptions,
    FirecrackerPlanError, JailerCommandPlan, SCRATCH_GUEST_PATH,
};
use crate::safe_fs::{SecureDirectory, SecureFsError};

const SIGTERM: i32 = 15;
const ESRCH: i32 = 3;
const POLL_INTERVAL: Duration = Duration::from_millis(10);

extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
    fn fchown(fd: i32, owner: u32, group: u32) -> i32;
}

#[derive(Debug, Clone)]
pub struct LinuxMicroVmHostConfig {
    pub sha256_program: PathBuf,
    pub firecracker_sha256: String,
    pub jailer_sha256: String,
    pub cgroup_mount: PathBuf,
    pub cgroup_parent_relative: PathBuf,
    pub chroot_base: PathBuf,
    pub mkfs_ext4_program: Option<PathBuf>,
    pub boot_args: String,
}

#[derive(Debug)]
pub enum LinuxHostError {
    InvalidFirecrackerSha256,
    InvalidJailerSha256,
    UnsafeTrustedProgram(PathBuf),
    DigestMismatch {
        label: &'static str,
        expected: String,
        actual: String,
    },
    InvalidLifecycleState(&'static str),
    MissingScratchFormatter,
    ScratchSizeOverflow,
    ScratchFormatterFailed(Option<i32>),
    ProcessIdOverflow(u32),
    Artifact(ArtifactError),
    Cgroup(CgroupError),
    Firecracker(FirecrackerPlanError),
    SecureFs(SecureFsError),
    Io {
        operation: &'static str,
        source: io::Error,
    },
}

impl Display for LinuxHostError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidFirecrackerSha256 => {
                formatter.write_str("Firecracker digest is not a canonical lowercase sha256")
            }
            Self::InvalidJailerSha256 => {
                formatter.write_str("jailer digest is not a canonical lowercase sha256")
            }
            Self::UnsafeTrustedProgram(path) => write!(
                formatter,
                "trusted runtime program must be root-owned and not group/world writable: {}",
                path.display()
            ),
            Self::DigestMismatch {
                label,
                expected,
                actual,
            } => write!(
                formatter,
                "{label} digest mismatch: expected {expected}, got {actual}"
            ),
            Self::InvalidLifecycleState(reason) => {
                write!(formatter, "invalid Linux supervisor lifecycle state: {reason}")
            }
            Self::MissingScratchFormatter => formatter.write_str(
                "scratch filesystem was requested but no trusted mkfs.ext4 program was configured",
            ),
            Self::ScratchSizeOverflow => {
                formatter.write_str("scratch filesystem size overflowed u64 bytes")
            }
            Self::ScratchFormatterFailed(code) => {
                write!(formatter, "mkfs.ext4 failed with exit code {code:?}")
            }
            Self::ProcessIdOverflow(pid) => write!(formatter, "child pid does not fit pid_t: {pid}"),
            Self::Artifact(error) => Display::fmt(error, formatter),
            Self::Cgroup(error) => Display::fmt(error, formatter),
            Self::Firecracker(error) => Display::fmt(error, formatter),
            Self::SecureFs(error) => Display::fmt(error, formatter),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
        }
    }
}

impl Error for LinuxHostError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Artifact(error) => Some(error),
            Self::Cgroup(error) => Some(error),
            Self::Firecracker(error) => Some(error),
            Self::SecureFs(error) => Some(error),
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<ArtifactError> for LinuxHostError {
    fn from(value: ArtifactError) -> Self {
        Self::Artifact(value)
    }
}

impl From<CgroupError> for LinuxHostError {
    fn from(value: CgroupError) -> Self {
        Self::Cgroup(value)
    }
}

impl From<FirecrackerPlanError> for LinuxHostError {
    fn from(value: FirecrackerPlanError) -> Self {
        Self::Firecracker(value)
    }
}

impl From<SecureFsError> for LinuxHostError {
    fn from(value: SecureFsError) -> Self {
        Self::SecureFs(value)
    }
}

#[derive(Debug, Clone)]
pub struct CancellationHandle {
    cancelled: Arc<AtomicBool>,
}

impl CancellationHandle {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[derive(Debug)]
pub struct LinuxManagedProcess {
    child: Child,
}

impl LinuxManagedProcess {
    pub fn id(&self) -> u32 {
        self.child.id()
    }
}

#[derive(Debug)]
struct PreparedRun {
    run_id: String,
    run_root: SecureDirectory,
    chroot_vm_dir: Option<SecureDirectory>,
    chroot_root: Option<SecureDirectory>,
    walle_dir: Option<SecureDirectory>,
    cgroup: Option<AppliedCgroup>,
    staged_firecracker: Option<PathBuf>,
    staged_jailer: Option<PathBuf>,
    command: Option<JailerCommandPlan>,
}

#[derive(Debug)]
pub struct LinuxMicroVmHost {
    config: LinuxMicroVmHostConfig,
    hasher: SystemSha256,
    cgroup_layout: CgroupLayout,
    cancellation: Arc<AtomicBool>,
    verified_run_id: Option<String>,
    run: Option<PreparedRun>,
}

impl LinuxMicroVmHost {
    pub fn new(config: LinuxMicroVmHostConfig) -> Result<Self, LinuxHostError> {
        if !is_valid_sha256(&config.firecracker_sha256) {
            return Err(LinuxHostError::InvalidFirecrackerSha256);
        }
        if !is_valid_sha256(&config.jailer_sha256) {
            return Err(LinuxHostError::InvalidJailerSha256);
        }
        let hasher = SystemSha256::new(config.sha256_program.clone())?;
        let cgroup_layout = CgroupLayout::new(
            config.cgroup_mount.clone(),
            config.cgroup_parent_relative.clone(),
        )?;
        SecureDirectory::open(config.chroot_base.clone())?;
        if let Some(program) = config.mkfs_ext4_program.as_deref() {
            validate_trusted_program(program)?;
        }
        Ok(Self {
            config,
            hasher,
            cgroup_layout,
            cancellation: Arc::new(AtomicBool::new(false)),
            verified_run_id: None,
            run: None,
        })
    }

    pub fn cancellation_handle(&self) -> CancellationHandle {
        CancellationHandle {
            cancelled: Arc::clone(&self.cancellation),
        }
    }

    pub fn active_run_root(&self) -> Option<&Path> {
        self.run.as_ref().map(|run| run.run_root.path())
    }

    fn require_verified(&self, plan: &MicroVmSupervisorPlan<'_>) -> Result<(), LinuxHostError> {
        if self.verified_run_id.as_deref() != Some(plan.run_id) {
            return Err(LinuxHostError::InvalidLifecycleState(
                "inputs were not verified for this run id",
            ));
        }
        Ok(())
    }

    fn run_mut(
        &mut self,
        plan: &MicroVmSupervisorPlan<'_>,
    ) -> Result<&mut PreparedRun, LinuxHostError> {
        let run = self
            .run
            .as_mut()
            .ok_or(LinuxHostError::InvalidLifecycleState("run root is not prepared"))?;
        if run.run_id != plan.run_id {
            return Err(LinuxHostError::InvalidLifecycleState(
                "prepared run id does not match supervisor plan",
            ));
        }
        Ok(run)
    }
}

impl MicroVmSupervisorHost for LinuxMicroVmHost {
    type Process = LinuxManagedProcess;
    type Error = LinuxHostError;

    fn verify_inputs(&mut self, plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error> {
        if self.run.is_some() || self.verified_run_id.is_some() {
            return Err(LinuxHostError::InvalidLifecycleState(
                "host instance already owns a run",
            ));
        }
        verify_digest(
            &self.hasher,
            "Firecracker binary",
            Path::new(plan.firecracker_exec),
            &self.config.firecracker_sha256,
        )?;
        verify_digest(
            &self.hasher,
            "jailer binary",
            Path::new(plan.jailer_exec),
            &self.config.jailer_sha256,
        )?;
        verify_digest(
            &self.hasher,
            "kernel image",
            Path::new(plan.kernel_source),
            plan.kernel_sha256,
        )?;
        verify_digest(
            &self.hasher,
            "rootfs image",
            Path::new(plan.rootfs_source),
            plan.rootfs_sha256,
        )?;
        self.verified_run_id = Some(plan.run_id.to_owned());
        self.cancellation.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn prepare_run_root(&mut self, plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error> {
        self.require_verified(plan)?;
        if self.run.is_some() {
            return Err(LinuxHostError::InvalidLifecycleState(
                "run root was already prepared",
            ));
        }

        let run_root = SecureDirectory::create_leaf(PathBuf::from(plan.run_root), 0o700)?;
        self.run = Some(PreparedRun {
            run_id: plan.run_id.to_owned(),
            run_root,
            chroot_vm_dir: None,
            chroot_root: None,
            walle_dir: None,
            cgroup: None,
            staged_firecracker: None,
            staged_jailer: None,
            command: None,
        });

        let chroot_base = SecureDirectory::open(self.config.chroot_base.clone())?;
        let executable_root = chroot_base.create_child_directory("firecracker", 0o755, true)?;
        let vm_dir = executable_root.create_child_directory(plan.run_id, 0o700, false)?;
        let chroot_root = vm_dir.create_child_directory("root", 0o755, false)?;
        let walle_dir = chroot_root.create_child_directory("walle", 0o755, false)?;

        let run = self.run_mut(plan)?;
        run.chroot_vm_dir = Some(vm_dir);
        run.chroot_root = Some(chroot_root);
        run.walle_dir = Some(walle_dir);
        Ok(())
    }

    fn apply_cgroup(&mut self, plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error> {
        self.require_verified(plan)?;
        if self.run_mut(plan)?.cgroup.is_some() {
            return Err(LinuxHostError::InvalidLifecycleState(
                "cgroup was already applied",
            ));
        }
        let cgroup = self.cgroup_layout.create_and_apply(plan.run_id, plan.cgroup)?;
        self.run_mut(plan)?.cgroup = Some(cgroup);
        Ok(())
    }

    fn materialize_runtime(&mut self, plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error> {
        self.require_verified(plan)?;
        let hasher = self.hasher.clone();
        let firecracker_sha256 = self.config.firecracker_sha256.clone();
        let jailer_sha256 = self.config.jailer_sha256.clone();
        let chroot_base = self.config.chroot_base.clone();
        let boot_args = self.config.boot_args.clone();
        let mkfs_ext4_program = self.config.mkfs_ext4_program.clone();

        let run = self.run_mut(plan)?;
        if run.command.is_some() {
            return Err(LinuxHostError::InvalidLifecycleState(
                "runtime was already materialized",
            ));
        }
        let cgroup_relative = run
            .cgroup
            .as_ref()
            .ok_or(LinuxHostError::InvalidLifecycleState(
                "cgroup must be applied before runtime materialization",
            ))?
            .relative_path
            .clone();
        let walle_dir = run
            .walle_dir
            .as_ref()
            .ok_or(LinuxHostError::InvalidLifecycleState(
                "chroot runtime directory is unavailable",
            ))?;

        let staged_firecracker = stage_verified_into_dir(
            Path::new(plan.firecracker_exec),
            &run.run_root,
            "firecracker",
            &firecracker_sha256,
            0o555,
            &hasher,
        )?;
        let staged_jailer = stage_verified_into_dir(
            Path::new(plan.jailer_exec),
            &run.run_root,
            "jailer",
            &jailer_sha256,
            0o555,
            &hasher,
        )?;
        stage_verified_into_dir(
            Path::new(plan.kernel_source),
            walle_dir,
            "kernel",
            plan.kernel_sha256,
            0o444,
            &hasher,
        )?;
        stage_verified_into_dir(
            Path::new(plan.rootfs_source),
            walle_dir,
            "rootfs",
            plan.rootfs_sha256,
            0o444,
            &hasher,
        )?;

        let scratch_guest_path = if plan.scratch_disk_mib == 0 {
            None
        } else {
            let mkfs = mkfs_ext4_program
                .as_deref()
                .ok_or(LinuxHostError::MissingScratchFormatter)?;
            create_scratch_ext4(walle_dir, plan, mkfs)?;
            Some(SCRATCH_GUEST_PATH)
        };

        let config = build_firecracker_config(
            plan,
            FirecrackerConfigOptions {
                boot_args: &boot_args,
                scratch_guest_path,
            },
        )?;
        write_runtime_file(
            walle_dir,
            "firecracker-config.json",
            config.as_str().as_bytes(),
            0o444,
        )?;

        let command = build_jailer_command(
            plan,
            &staged_jailer,
            &staged_firecracker,
            &chroot_base,
            &cgroup_relative,
        )?;
        let expected_chroot = run
            .chroot_root
            .as_ref()
            .ok_or(LinuxHostError::InvalidLifecycleState(
                "chroot root is unavailable",
            ))?
            .path();
        if command.chroot_root != expected_chroot {
            return Err(LinuxHostError::InvalidLifecycleState(
                "jailer chroot path does not match fd-bound prepared directory",
            ));
        }

        run.staged_firecracker = Some(staged_firecracker);
        run.staged_jailer = Some(staged_jailer);
        run.command = Some(command);
        Ok(())
    }

    fn spawn(
        &mut self,
        plan: &MicroVmSupervisorPlan<'_>,
    ) -> SpawnAttempt<Self::Process, Self::Error> {
        let run = match self.run_mut(plan) {
            Ok(run) => run,
            Err(error) => {
                return SpawnAttempt::Failed {
                    error,
                    process: None,
                }
            }
        };
        let command_plan = match run.command.clone() {
            Some(command) => command,
            None => {
                return SpawnAttempt::Failed {
                    error: LinuxHostError::InvalidLifecycleState(
                        "runtime must be materialized before spawn",
                    ),
                    process: None,
                }
            }
        };
        let stdout = match run.run_root.create_new_file("stdout.log", 0o600) {
            Ok(file) => file,
            Err(error) => {
                return SpawnAttempt::Failed {
                    error: error.into(),
                    process: None,
                }
            }
        };
        let stderr = match run.run_root.create_new_file("stderr.log", 0o600) {
            Ok(file) => file,
            Err(error) => {
                return SpawnAttempt::Failed {
                    error: error.into(),
                    process: None,
                }
            }
        };

        let child = Command::new(&command_plan.program)
            .args(&command_plan.args)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .spawn();
        match child {
            Ok(child) => SpawnAttempt::Running(LinuxManagedProcess { child }),
            Err(source) => SpawnAttempt::Failed {
                error: LinuxHostError::Io {
                    operation: "spawn jailer",
                    source,
                },
                process: None,
            },
        }
    }

    fn wait(
        &mut self,
        process: &mut Self::Process,
        timeout_ms: u64,
    ) -> Result<WaitOutcome, Self::Error> {
        wait_process(&mut process.child, timeout_ms, &self.cancellation)
    }

    fn terminate_and_wait(
        &mut self,
        process: &mut Self::Process,
        grace_ms: u64,
    ) -> Result<GracefulTerminationOutcome, Self::Error> {
        terminate_process(&mut process.child, grace_ms)
    }

    fn force_kill_and_reap(&mut self, process: &mut Self::Process) -> Result<(), Self::Error> {
        force_kill_and_reap(&mut process.child)
    }

    fn cleanup(&mut self, plan: &MicroVmSupervisorPlan<'_>) -> Result<(), Self::Error> {
        if let Some(run) = self.run.as_ref() {
            if run.run_id != plan.run_id {
                return Err(LinuxHostError::InvalidLifecycleState(
                    "cleanup plan does not match active run",
                ));
            }
            if run.cgroup.is_some() {
                self.cgroup_layout.cleanup_empty(plan.run_id)?;
            }
            if let Some(vm_dir) = run.chroot_vm_dir.as_ref() {
                if vm_dir.path().exists() {
                    fs::remove_dir_all(vm_dir.path()).map_err(|source| LinuxHostError::Io {
                        operation: "remove jailer run directory",
                        source,
                    })?;
                }
            }
            if run.run_root.path().exists() {
                fs::remove_dir_all(run.run_root.path()).map_err(|source| LinuxHostError::Io {
                    operation: "remove supervisor run directory",
                    source,
                })?;
            }
        }
        self.run = None;
        self.verified_run_id = None;
        self.cancellation.store(false, Ordering::SeqCst);
        Ok(())
    }
}

fn validate_trusted_program(path: &Path) -> Result<(), LinuxHostError> {
    let file = open_regular_no_symlinks(path)?;
    let metadata = file.metadata().map_err(|source| LinuxHostError::Io {
        operation: "inspect trusted runtime program",
        source,
    })?;
    if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        return Err(LinuxHostError::UnsafeTrustedProgram(path.to_path_buf()));
    }
    Ok(())
}

fn verify_digest(
    hasher: &SystemSha256,
    label: &'static str,
    path: &Path,
    expected: &str,
) -> Result<(), LinuxHostError> {
    let actual = hasher.hash_path(path)?;
    if actual != expected {
        return Err(LinuxHostError::DigestMismatch {
            label,
            expected: expected.to_owned(),
            actual,
        });
    }
    Ok(())
}

fn stage_verified_into_dir(
    source: &Path,
    directory: &SecureDirectory,
    name: &str,
    expected_sha256: &str,
    mode: u32,
    hasher: &SystemSha256,
) -> Result<PathBuf, LinuxHostError> {
    if !is_valid_sha256(expected_sha256) {
        return Err(LinuxHostError::Artifact(
            ArtifactError::InvalidExpectedSha256,
        ));
    }
    let mut input = open_regular_no_symlinks(source)?;
    let mut output = directory.create_new_file(name, mode)?;
    let destination = directory.path().join(name);
    if let Err(source) = io::copy(&mut input, &mut output) {
        drop(output);
        let _ = directory.remove_file(name);
        return Err(LinuxHostError::Io {
            operation: "copy artifact into fd-bound runtime directory",
            source,
        });
    }
    output.flush().map_err(|source| LinuxHostError::Io {
        operation: "flush staged runtime artifact",
        source,
    })?;
    output.sync_all().map_err(|source| LinuxHostError::Io {
        operation: "sync staged runtime artifact",
        source,
    })?;
    let actual = hasher.hash_file(&output)?;
    if actual != expected_sha256 {
        drop(output);
        let _ = directory.remove_file(name);
        return Err(LinuxHostError::DigestMismatch {
            label: "staged runtime artifact",
            expected: expected_sha256.to_owned(),
            actual,
        });
    }
    Ok(destination)
}

fn write_runtime_file(
    directory: &SecureDirectory,
    name: &str,
    bytes: &[u8],
    mode: u32,
) -> Result<PathBuf, LinuxHostError> {
    let mut file = directory.create_new_file(name, mode)?;
    file.write_all(bytes).map_err(|source| LinuxHostError::Io {
        operation: "write runtime file",
        source,
    })?;
    file.flush().map_err(|source| LinuxHostError::Io {
        operation: "flush runtime file",
        source,
    })?;
    file.sync_all().map_err(|source| LinuxHostError::Io {
        operation: "sync runtime file",
        source,
    })?;
    Ok(directory.path().join(name))
}

fn create_scratch_ext4(
    directory: &SecureDirectory,
    plan: &MicroVmSupervisorPlan<'_>,
    mkfs_program: &Path,
) -> Result<PathBuf, LinuxHostError> {
    validate_trusted_program(mkfs_program)?;
    let bytes = plan
        .scratch_disk_mib
        .checked_mul(1024 * 1024)
        .ok_or(LinuxHostError::ScratchSizeOverflow)?;
    let mut file = directory.create_new_inheritable_file("scratch.ext4", 0o600)?;
    if let Err(source) = file.set_len(bytes) {
        drop(file);
        let _ = directory.remove_file("scratch.ext4");
        return Err(LinuxHostError::Io {
            operation: "size scratch filesystem image",
            source,
        });
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|source| LinuxHostError::Io {
            operation: "rewind scratch filesystem image",
            source,
        })?;
    let fd = file.as_raw_fd();
    let inherited_path = format!("/proc/self/fd/{fd}");
    let output = Command::new(mkfs_program)
        .args(["-q", "-F", "-m", "0", inherited_path.as_str()])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|source| LinuxHostError::Io {
            operation: "execute mkfs.ext4",
            source,
        })?;
    if !output.status.success() {
        drop(file);
        let _ = directory.remove_file("scratch.ext4");
        return Err(LinuxHostError::ScratchFormatterFailed(output.status.code()));
    }
    let chown_result = unsafe { fchown(fd, plan.jail_uid, plan.jail_gid) };
    if chown_result != 0 {
        let source = io::Error::last_os_error();
        drop(file);
        let _ = directory.remove_file("scratch.ext4");
        return Err(LinuxHostError::Io {
            operation: "chown scratch filesystem image",
            source,
        });
    }
    file.sync_all().map_err(|source| LinuxHostError::Io {
        operation: "sync formatted scratch filesystem image",
        source,
    })?;
    Ok(directory.path().join("scratch.ext4"))
}

fn wait_process(
    child: &mut Child,
    timeout_ms: u64,
    cancellation: &AtomicBool,
) -> Result<WaitOutcome, LinuxHostError> {
    let started = Instant::now();
    let timeout = Duration::from_millis(timeout_ms);
    loop {
        if let Some(status) = child.try_wait().map_err(|source| LinuxHostError::Io {
            operation: "poll jailer process",
            source,
        })? {
            return Ok(WaitOutcome::Exited(status.code().unwrap_or(-1)));
        }
        if cancellation.load(Ordering::SeqCst) {
            return Ok(WaitOutcome::Cancelled);
        }
        if started.elapsed() >= timeout {
            return Ok(WaitOutcome::TimedOut);
        }
        thread::sleep(POLL_INTERVAL.min(timeout.saturating_sub(started.elapsed())));
    }
}

fn terminate_process(
    child: &mut Child,
    grace_ms: u64,
) -> Result<GracefulTerminationOutcome, LinuxHostError> {
    if child
        .try_wait()
        .map_err(|source| LinuxHostError::Io {
            operation: "poll process before SIGTERM",
            source,
        })?
        .is_some()
    {
        return Ok(GracefulTerminationOutcome::Exited);
    }
    let pid_u32 = child.id();
    let pid = i32::try_from(pid_u32).map_err(|_| LinuxHostError::ProcessIdOverflow(pid_u32))?;
    let result = unsafe { kill(pid, SIGTERM) };
    if result != 0 {
        let source = io::Error::last_os_error();
        if source.raw_os_error() != Some(ESRCH) {
            return Err(LinuxHostError::Io {
                operation: "send SIGTERM to jailer process",
                source,
            });
        }
    }
    let started = Instant::now();
    let grace = Duration::from_millis(grace_ms);
    loop {
        if child
            .try_wait()
            .map_err(|source| LinuxHostError::Io {
                operation: "poll process after SIGTERM",
                source,
            })?
            .is_some()
        {
            return Ok(GracefulTerminationOutcome::Exited);
        }
        if started.elapsed() >= grace {
            return Ok(GracefulTerminationOutcome::StillRunning);
        }
        thread::sleep(POLL_INTERVAL.min(grace.saturating_sub(started.elapsed())));
    }
}

fn force_kill_and_reap(child: &mut Child) -> Result<(), LinuxHostError> {
    if child
        .try_wait()
        .map_err(|source| LinuxHostError::Io {
            operation: "poll process before force kill",
            source,
        })?
        .is_some()
    {
        return Ok(());
    }
    child.kill().map_err(|source| LinuxHostError::Io {
        operation: "force kill jailer process",
        source,
    })?;
    child.wait().map_err(|source| LinuxHostError::Io {
        operation: "reap force-killed jailer process",
        source,
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn existing_program(candidates: &[&str]) -> &'static str {
        for candidate in candidates {
            if Path::new(candidate).is_file() {
                return candidate;
            }
        }
        panic!("required test program is unavailable");
    }

    #[test]
    fn real_child_exit_is_observed_and_reaped_by_try_wait() {
        let program = existing_program(&["/usr/bin/false", "/bin/false"]);
        let mut child = Command::new(program).spawn().expect("spawn false");
        let cancellation = AtomicBool::new(false);
        let outcome = wait_process(&mut child, 5_000, &cancellation).expect("wait");
        assert_eq!(outcome, WaitOutcome::Exited(1));
    }

    #[test]
    fn real_child_timeout_requires_containment_before_reap() {
        let program = existing_program(&["/usr/bin/sleep", "/bin/sleep"]);
        let mut child = Command::new(program).arg("5").spawn().expect("spawn sleep");
        let cancellation = AtomicBool::new(false);
        let outcome = wait_process(&mut child, 20, &cancellation).expect("wait");
        assert_eq!(outcome, WaitOutcome::TimedOut);
        let graceful = terminate_process(&mut child, 1_000).expect("terminate");
        if graceful == GracefulTerminationOutcome::StillRunning {
            force_kill_and_reap(&mut child).expect("force kill");
        }
        assert!(child.try_wait().expect("final wait").is_some());
    }

    #[test]
    fn cancellation_is_observed_by_real_wait_loop() {
        let program = existing_program(&["/usr/bin/sleep", "/bin/sleep"]);
        let mut child = Command::new(program).arg("5").spawn().expect("spawn sleep");
        let cancellation = AtomicBool::new(true);
        let outcome = wait_process(&mut child, 5_000, &cancellation).expect("wait");
        assert_eq!(outcome, WaitOutcome::Cancelled);
        force_kill_and_reap(&mut child).expect("contain cancelled child");
    }

    #[test]
    fn invalid_binary_identity_is_rejected_before_host_creation() {
        let config = LinuxMicroVmHostConfig {
            sha256_program: PathBuf::from("/usr/bin/sha256sum"),
            firecracker_sha256: "sha256:ABC".to_owned(),
            jailer_sha256:
                "sha256:1111111111111111111111111111111111111111111111111111111111111111"
                    .to_owned(),
            cgroup_mount: PathBuf::from("/sys/fs/cgroup"),
            cgroup_parent_relative: PathBuf::from("walle"),
            chroot_base: PathBuf::from("/srv/jailer"),
            mkfs_ext4_program: None,
            boot_args: "console=ttyS0".to_owned(),
        };
        assert!(matches!(
            LinuxMicroVmHost::new(config),
            Err(LinuxHostError::InvalidFirecrackerSha256)
        ));
    }
}
