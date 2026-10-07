//! A certified RMC-009 closeout used as the base of a refresh.

use nqc_census_accounts::candidates::Candidates;
use nqc_census_chain::{json::Json, ChainError};
use nqc_census_core::{Address, Hash32};
use nqc_census_state::stage::sha256_plain;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct BaseCensus {
    pub anchor_number: u64,
    pub anchor_hash: Hash32,
    pub candidates: Candidates,
    /// Every indexed token of the base and its reserve's initialization
    /// block.
    pub tokens: BTreeMap<Address, u64>,
}

fn read(dir: &Path, name: &str) -> Result<Vec<u8>, ChainError> {
    std::fs::read(dir.join(name))
        .map_err(|error| ChainError::Config(format!("{}/{name}: {error}", dir.display())))
}

fn number(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| ChainError::Evidence(format!("base field {key} missing")))
}

/// Reads a certified RMC-009 closeout directory: it must have passed, every
/// artifact must match its evidence-manifest digest, and the candidates must
/// be the ones its summary names.
pub fn read_base(dir: &Path) -> Result<BaseCensus, ChainError> {
    let evidence = Json::parse(&read(dir, "evidence-manifest.json")?)?;
    let artifacts = evidence
        .get("artifacts")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("base evidence lists no artifacts".into()))?;
    let mut digests = BTreeMap::new();
    for artifact in artifacts {
        let path = artifact.str_field("path")?;
        let observed = sha256_plain(&read(dir, path)?);
        if observed != artifact.str_field("sha256")? {
            return Err(ChainError::Evidence(format!(
                "base artifact {path} does not match its evidence digest"
            )));
        }
        digests.insert(path.to_owned(), observed);
    }
    for required in [
        "account-summary.json",
        "candidate-accounts.jsonl",
        "reserve-tokens.jsonl",
    ] {
        if !digests.contains_key(required) {
            return Err(ChainError::Evidence(format!(
                "base evidence does not cover {required}"
            )));
        }
    }
    let summary = Json::parse(&read(dir, "account-summary.json")?)?;
    if summary.str_field("status")? != "RMC_009_PASS_CANDIDATE" {
        return Err(ChainError::Evidence("the base census did not pass".into()));
    }
    let anchor = summary
        .get("anchor")
        .ok_or_else(|| ChainError::Evidence("base summary names no anchor".into()))?;
    let candidates = Candidates::from_jsonl(&read(dir, "candidate-accounts.jsonl")?)?;
    if candidates.digest() != summary.str_field("candidates_sha256")? {
        return Err(ChainError::Evidence(
            "base candidates are not the ones its summary names".into(),
        ));
    }
    let mut tokens = BTreeMap::new();
    let text = String::from_utf8(read(dir, "reserve-tokens.jsonl")?)
        .map_err(|_| ChainError::Evidence("base reserve tokens are not UTF-8".into()))?;
    for line in text.lines().filter(|line| !line.is_empty()) {
        let row = Json::parse(line.as_bytes())?;
        let block = number(&row, "initialized_block")?;
        for key in ["a_token", "variable_debt_token"] {
            tokens.insert(Address::parse_hex(row.str_field(key)?)?, block);
        }
    }
    Ok(BaseCensus {
        anchor_number: number(anchor, "number")?,
        anchor_hash: Hash32::parse_hex(anchor.str_field("hash")?)?,
        candidates,
        tokens,
    })
}
