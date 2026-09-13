#![cfg_attr(
    not(all(target_os = "linux", target_arch = "x86_64")),
    allow(dead_code)
)]

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("walle-runtime-linux currently supports Linux x86_64 only");

pub mod artifact;
pub mod cgroup;
pub mod evidence;
pub mod firecracker;
pub mod host;
pub mod safe_fs;
