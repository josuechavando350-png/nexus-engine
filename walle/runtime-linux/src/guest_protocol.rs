use std::str;

pub const GUEST_ATTESTATION_PREFIX: &str = "WALLE_GUEST_ATTESTATION_V1";
pub const GUEST_PROTOCOL_BOOT_ARG_PREFIX: &str = "walle.guest_protocol=";
pub const GUEST_PROTOCOL_BOOT_ARG: &str = "walle.guest_protocol=1";
pub const MAX_GUEST_ATTESTATION_LINE_BYTES: usize = 1_024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuestCompletion {
    Success,
    Failure,
}

impl GuestCompletion {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Success => "SUCCESS",
            Self::Failure => "FAILURE",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestAttestation {
    pub run_id: String,
    pub source_sha256: String,
    pub seccomp_mode: u8,
    pub no_new_privs: bool,
    pub network_non_loopback_interfaces: u32,
    pub workload_exit_code: i32,
    pub completion: GuestCompletion,
}

impl GuestAttestation {
    pub fn canonical_json(&self) -> String {
        format!(
            concat!(
                "{{",
                "\"completion\":\"{}\",",
                "\"network_non_loopback_interfaces\":{},",
                "\"no_new_privs\":{},",
                "\"run_id\":\"{}\",",
                "\"seccomp_mode\":{},",
                "\"source_sha256\":\"{}\",",
                "\"trust\":\"UNTRUSTED_GUEST_CLAIM_PENDING_AGENT_IDENTITY\",",
                "\"workload_exit_code\":{}",
                "}}"
            ),
            self.completion.as_str(),
            self.network_non_loopback_interfaces,
            self.no_new_privs,
            self.run_id,
            self.seccomp_mode,
            self.source_sha256,
            self.workload_exit_code,
        )
    }
}

/// Extracts exactly one strict guest attestation line from the bounded serial
/// stream. The line is identity-bound, but deliberately remains an untrusted
/// claim until a separately identified guest agent is integrated and proven.
/// Duplicate candidate lines are rejected to avoid first/last-wins ambiguity.
pub fn parse_guest_attestation(
    serial: &[u8],
    expected_run_id: &str,
    expected_source_sha256: &str,
) -> Option<GuestAttestation> {
    let mut found = None;
    for raw_line in serial.split(|byte| *byte == b'\n') {
        let line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        if !line.starts_with(GUEST_ATTESTATION_PREFIX.as_bytes()) {
            continue;
        }
        if found.is_some() || line.len() > MAX_GUEST_ATTESTATION_LINE_BYTES {
            return None;
        }
        found = Some(parse_line(
            line,
            expected_run_id,
            expected_source_sha256,
        )?);
    }
    found
}

fn parse_line(
    line: &[u8],
    expected_run_id: &str,
    expected_source_sha256: &str,
) -> Option<GuestAttestation> {
    let text = str::from_utf8(line).ok()?;
    let fields: Vec<&str> = text.split_ascii_whitespace().collect();
    if fields.len() != 8 || fields[0] != GUEST_ATTESTATION_PREFIX {
        return None;
    }

    let run_id = exact_value(fields[1], "run_id=")?;
    let source_sha256 = exact_value(fields[2], "source_sha256=")?;
    if run_id != expected_run_id || source_sha256 != expected_source_sha256 {
        return None;
    }

    let seccomp_mode = exact_value(fields[3], "seccomp_mode=")
        .and_then(|value| value.parse::<u8>().ok())?;
    if seccomp_mode > 2 {
        return None;
    }
    let no_new_privs = match exact_value(fields[4], "no_new_privs=")? {
        "0" => false,
        "1" => true,
        _ => return None,
    };
    let network_non_loopback_interfaces =
        exact_value(fields[5], "network_non_loopback_interfaces=")
            .and_then(|value| value.parse::<u32>().ok())?;
    let workload_exit_code = exact_value(fields[6], "workload_exit_code=")
        .and_then(|value| value.parse::<i32>().ok())?;
    let completion = match exact_value(fields[7], "completion=")? {
        "SUCCESS" => GuestCompletion::Success,
        "FAILURE" => GuestCompletion::Failure,
        _ => return None,
    };

    Some(GuestAttestation {
        run_id: run_id.to_owned(),
        source_sha256: source_sha256.to_owned(),
        seccomp_mode,
        no_new_privs,
        network_non_loopback_interfaces,
        workload_exit_code,
        completion,
    })
}

fn exact_value<'a>(field: &'a str, prefix: &str) -> Option<&'a str> {
    let value = field.strip_prefix(prefix)?;
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUN_ID: &str = "run-0123456789abcdef0123456789abcdef";
    const SOURCE_SHA: &str =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn valid_line() -> String {
        format!(
            "{GUEST_ATTESTATION_PREFIX} run_id={RUN_ID} source_sha256={SOURCE_SHA} seccomp_mode=2 no_new_privs=1 network_non_loopback_interfaces=0 workload_exit_code=0 completion=SUCCESS"
        )
    }

    #[test]
    fn parses_one_exact_identity_bound_candidate() {
        let serial = format!("kernel output\n{}\nshutdown\n", valid_line());
        let attestation =
            parse_guest_attestation(serial.as_bytes(), RUN_ID, SOURCE_SHA).expect("attestation");

        assert_eq!(attestation.run_id, RUN_ID);
        assert_eq!(attestation.source_sha256, SOURCE_SHA);
        assert_eq!(attestation.seccomp_mode, 2);
        assert!(attestation.no_new_privs);
        assert_eq!(attestation.network_non_loopback_interfaces, 0);
        assert_eq!(attestation.workload_exit_code, 0);
        assert_eq!(attestation.completion, GuestCompletion::Success);
        assert!(attestation
            .canonical_json()
            .contains("UNTRUSTED_GUEST_CLAIM_PENDING_AGENT_IDENTITY"));
    }

    #[test]
    fn duplicate_candidate_lines_fail_closed() {
        let line = valid_line();
        let serial = format!("{line}\n{line}\n");
        assert!(parse_guest_attestation(serial.as_bytes(), RUN_ID, SOURCE_SHA).is_none());
    }

    #[test]
    fn mismatched_identity_never_becomes_a_candidate() {
        let line = valid_line().replace(RUN_ID, "run-ffffffffffffffffffffffffffffffff");
        assert!(parse_guest_attestation(line.as_bytes(), RUN_ID, SOURCE_SHA).is_none());

        let line = valid_line().replace(
            SOURCE_SHA,
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        );
        assert!(parse_guest_attestation(line.as_bytes(), RUN_ID, SOURCE_SHA).is_none());
    }

    #[test]
    fn malformed_or_reordered_claims_are_rejected() {
        let malformed = valid_line().replace("seccomp_mode=2", "seccomp_mode=99");
        assert!(parse_guest_attestation(malformed.as_bytes(), RUN_ID, SOURCE_SHA).is_none());

        let reordered = valid_line().replace(
            "seccomp_mode=2 no_new_privs=1",
            "no_new_privs=1 seccomp_mode=2",
        );
        assert!(parse_guest_attestation(reordered.as_bytes(), RUN_ID, SOURCE_SHA).is_none());
    }

    #[test]
    fn ordinary_workload_output_cannot_be_mistaken_for_attestation() {
        assert!(parse_guest_attestation(
            b"WALLE work complete but this is not the protocol\n",
            RUN_ID,
            SOURCE_SHA
        )
        .is_none());
    }

    #[test]
    fn oversized_candidate_line_is_rejected() {
        let line = format!(
            "{} {}",
            valid_line(),
            "x".repeat(MAX_GUEST_ATTESTATION_LINE_BYTES)
        );
        assert!(parse_guest_attestation(line.as_bytes(), RUN_ID, SOURCE_SHA).is_none());
    }
}
