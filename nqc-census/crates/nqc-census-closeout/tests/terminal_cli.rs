use std::{
    error::Error,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn hex(byte: u8, bytes: usize) -> String {
    format!("{byte:02x}").repeat(bytes)
}

fn valid_lock() -> String {
    let stages = (6_u8..=13)
        .map(|stage| {
            format!(
                r#"{{
  "stage":"RMC-{stage:03}",
  "workflow_run_id":{run_id},
  "artifact_id":{artifact_id},
  "artifact_name":"rmc-{stage:03}-terminal",
  "artifact_digest":"sha256:{artifact}",
  "code_commit":"{commit}",
  "code_tree":"{tree}",
  "authority_commitment":"0x{authority}",
  "coverage_commitment":"0x{coverage}",
  "unresolved_mismatch_count":0,
  "unknown_failure_count":0,
  "blocker_count":0,
  "coverage_complete":true,
  "admitted":true,
  "evidence":["0x{evidence}"]
}}"#,
                run_id = 1000_u64 + u64::from(stage),
                artifact_id = 2000_u64 + u64::from(stage),
                artifact = hex(stage, 32),
                commit = hex(stage, 20),
                tree = hex(stage.saturating_add(16), 20),
                authority = hex(stage.saturating_add(32), 32),
                coverage = hex(stage.saturating_add(48), 32),
                evidence = hex(stage.saturating_add(64), 32),
            )
        })
        .collect::<Vec<_>>()
        .join(",");

    format!(
        r#"{{
  "schema_version":2,
  "status":"PINNED",
  "real_market_census_closed":false,
  "required_terminal_stages":["RMC-006","RMC-007","RMC-008","RMC-009","RMC-010","RMC-011","RMC-012","RMC-013"],
  "pinned_stages":[{stages}],
  "pipeline_counts":{{
    "markets_discovered":100,
    "markets_canonicalized":90,
    "markets_state_reconstructable":80,
    "markets_economically_active":70,
    "markets_borrowable":60,
    "actionable_candidates":20,
    "capital_feasible_candidates":15,
    "execution_simulatable_candidates":10,
    "positive_gross_value_candidates":9,
    "positive_success_path_net_candidates":7,
    "capacity_material_candidates":2,
    "shadow_eligible_candidates":1
  }},
  "economic_boundary":{{
    "real_candidate_count":20,
    "economics_quote_count":10,
    "shadow_prediction_count":1,
    "capture_calibrated_count":0,
    "zero_own_capital_proven":true,
    "realized_profitability_proven":false,
    "monthly_target_probability_proven":false,
    "conservative_realizable_capacity_only":true,
    "global_capital_source_completeness_claimed":false,
    "global_route_venue_completeness_claimed":false
  }},
  "terminal_evidence":["0x{terminal}"],
  "blocking_reasons":[]
}}"#,
        terminal = hex(240, 32)
    )
}

fn workdir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("nqc-rmc014-{name}-{}", std::process::id()))
}

fn run(lock: &Path, out: &Path) -> Result<std::process::Output> {
    Ok(Command::new(env!("CARGO_BIN_EXE_nqc-rmc014-closeout"))
        .arg(lock)
        .arg(out)
        .output()?)
}

#[test]
fn valid_lock_emits_byte_stable_terminal_certificate() -> Result<()> {
    let root = workdir("valid");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root)?;
    let lock = root.join("lock.json");
    fs::write(&lock, valid_lock())?;

    let out_a = root.join("a");
    let out_b = root.join("b");
    let first = run(&lock, &out_a)?;
    let second = run(&lock, &out_b)?;
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    assert_eq!(
        fs::read(out_a.join("real-market-census-certificate.json"))?,
        fs::read(out_b.join("real-market-census-certificate.json"))?
    );
    assert_eq!(
        fs::read(out_a.join("real-market-census-certificate.sha256"))?,
        fs::read(out_b.join("real-market-census-certificate.sha256"))?
    );
    assert!(String::from_utf8_lossy(&first.stdout).contains("REAL_MARKET_CENSUS_CLOSED"));
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn source_lock_cannot_self_certify_or_smuggle_profitability() -> Result<()> {
    for (name, needle, replacement) in [
        (
            "self-closed",
            r#""real_market_census_closed":false"#,
            r#""real_market_census_closed":true"#,
        ),
        (
            "realized-pnl",
            r#""realized_profitability_proven":false"#,
            r#""realized_profitability_proven":true"#,
        ),
        (
            "monthly-target",
            r#""monthly_target_probability_proven":false"#,
            r#""monthly_target_probability_proven":true"#,
        ),
        (
            "non-conservative-scope",
            r#""conservative_realizable_capacity_only":true"#,
            r#""conservative_realizable_capacity_only":false"#,
        ),
        (
            "global-capital-overclaim",
            r#""global_capital_source_completeness_claimed":false"#,
            r#""global_capital_source_completeness_claimed":true"#,
        ),
        (
            "global-route-overclaim",
            r#""global_route_venue_completeness_claimed":false"#,
            r#""global_route_venue_completeness_claimed":true"#,
        ),
    ] {
        let root = workdir(name);
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root)?;
        let lock = root.join("lock.json");
        fs::write(&lock, valid_lock().replace(needle, replacement))?;
        let output = run(&lock, &root.join("out"))?;
        assert!(!output.status.success(), "{name} unexpectedly passed");
        fs::remove_dir_all(root)?;
    }
    Ok(())
}

#[test]
fn incomplete_or_non_monotonic_terminal_truth_fails_closed() -> Result<()> {
    for (name, needle, replacement) in [
        (
            "missing-evidence",
            r#""terminal_evidence":["0x"#,
            r#""terminal_evidence":[]"#,
        ),
        (
            "non-monotonic",
            r#""capital_feasible_candidates":15"#,
            r#""capital_feasible_candidates":21"#,
        ),
    ] {
        let root = workdir(name);
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root)?;
        let lock = root.join("lock.json");
        let mut body = valid_lock();
        if name == "missing-evidence" {
            let start = body
                .find(r#""terminal_evidence":["#)
                .ok_or("missing terminal evidence")?;
            let end = body[start..]
                .find("],")
                .ok_or("missing terminal evidence end")?
                + start;
            body.replace_range(start..end + 1, r#""terminal_evidence":[]"#);
        } else {
            body = body.replace(needle, replacement);
        }
        fs::write(&lock, body)?;
        let output = run(&lock, &root.join("out"))?;
        assert!(!output.status.success(), "{name} unexpectedly passed");
        fs::remove_dir_all(root)?;
    }
    Ok(())
}
