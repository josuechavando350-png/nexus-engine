//! Replayable single-provider acquisition stages of RMC-008.
//!
//! A stage runs on one provider (and, for the V2 state, one index
//! partition), persists every exchange and observation in the RMC-004 store,
//! and returns a small record — `{schema, stage, provider, parameters,
//! manifests, row_count, data_sha256}` — plus its rows. The offline
//! reconciler re-runs every stage through a replay transport built only from
//! the manifests the record names and requires a byte-identical record.

use nqc_census_chain::{
    acquire::Acquisition, ethereum::ChainProfile, hex, job::JobContext, json::Json,
    provider::ProviderSpec, ChainError,
};
use nqc_census_core::{
    Address, CallContext, CallOutcome, ChainDomain, Hash32, ObservationSemantics, StateAnchor,
};
use sha2::{Digest, Sha256};

pub const STAGE_SCHEMA: &str = "nqc-rmc-008-state-stage-record-v1";

/// Gas bound for every call into a contract the census does not trust
/// (tokens, oracle sources). A fixed bound keeps outcomes provider-invariant.
pub const UNTRUSTED_CALL_GAS: u64 = 5_000_000;

pub fn untrusted_call() -> CallContext {
    CallContext::new(None, [0; 32], Some(UNTRUSTED_CALL_GAS))
}

/// Outcome of a call into an untrusted contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Untrusted {
    /// A typed CONTRACT_CALL observation (returned, or reverted with data).
    Call(CallOutcome),
    /// The EVM reverted and the provider transported no revert data
    /// (JSON-RPC code 3 without `data`). The exact reply is a recorded
    /// exchange; there is no typed observation for it.
    RevertedWithoutData,
    /// A deterministic EVM exceptional halt reported as a provider error
    /// (invalid opcode, invalid jump, stack violation, out of gas under the
    /// fixed gas bound). The exact reply is a recorded exchange.
    Halted,
}

impl Untrusted {
    /// `None` when the call did not return normally.
    pub fn returned(&self) -> Option<&[u8]> {
        match self {
            Self::Call(CallOutcome::Returned(bytes)) => Some(bytes),
            _ => None,
        }
    }
}

const EVM_HALTS: [&str; 12] = [
    "invalid opcode",
    "invalid jump",
    "stack underflow",
    "stack overflow",
    "stack limit reached",
    "out of gas",
    "write protection",
    "return data out of bounds",
    "badinstruction",
    "badjumpdestination",
    "outofgas",
    "stackunderflow",
];

fn tolerated(error: &ChainError) -> Option<Untrusted> {
    match error {
        ChainError::AmbiguousRevert { .. } => Some(Untrusted::RevertedWithoutData),
        ChainError::ProviderError { message, .. } => {
            let message = message.to_ascii_lowercase();
            EVM_HALTS
                .iter()
                .any(|needle| message.contains(needle))
                .then_some(Untrusted::Halted)
        }
        _ => None,
    }
}

/// Calls into untrusted contracts under the fixed gas bound.
///
/// Requests go out in provider-sized batches. A batch that fails only
/// because a call reverted without data or halted is bisected until the
/// failing call stands alone; its reply is still a recorded exchange, so an
/// offline replay retraces exactly the same requests. Any other error
/// (transport, archive, unknown provider failure) fails the job.
pub fn untrusted_calls(
    ctx: &mut JobContext<'_>,
    requests: &[(Address, Vec<u8>)],
    anchor: &StateAnchor,
    semantics: ObservationSemantics,
) -> Result<Vec<Untrusted>, ChainError> {
    let mut out = Vec::with_capacity(requests.len());
    for chunk in requests.chunks(ctx.provider().max_batch().max(1)) {
        bisect(ctx, chunk, anchor, semantics, &mut out)?;
    }
    Ok(out)
}

fn bisect(
    ctx: &mut JobContext<'_>,
    requests: &[(Address, Vec<u8>)],
    anchor: &StateAnchor,
    semantics: ObservationSemantics,
    out: &mut Vec<Untrusted>,
) -> Result<(), ChainError> {
    if requests.is_empty() {
        return Ok(());
    }
    match ctx.calls_in_context(requests, untrusted_call(), anchor, semantics) {
        Ok(calls) => {
            out.extend(
                calls
                    .into_iter()
                    .map(|call| Untrusted::Call(call.payload().outcome().clone())),
            );
            Ok(())
        }
        Err(error) => match tolerated(&error) {
            Some(outcome) if requests.len() == 1 => {
                out.push(outcome);
                Ok(())
            }
            Some(_) => {
                let middle = requests.len() / 2;
                bisect(ctx, &requests[..middle], anchor, semantics, out)?;
                bisect(ctx, &requests[middle..], anchor, semantics, out)
            }
            None => Err(error),
        },
    }
}

/// The observation anchor every RMC-008 stage is pinned to.
#[derive(Debug, Clone)]
pub struct AnchorPlan {
    pub profile: ChainProfile,
    pub number: u64,
    pub hash: Hash32,
}

impl AnchorPlan {
    pub fn mainnet() -> Result<Self, ChainError> {
        Ok(Self {
            profile: ChainProfile::mainnet()?,
            number: 25_437_474,
            hash: Hash32::parse_hex(
                "0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8",
            )?,
        })
    }
}

pub fn data_digest(rows: &[Json]) -> Result<String, ChainError> {
    let mut digest = Sha256::new();
    digest.update(b"NQC-RMC008-STAGE-DATA-V1");
    for row in rows {
        let bytes = row.canonical()?;
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(&bytes);
    }
    Ok(hex::plain(&digest.finalize()))
}

pub fn sha256_plain(bytes: &[u8]) -> String {
    hex::plain(&Sha256::digest(bytes))
}

/// Chain domain and verified anchor from one provider; the anchor must be the
/// declared one.
pub fn stage_anchor(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    plan: &AnchorPlan,
) -> Result<(ChainDomain, StateAnchor, Vec<String>), ChainError> {
    let (facts, bootstrap) = acquisition.bootstrap(provider, &plan.profile)?;
    let (anchor, anchor_output) =
        acquisition.resolve_anchor(provider, &facts.chain, plan.number)?;
    if anchor.block_hash() != plan.hash {
        return Err(ChainError::Evidence(
            "provider anchor differs from the declared observation anchor".into(),
        ));
    }
    Ok((
        facts.chain,
        anchor,
        vec![
            bootstrap.manifest_id().to_hex(),
            anchor_output.manifest_id().to_hex(),
        ],
    ))
}

pub fn record(
    stage: &str,
    provider: &ProviderSpec,
    parameters: Json,
    manifests: &[String],
    rows: &[Json],
) -> Result<Json, ChainError> {
    Ok(Json::object([
        ("schema", Json::string(STAGE_SCHEMA)),
        ("stage", Json::string(stage)),
        ("provider", provider.descriptor()),
        ("parameters", parameters),
        (
            "manifests",
            Json::array(manifests.iter().map(|id| Json::string(id.clone()))),
        ),
        ("row_count", Json::uint(rows.len() as u64)),
        ("data_sha256", Json::string(data_digest(rows)?)),
    ]))
}

/// Deterministic contiguous partition `k` of `0..count`.
pub fn index_partition(
    count: u64,
    partition: u64,
    partitions: u64,
) -> Result<Option<(u64, u64)>, ChainError> {
    if partitions == 0 || partition >= partitions {
        return Err(ChainError::Config("invalid index partition".into()));
    }
    let size = count.div_ceil(partitions);
    let first = partition.saturating_mul(size);
    if first >= count {
        return Ok(None);
    }
    Ok(Some((first, (first + size).min(count) - 1)))
}

/// Outcome of one call as canonical JSON: the exact returned or revert bytes.
pub fn outcome_json(outcome: &nqc_census_core::CallOutcome) -> Json {
    match outcome {
        nqc_census_core::CallOutcome::Returned(bytes) => Json::object([
            ("status", Json::string("RETURNED")),
            ("data", Json::string(hex::encode(bytes))),
        ]),
        nqc_census_core::CallOutcome::Reverted(bytes) => Json::object([
            ("status", Json::string("REVERTED")),
            ("data", Json::string(hex::encode(bytes))),
        ]),
    }
}

/// Parses `outcome_json` back into its status and bytes.
pub fn outcome_parts(value: &Json) -> Result<(bool, Vec<u8>), ChainError> {
    let status = value.str_field("status")?;
    let data = hex::decode_data(value.str_field("data")?)?;
    match status {
        "RETURNED" => Ok((true, data)),
        "REVERTED" | "HALTED" => Ok((false, data)),
        other => Err(ChainError::Evidence(format!("unknown call status {other}"))),
    }
}

pub fn address_json(address: Address) -> Json {
    Json::string(address.to_hex())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partitions_tile_the_index_range() -> Result<(), ChainError> {
        let parts: Vec<_> = (0..4)
            .map(|k| index_partition(10, k, 4))
            .collect::<Result<_, _>>()?;
        assert_eq!(
            parts,
            vec![Some((0, 2)), Some((3, 5)), Some((6, 8)), Some((9, 9))]
        );
        assert_eq!(index_partition(2, 3, 4)?, None);
        assert!(index_partition(2, 4, 4).is_err());
        Ok(())
    }

    #[test]
    fn outcomes_round_trip() -> Result<(), ChainError> {
        for outcome in [
            nqc_census_core::CallOutcome::Returned(vec![1, 2]),
            nqc_census_core::CallOutcome::Reverted(Vec::new()),
        ] {
            let (ok, data) = outcome_parts(&outcome_json(&outcome))?;
            assert_eq!(ok, outcome.is_success());
            assert_eq!(data, outcome.output());
        }
        Ok(())
    }
}
