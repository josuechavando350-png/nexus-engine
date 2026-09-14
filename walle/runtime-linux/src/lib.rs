#![cfg_attr(
    not(all(target_os = "linux", target_arch = "x86_64")),
    allow(dead_code)
)]

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("walle-runtime-linux currently supports Linux x86_64 only");

pub mod artifact;
pub mod certification_runtime;
pub mod cgroup;
pub mod evidence;
pub mod firecracker;
pub mod guest_image;
pub mod guest_protocol;
pub mod guest_rootfs;
pub mod host;
pub mod host_facts;
pub mod runner;
pub mod safe_fs;
pub mod supervisor_evidence;
pub mod trusted_guest_evidence;
pub mod trusted_guest_proofs;
pub mod trusted_runner;
