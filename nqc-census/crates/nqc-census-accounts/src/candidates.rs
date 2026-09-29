//! Candidate accounts derived from replayed `ACCOUNT_INDEX` stages.
//!
//! Every provider's partitions must tile the global job grid exactly, and
//! every provider must have returned identical logs for every job (compared
//! through the per-job log digest and pair list). Any difference is a
//! provider disagreement and fails closed; there is no voting and no union
//! across disagreeing providers.

use crate::plan::AccountPlan;
use crate::stage::number;
use nqc_census_chain::{hex, json::Json, ChainError};
use nqc_census_core::Address;
use nqc_census_state::v2_verify::ReplayedStage;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// Accounts in address order, each with the tokens it was seen receiving.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Candidates {
    pub accounts: Vec<(Address, Vec<Address>)>,
}

impl Candidates {
    pub fn from_pairs(pairs: &BTreeSet<(Address, Address)>) -> Self {
        let mut by_account: BTreeMap<Address, Vec<Address>> = BTreeMap::new();
        for (token, account) in pairs {
            by_account.entry(*account).or_default().push(*token);
        }
        let accounts = by_account
            .into_iter()
            .map(|(account, mut tokens)| {
                tokens.sort();
                tokens.dedup();
                (account, tokens)
            })
            .collect();
        Self { accounts }
    }

    pub fn pair_count(&self) -> usize {
        self.accounts.iter().map(|(_, tokens)| tokens.len()).sum()
    }

    pub fn digest(&self) -> String {
        let mut digest = Sha256::new();
        digest.update(b"NQC-RMC009-CANDIDATES-V1");
        for (account, tokens) in &self.accounts {
            digest.update(account.as_bytes());
            digest.update((tokens.len() as u64).to_be_bytes());
            for token in tokens {
                digest.update(token.as_bytes());
            }
        }
        hex::plain(&digest.finalize())
    }

    /// One `{"account", "tokens"}` line per account.
    pub fn to_jsonl(&self) -> Result<Vec<u8>, ChainError> {
        let mut out = Vec::new();
        for (account, tokens) in &self.accounts {
            out.extend(
                Json::object([
                    ("account", Json::string(account.to_hex())),
                    (
                        "tokens",
                        Json::array(tokens.iter().map(|token| Json::string(token.to_hex()))),
                    ),
                ])
                .canonical()?,
            );
            out.push(b'\n');
        }
        Ok(out)
    }

    /// Parses `to_jsonl` output; accounts and tokens must be strictly
    /// ascending (the only form `to_jsonl` writes).
    pub fn from_jsonl(bytes: &[u8]) -> Result<Self, ChainError> {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| ChainError::Evidence("candidates are not UTF-8".into()))?;
        let mut accounts: Vec<(Address, Vec<Address>)> = Vec::new();
        for line in text.lines().filter(|line| !line.is_empty()) {
            let row = Json::parse(line.as_bytes())?;
            let account = Address::parse_hex(row.str_field("account")?)?;
            let tokens = row
                .get("tokens")
                .and_then(Json::as_array)
                .ok_or_else(|| ChainError::Evidence("candidate without tokens".into()))?
                .iter()
                .map(|token| {
                    Ok(Address::parse_hex(token.as_str().ok_or_else(|| {
                        ChainError::Evidence("candidate token is not text".into())
                    })?)?)
                })
                .collect::<Result<Vec<_>, ChainError>>()?;
            if tokens.is_empty() || tokens.windows(2).any(|pair| pair[0] >= pair[1]) {
                return Err(ChainError::Evidence(
                    "candidate tokens are not strictly ascending".into(),
                ));
            }
            if accounts.last().is_some_and(|(last, _)| *last >= account) {
                return Err(ChainError::Evidence(
                    "candidate accounts are not strictly ascending".into(),
                ));
            }
            accounts.push((account, tokens));
        }
        Ok(Self { accounts })
    }
}

/// Counters over the agreed index.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IndexFacts {
    pub providers: Vec<String>,
    pub jobs: u64,
    pub logs: u64,
    pub mint_logs: u64,
    pub balance_transfer_logs: u64,
    pub zero_account_logs: u64,
}

impl IndexFacts {
    pub fn json(&self) -> Json {
        Json::object([
            (
                "providers",
                Json::array(self.providers.iter().map(|p| Json::string(p.clone()))),
            ),
            ("jobs", Json::uint(self.jobs)),
            ("logs", Json::uint(self.logs)),
            ("mint_logs", Json::uint(self.mint_logs)),
            (
                "balance_transfer_logs",
                Json::uint(self.balance_transfer_logs),
            ),
            ("zero_account_logs", Json::uint(self.zero_account_logs)),
        ])
    }
}

fn provider_rows<'a>(
    stages: &[&'a ReplayedStage],
    plan: &AccountPlan,
) -> Result<Vec<&'a Json>, ChainError> {
    let mut by_partition: BTreeMap<u64, &ReplayedStage> = BTreeMap::new();
    let mut partitions = None;
    for stage in stages {
        let p = number(&stage.parameters, "partitions")?;
        if *partitions.get_or_insert(p) != p {
            return Err(ChainError::Evidence(
                "index stages of one provider use different partition counts".into(),
            ));
        }
        if stage.parameters.str_field("tokens_sha256")? != plan.tokens_digest()
            || number(&stage.parameters, "anchor")? != plan.anchor.number
            || number(&stage.parameters, "job_span")? != plan.job_span
        {
            return Err(ChainError::Evidence(
                "index stage was run for another plan".into(),
            ));
        }
        if by_partition
            .insert(number(&stage.parameters, "partition")?, stage)
            .is_some()
        {
            return Err(ChainError::Evidence("duplicate index partition".into()));
        }
    }
    let partitions = partitions.unwrap_or(0);
    if partitions == 0 || by_partition.keys().copied().ne(0..partitions) {
        return Err(ChainError::Evidence(
            "index partitions are not exactly 0..P".into(),
        ));
    }
    let rows: Vec<&Json> = by_partition
        .values()
        .flat_map(|stage| stage.rows.iter())
        .collect();
    let grid = plan.job_ranges();
    if rows.len() != grid.len() {
        return Err(ChainError::Evidence(
            "index jobs do not cover the job grid".into(),
        ));
    }
    for (row, (first, last)) in rows.iter().zip(&grid) {
        if number(row, "first")? != *first || number(row, "last")? != *last {
            return Err(ChainError::Evidence(format!(
                "index job [{}, {}] is off the grid",
                number(row, "first")?,
                number(row, "last")?
            )));
        }
    }
    Ok(rows)
}

/// Agreed candidates from the replayed index stages of at least two
/// providers.
pub fn derive_candidates(
    stages: &[ReplayedStage],
    plan: &AccountPlan,
) -> Result<(Candidates, IndexFacts), ChainError> {
    let mut by_provider: BTreeMap<&str, Vec<&ReplayedStage>> = BTreeMap::new();
    for stage in stages {
        by_provider
            .entry(stage.provider.as_str())
            .or_default()
            .push(stage);
    }
    if by_provider.len() < 2 {
        return Err(ChainError::Evidence(
            "the account index needs at least two providers".into(),
        ));
    }
    let mut views = Vec::new();
    for (provider, stages) in &by_provider {
        views.push((*provider, provider_rows(stages, plan)?));
    }
    let (reference_provider, reference) = &views[0];
    for (provider, rows) in &views[1..] {
        for (left, right) in reference.iter().zip(rows) {
            if !left.same_as(right)? {
                return Err(ChainError::Evidence(format!(
                    "providers {reference_provider} and {provider} disagree on account index job [{}, {}]: fail closed",
                    number(left, "first")?,
                    number(left, "last")?
                )));
            }
        }
    }
    let mut pairs = BTreeSet::new();
    let mut facts = IndexFacts {
        providers: views.iter().map(|(p, _)| (*p).to_owned()).collect(),
        ..IndexFacts::default()
    };
    for row in reference {
        facts.jobs += 1;
        facts.logs += number(row, "log_count")?;
        facts.mint_logs += number(row, "mint_logs")?;
        facts.balance_transfer_logs += number(row, "balance_transfer_logs")?;
        facts.zero_account_logs += number(row, "zero_account_logs")?;
        for pair in row
            .get("pairs")
            .and_then(Json::as_array)
            .ok_or_else(|| ChainError::Evidence("index job without pairs".into()))?
        {
            let items = pair
                .as_array()
                .filter(|items| items.len() == 2)
                .ok_or_else(|| ChainError::Evidence("malformed candidate pair".into()))?;
            let text = |item: &Json| {
                item.as_str()
                    .ok_or_else(|| ChainError::Evidence("candidate pair is not text".into()))
                    .and_then(|text| Ok(Address::parse_hex(text)?))
            };
            pairs.insert((text(&items[0])?, text(&items[1])?));
        }
    }
    Ok((Candidates::from_pairs(&pairs), facts))
}
