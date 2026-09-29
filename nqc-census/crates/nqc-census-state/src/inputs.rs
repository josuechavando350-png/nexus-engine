//! RMC-008 inputs: the admitted D06 and D07 outputs, and nothing else.
//!
//! Every input file is pinned by sha256 in `state-inputs.json`; a file whose
//! digest differs is refused before it is parsed. From the pinned files the
//! census re-derives the D01 deployment keys and checks every market id.

use crate::aave_stage::{AavePlan, AaveReserveInput};
use crate::aave_verify::AdmittedReserve;
use crate::stage::{sha256_plain, AnchorPlan};
use crate::v2_stage::{read_pair_manifest, PairInput, V2Plan};
use nqc_census_chain::{json::Json, ChainError};
use nqc_census_core::{Address, ChainDomain, DeploymentKey, Hash32, ProtocolFamily};
use std::path::{Path, PathBuf};

fn required<'a>(value: &'a Json, key: &str) -> Result<&'a Json, ChainError> {
    value
        .get(key)
        .ok_or_else(|| ChainError::Evidence(format!("missing field {key}")))
}

fn hash(text: &str) -> Result<Hash32, ChainError> {
    Ok(Hash32::parse_hex(&format!(
        "0x{}",
        text.trim_start_matches("0x")
    ))?)
}

/// Chain domain carried in a live multi-provider report's bootstrap.
pub fn chain_domain(report: &Json) -> Result<ChainDomain, ChainError> {
    let domain = required(required(report, "bootstrap")?, "chain_domain")?;
    Ok(ChainDomain::new(
        domain
            .get("chain_id")
            .and_then(Json::as_i64)
            .and_then(|id| u64::try_from(id).ok())
            .ok_or_else(|| ChainError::Evidence("chain id missing".into()))?,
        Hash32::parse_hex(domain.str_field("genesis_hash")?)?,
        Hash32::parse_hex(domain.str_field("fork_lineage")?)?,
    )?)
}

/// The observation anchor a live report was acquired at must be the declared
/// D08 anchor (number and block hash).
pub fn require_anchor(report: &Json, anchor: &AnchorPlan, what: &str) -> Result<(), ChainError> {
    let observed = required(
        required(required(report, "bootstrap")?, "anchor")?,
        "anchor",
    )?;
    let number = observed
        .get("number")
        .and_then(Json::as_i64)
        .and_then(|value| u64::try_from(value).ok());
    let hash = Hash32::parse_hex(observed.str_field("hash")?)?;
    if number != Some(anchor.number) || hash != anchor.hash {
        return Err(ChainError::Evidence(format!(
            "{what} was acquired at another anchor than the declared D08 anchor"
        )));
    }
    Ok(())
}

fn require_schema(value: &Json, expected: &str, what: &str) -> Result<(), ChainError> {
    match value.get("schema").and_then(Json::as_str) {
        Some(schema) if schema == expected => Ok(()),
        other => Err(ChainError::Evidence(format!(
            "{what} schema {other:?} is not {expected}"
        ))),
    }
}

/// One pinned input file.
#[derive(Debug, Clone)]
pub struct PinnedFile {
    pub role: String,
    pub path: PathBuf,
    pub sha256: String,
}

/// Reads `state-inputs.json` (`{"files": [{"role", "path", "sha256"}]}`,
/// paths relative to `root`) and verifies every digest.
pub fn verify_pins(pins: &Path, root: &Path) -> Result<Vec<PinnedFile>, ChainError> {
    let bytes = std::fs::read(pins)
        .map_err(|error| ChainError::Config(format!("{}: {error}", pins.display())))?;
    let document = Json::parse(&bytes)?;
    let mut out = Vec::new();
    for entry in required(&document, "files")?
        .as_array()
        .ok_or_else(|| ChainError::Evidence("pinned files are not an array".into()))?
    {
        let path = root.join(entry.str_field("path")?);
        let expected = entry.str_field("sha256")?.to_owned();
        let observed = sha256_plain(
            &std::fs::read(&path)
                .map_err(|error| ChainError::Config(format!("{}: {error}", path.display())))?,
        );
        if observed != expected {
            return Err(ChainError::Evidence(format!(
                "pinned input {} has sha256 {observed}, pinned {expected}",
                path.display()
            )));
        }
        out.push(PinnedFile {
            role: entry.str_field("role")?.to_owned(),
            path,
            sha256: expected,
        });
    }
    Ok(out)
}

pub fn pinned<'a>(files: &'a [PinnedFile], role: &str) -> Result<&'a Path, ChainError> {
    files
        .iter()
        .find(|file| file.role == role)
        .map(|file| file.path.as_path())
        .ok_or_else(|| ChainError::Config(format!("no pinned input with role {role}")))
}

fn read_json(path: &Path) -> Result<Json, ChainError> {
    Json::parse(
        &std::fs::read(path)
            .map_err(|error| ChainError::Config(format!("{}: {error}", path.display())))?,
    )
}

fn jsonl(path: &Path) -> Result<Vec<Json>, ChainError> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| ChainError::Config(format!("{}: {error}", path.display())))?;
    text.lines()
        .filter(|line| !line.is_empty())
        .map(|line| Json::parse(line.as_bytes()))
        .collect()
}

/// Admitted D06 Aave deployment and reserves.
#[derive(Debug, Clone)]
pub struct D06Inputs {
    pub chain: ChainDomain,
    pub deployment: DeploymentKey,
    pub addresses_provider: Address,
    pub pool_implementation: Address,
    pub oracle: Address,
    pub reserves: Vec<AdmittedReserve>,
}

impl D06Inputs {
    pub fn read(
        current_surface: &Path,
        deployment_manifest: &Path,
        reserve_manifest: &Path,
        anchor: &AnchorPlan,
    ) -> Result<Self, ChainError> {
        let current = read_json(current_surface)?;
        require_schema(
            &current,
            "nqc-rmc-006-aave-current-surface-v1",
            "D06 current surface",
        )?;
        require_anchor(&current, anchor, "D06 current surface")?;
        if current.get("status").and_then(Json::as_str) != Some("CURRENT_SURFACE_PASS") {
            return Err(ChainError::Evidence(
                "D06 current surface did not pass".into(),
            ));
        }
        let chain = chain_domain(&current)?;
        let facts = required(&current, "facts")?;
        let deployments = jsonl(deployment_manifest)?;
        let [deployment_row] = deployments.as_slice() else {
            return Err(ChainError::Evidence(
                "D06 deployment manifest must hold exactly one deployment".into(),
            ));
        };
        let admission = required(deployment_row, "admission")?;
        require_schema(
            admission,
            "nqc-rmc-006-aave-deployment-admission-v1",
            "D06 admission",
        )?;
        if admission.str_field("status")? != "D05_ADMISSION_MATERIALIZED" {
            return Err(ChainError::Evidence(
                "D06 deployment is not admitted".into(),
            ));
        }
        let pool = Address::parse_hex(admission.str_field("pool")?)?;
        if Address::parse_hex(facts.str_field("pool")?)? != pool {
            return Err(ChainError::Evidence(
                "D06 surface and admission name different pools".into(),
            ));
        }
        let pool_implementation = Address::parse_hex(facts.str_field("pool_implementation")?)?;
        if Address::parse_hex(admission.str_field("implementation")?)? != pool_implementation {
            return Err(ChainError::Evidence(
                "D06 admitted implementation differs".into(),
            ));
        }
        let deployment = DeploymentKey::new(
            chain.clone(),
            ProtocolFamily::AaveV3,
            pool,
            hash(admission.str_field("deployment_instance")?)?,
        );
        let mut reserves = Vec::new();
        for row in jsonl(reserve_manifest)? {
            let reserve_id = match row.get("current_reserve_id") {
                Some(Json::Null) | None => None,
                Some(value) => Some(
                    value
                        .as_i64()
                        .and_then(|id| u16::try_from(id).ok())
                        .ok_or_else(|| ChainError::Evidence("reserve id is not uint16".into()))?,
                ),
            };
            let current = row.get("current").and_then(Json::as_bool).unwrap_or(false);
            if current != reserve_id.is_some() {
                return Err(ChainError::Evidence(
                    "D06 current flag and reserve id disagree".into(),
                ));
            }
            reserves.push(AdmittedReserve {
                asset: Address::parse_hex(row.str_field("asset")?)?,
                market_id: row.str_field("market_id")?.to_owned(),
                reserve_id,
            });
        }
        reserves.sort_by_key(|reserve| {
            (
                reserve.reserve_id.is_none(),
                reserve.reserve_id,
                reserve.asset,
            )
        });
        Ok(Self {
            chain,
            deployment,
            addresses_provider: Address::parse_hex(admission.str_field("addresses_provider")?)?,
            pool_implementation,
            oracle: Address::parse_hex(facts.str_field("price_oracle")?)?,
            reserves,
        })
    }

    pub fn plan(&self, anchor: AnchorPlan) -> AavePlan {
        AavePlan {
            anchor,
            pool: self.deployment.address(),
            pool_implementation: self.pool_implementation,
            addresses_provider: self.addresses_provider,
            oracle: self.oracle,
            reserves: self
                .reserves
                .iter()
                .filter_map(|reserve| {
                    reserve.reserve_id.map(|reserve_id| AaveReserveInput {
                        asset: reserve.asset,
                        reserve_id,
                    })
                })
                .collect(),
        }
    }
}

/// Admitted D07 Uniswap V2 deployment and pairs.
#[derive(Debug, Clone)]
pub struct D07Inputs {
    pub chain: ChainDomain,
    pub deployment: DeploymentKey,
    pub factory_runtime_sha256: String,
    pub pairs: Vec<PairInput>,
}

impl D07Inputs {
    pub fn read(
        current_surface: &Path,
        admission: &Path,
        pair_manifest: &Path,
        anchor: &AnchorPlan,
    ) -> Result<Self, ChainError> {
        let current = read_json(current_surface)?;
        require_schema(
            &current,
            "nqc-rmc-007-v2-current-surface-v1",
            "D07 current surface",
        )?;
        require_anchor(&current, anchor, "D07 current surface")?;
        let chain = chain_domain(&current)?;
        let facts = required(&current, "facts")?;
        let factory = Address::parse_hex(facts.str_field("factory")?)?;
        let admission = read_json(admission)?;
        require_schema(
            &admission,
            "nqc-rmc-007-v2-deployment-admission-v1",
            "D07 admission",
        )?;
        if admission.str_field("status")? != "D05_ADMISSION_MATERIALIZED" {
            return Err(ChainError::Evidence("D07 factory is not admitted".into()));
        }
        if Address::parse_hex(admission.str_field("factory")?)? != factory {
            return Err(ChainError::Evidence(
                "D07 surface and admission name different factories".into(),
            ));
        }
        let factory_runtime_sha256 = facts
            .str_field("factory_runtime_sha256")?
            .trim_start_matches("0x")
            .to_owned();
        if admission
            .str_field("factory_code_hash")?
            .trim_start_matches("0x")
            != factory_runtime_sha256
        {
            return Err(ChainError::Evidence(
                "D07 admitted factory code differs".into(),
            ));
        }
        Ok(Self {
            deployment: DeploymentKey::new(
                chain.clone(),
                ProtocolFamily::UniswapV2,
                factory,
                hash(admission.str_field("deployment_instance")?)?,
            ),
            chain,
            factory_runtime_sha256,
            pairs: read_pair_manifest(pair_manifest)?,
        })
    }

    pub fn plan(&self, anchor: AnchorPlan, job_size: usize) -> V2Plan {
        V2Plan {
            anchor,
            factory: self.deployment.address(),
            job_size,
        }
    }
}
