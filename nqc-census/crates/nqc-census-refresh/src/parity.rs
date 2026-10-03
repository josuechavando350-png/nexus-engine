//! Byte-for-byte parity between a full census and an incremental refresh of
//! the same anchor.

use nqc_census_chain::{json::Json, ChainError};
use nqc_census_state::stage::sha256_plain;
use std::collections::BTreeSet;
use std::path::Path;

/// Mode-dependent provenance: how the anchor was reached, not what it is.
pub const PROVENANCE_ARTIFACTS: [&str; 2] =
    ["acquisition-provenance.json", "evidence-manifest.json"];

fn listing(dir: &Path) -> Result<BTreeSet<String>, ChainError> {
    let mut names = BTreeSet::new();
    for entry in std::fs::read_dir(dir)
        .map_err(|error| ChainError::Config(format!("{}: {error}", dir.display())))?
    {
        let entry = entry.map_err(|error| ChainError::Config(error.to_string()))?;
        names.insert(entry.file_name().to_string_lossy().into_owned());
    }
    for required in PROVENANCE_ARTIFACTS {
        if !names.remove(required) {
            return Err(ChainError::Evidence(format!(
                "{} has no {required}",
                dir.display()
            )));
        }
    }
    Ok(names)
}

fn mode(dir: &Path) -> Result<String, ChainError> {
    let bytes = std::fs::read(dir.join("acquisition-provenance.json"))
        .map_err(|error| ChainError::Config(error.to_string()))?;
    Ok(Json::parse(&bytes)?
        .get("acquisition")
        .ok_or_else(|| ChainError::Evidence("provenance without acquisition".into()))?
        .str_field("mode")?
        .to_owned())
}

/// Every census artifact of `full` (a `FULL_CENSUS`) and `incremental` (an
/// `INCREMENTAL_REFRESH`) must exist in both and be byte-identical.
pub fn census_parity(full: &Path, incremental: &Path) -> Result<Json, ChainError> {
    let (left, right) = (listing(full)?, listing(incremental)?);
    if left != right {
        return Err(ChainError::Evidence(format!(
            "census artifact sets differ: {:?}",
            left.symmetric_difference(&right).collect::<Vec<_>>()
        )));
    }
    if left.is_empty() {
        return Err(ChainError::Evidence(
            "no census artifacts to compare".into(),
        ));
    }
    let (full_mode, incremental_mode) = (mode(full)?, mode(incremental)?);
    if full_mode != "FULL_CENSUS" || incremental_mode != "INCREMENTAL_REFRESH" {
        return Err(ChainError::Evidence(format!(
            "parity compares a full census with an incremental refresh, not {full_mode} with {incremental_mode}"
        )));
    }
    let mut artifacts = Vec::new();
    let mut differing = Vec::new();
    for name in &left {
        let read = |dir: &Path| {
            std::fs::read(dir.join(name)).map_err(|error| ChainError::Config(error.to_string()))
        };
        let (a, b) = (read(full)?, read(incremental)?);
        if a != b {
            differing.push(name.clone());
        }
        artifacts.push(Json::object([
            ("path", Json::string(name.clone())),
            ("sha256", Json::string(sha256_plain(&a))),
            ("bytes", Json::uint(a.len() as u64)),
        ]));
    }
    if !differing.is_empty() {
        return Err(ChainError::Evidence(format!(
            "FULL_INCREMENTAL_PARITY_FAILED: {differing:?} differ"
        )));
    }
    Ok(Json::object([
        ("status", Json::string("FULL_INCREMENTAL_PARITY_PASS")),
        ("artifacts", Json::Array(artifacts)),
        (
            "excluded_provenance",
            Json::array(PROVENANCE_ARTIFACTS.iter().map(|name| Json::string(*name))),
        ),
    ]))
}
