use std::fs;
use std::io;

pub const TARGET_CPU_VENDOR: &str = "GenuineIntel";
pub const TARGET_SILICON_PROCESS: &str = "Intel 18A";
pub const TARGET_INSTALLED_RAM_BYTES: u64 = 2 * 1024 * 1024 * 1024 * 1024;
pub const OPERATOR_SECONDARY_CAPACITY_LABEL: &str = "Gb";
pub const OPERATOR_SECONDARY_CAPACITY_BYTES: u64 = 2 * 1024 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostFacts {
    pub architecture: String,
    pub cpu_vendor_id: Option<String>,
    pub cpu_model_name: Option<String>,
    pub vmx_present: bool,
    pub usable_memory_bytes: Option<u64>,
    pub system_vendor: Option<String>,
    pub product_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HardwareVerdict {
    Blocked,
    Unverified,
}

impl HardwareVerdict {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Blocked => "BLOCKED",
            Self::Unverified => "UNVERIFIED",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HardwareAssessment {
    pub facts: HostFacts,
    pub vendor_verified: bool,
    pub vmx_verified: bool,
    pub silicon_process_verified: bool,
    pub installed_ram_verified: bool,
    pub secondary_capacity_component_resolved: bool,
    pub secondary_capacity_verified: bool,
    pub verdict: HardwareVerdict,
    pub reason: &'static str,
}

pub fn collect_host_facts() -> io::Result<HostFacts> {
    let cpuinfo = fs::read_to_string("/proc/cpuinfo")?;
    let meminfo = fs::read_to_string("/proc/meminfo")?;

    Ok(HostFacts {
        architecture: std::env::consts::ARCH.to_owned(),
        cpu_vendor_id: cpu_field(&cpuinfo, "vendor_id"),
        cpu_model_name: cpu_field(&cpuinfo, "model name"),
        vmx_present: cpu_flags(&cpuinfo).iter().any(|flag| flag == "vmx"),
        usable_memory_bytes: parse_mem_total_bytes(&meminfo),
        system_vendor: read_trimmed("/sys/devices/virtual/dmi/id/sys_vendor"),
        product_name: read_trimmed("/sys/devices/virtual/dmi/id/product_name"),
    })
}

pub fn assess_target(facts: HostFacts) -> HardwareAssessment {
    let vendor_verified = facts.cpu_vendor_id.as_deref() == Some(TARGET_CPU_VENDOR);
    let vmx_verified = facts.vmx_present;

    // Linux cpuinfo does not prove the silicon fabrication node. MemTotal is
    // usable memory, not authoritative installed DIMM capacity. The operator's
    // second "Gb 2 TB" requirement does not identify a hardware component.
    // WALLE therefore keeps all three claims explicitly unverified rather than
    // manufacturing a PASS from approximate or ambiguous observations.
    let silicon_process_verified = false;
    let installed_ram_verified = false;
    let secondary_capacity_component_resolved = false;
    let secondary_capacity_verified = false;

    let (verdict, reason) = if facts.cpu_vendor_id.is_some() && !vendor_verified {
        (HardwareVerdict::Blocked, "CPU_VENDOR_MISMATCH")
    } else if !vendor_verified || !vmx_verified {
        (HardwareVerdict::Unverified, "HOST_BASELINE_NOT_VERIFIED")
    } else {
        (
            HardwareVerdict::Unverified,
            "PLATFORM_ATTESTATION_REQUIRED_FOR_18A_RAM_AND_SECONDARY_CAPACITY",
        )
    };

    HardwareAssessment {
        facts,
        vendor_verified,
        vmx_verified,
        silicon_process_verified,
        installed_ram_verified,
        secondary_capacity_component_resolved,
        secondary_capacity_verified,
        verdict,
        reason,
    }
}

fn cpu_field(input: &str, key: &str) -> Option<String> {
    input.lines().find_map(|line| {
        let (left, right) = line.split_once(':')?;
        if left.trim() != key {
            return None;
        }
        let value = right.trim();
        if value.is_empty() {
            None
        } else {
            Some(value.to_owned())
        }
    })
}

fn cpu_flags(input: &str) -> Vec<String> {
    cpu_field(input, "flags")
        .or_else(|| cpu_field(input, "Features"))
        .map(|value| value.split_whitespace().map(str::to_owned).collect())
        .unwrap_or_default()
}

fn parse_mem_total_bytes(input: &str) -> Option<u64> {
    let line = input.lines().find(|line| line.starts_with("MemTotal:"))?;
    let mut parts = line.split_whitespace();
    if parts.next()? != "MemTotal:" {
        return None;
    }
    let kib = parts.next()?.parse::<u64>().ok()?;
    if parts.next()? != "kB" {
        return None;
    }
    kib.checked_mul(1024)
}

fn read_trimmed(path: &str) -> Option<String> {
    fs::read_to_string(path).ok().and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_owned())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_intel_vendor_and_vmx() {
        let cpuinfo =
            "processor : 0\nvendor_id : GenuineIntel\nmodel name : Test CPU\nflags : fpu vmx sse\n";
        assert_eq!(
            cpu_field(cpuinfo, "vendor_id").as_deref(),
            Some("GenuineIntel")
        );
        assert!(cpu_flags(cpuinfo).contains(&"vmx".to_owned()));
    }

    #[test]
    fn parses_memtotal_as_usable_bytes() {
        assert_eq!(
            parse_mem_total_bytes("MemTotal:       2048 kB\nMemFree: 1 kB\n"),
            Some(2 * 1024 * 1024)
        );
    }

    #[test]
    fn does_not_fabricate_18a_or_installed_ram() {
        let assessment = assess_target(HostFacts {
            architecture: "x86_64".to_owned(),
            cpu_vendor_id: Some("GenuineIntel".to_owned()),
            cpu_model_name: Some("Future Intel CPU".to_owned()),
            vmx_present: true,
            usable_memory_bytes: Some(TARGET_INSTALLED_RAM_BYTES),
            system_vendor: Some("Intel".to_owned()),
            product_name: Some("Lab".to_owned()),
        });

        assert!(assessment.vendor_verified);
        assert!(assessment.vmx_verified);
        assert!(!assessment.silicon_process_verified);
        assert!(!assessment.installed_ram_verified);
        assert!(!assessment.secondary_capacity_component_resolved);
        assert!(!assessment.secondary_capacity_verified);
        assert_eq!(assessment.verdict, HardwareVerdict::Unverified);
    }

    #[test]
    fn blocks_wrong_cpu_vendor() {
        let assessment = assess_target(HostFacts {
            architecture: "x86_64".to_owned(),
            cpu_vendor_id: Some("AuthenticAMD".to_owned()),
            cpu_model_name: None,
            vmx_present: false,
            usable_memory_bytes: None,
            system_vendor: None,
            product_name: None,
        });

        assert_eq!(assessment.verdict, HardwareVerdict::Blocked);
        assert_eq!(assessment.reason, "CPU_VENDOR_MISMATCH");
    }
}
