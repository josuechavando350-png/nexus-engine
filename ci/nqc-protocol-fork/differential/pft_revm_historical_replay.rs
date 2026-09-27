use alloy::{
    eips::BlockId,
    primitives::{keccak256, Address, B256, Bytes, Log, U256},
};
use nqc_state::{RethIpcConfig, RethIpcSource};
use revm::{
    bytecode::Bytecode,
    context::TxEnv,
    database::{AlloyDB, AsyncDb, CacheDB},
    primitives::{
        eip4844::BLOB_BASE_FEE_UPDATE_FRACTION_PRAGUE,
        hardfork::SpecId,
        TxKind,
    },
    state::AccountInfo,
    Context, ExecuteCommitEvm, ExecuteEvm, MainBuilder, MainContext,
};
use serde_json::{json, Value};
use std::{env, fs, path::Path, str::FromStr};

type Error = Box<dyn std::error::Error>;

const ANCHOR_NUMBER: u64 = 25_252_136;
const ANCHOR_HASH: &str =
    "0x49edc621ec5fe843353be319ae1a307be4e37d2a51111ccc07a2c8aae3ff6470";

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a Value, Error> {
    value
        .get(key)
        .ok_or_else(|| format!("missing JSON field: {key}").into())
}

fn text_field<'a>(value: &'a Value, key: &str) -> Result<&'a str, Error> {
    field(value, key)?
        .as_str()
        .ok_or_else(|| format!("JSON field is not text: {key}").into())
}

fn u64_field(value: &Value, key: &str) -> Result<u64, Error> {
    field(value, key)?
        .as_u64()
        .ok_or_else(|| format!("JSON field is not u64: {key}").into())
}

fn u256_value(value: &Value) -> Result<U256, Error> {
    match value {
        Value::String(text) => U256::from_str(text).map_err(Into::into),
        Value::Number(number) => number
            .as_u64()
            .map(U256::from)
            .ok_or_else(|| "JSON U256 number is not an exact u64; encode it as a decimal string".into()),
        _ => Err("JSON U256 value must be a decimal string or exact u64 number".into()),
    }
}

fn u256_field(value: &Value, key: &str) -> Result<U256, Error> {
    u256_value(field(value, key)?)
}

fn address(value: &str) -> Result<Address, Error> {
    Ok(Address::from_str(value)?)
}

fn b256(value: &str) -> Result<B256, Error> {
    Ok(B256::from_str(value)?)
}

fn bytes(value: &str) -> Result<Bytes, Error> {
    let raw = value
        .strip_prefix("0x")
        .ok_or_else(|| "hex bytes missing 0x prefix".to_string())?;
    Ok(Bytes::from(hex::decode(raw)?))
}

fn logs_digest(logs: &[Log]) -> B256 {
    let mut payload = Vec::new();
    payload.extend_from_slice(b"NQC_PFT_LOGS_V1");
    for log in logs {
        payload.extend_from_slice(log.address.as_slice());
        let topics = log.data.topics();
        payload.extend_from_slice(&(topics.len() as u32).to_be_bytes());
        for topic in topics {
            payload.extend_from_slice(topic.as_slice());
        }
        let data = log.data.data.as_ref();
        payload.extend_from_slice(&(data.len() as u64).to_be_bytes());
        payload.extend_from_slice(data);
    }
    keccak256(payload)
}

fn assert_reference_tx(
    reference: &Value,
    index: usize,
    success: bool,
    gas_used: u64,
    digest: B256,
    output: &Bytes,
) -> Result<String, Error> {
    let transactions = field(reference, "transactions")?
        .as_array()
        .ok_or_else(|| "transactions must be an array".to_string())?;
    let expected = transactions
        .get(index)
        .ok_or_else(|| format!("missing reference transaction {index}"))?;
    let name = text_field(expected, "name")?.to_string();
    let expected_status = u64_field(expected, "status")?;
    let actual_status = if success { 1u64 } else { 0u64 };
    if actual_status != expected_status {
        return Err(format!(
            "status mismatch {name}: reference={expected_status} revm={actual_status}"
        )
        .into());
    }
    let expected_gas = u64_field(expected, "gas_used")?;
    if gas_used != expected_gas {
        return Err(format!(
            "gas mismatch {name}: reference={expected_gas} revm={gas_used}"
        )
        .into());
    }
    let expected_digest = b256(text_field(expected, "ordered_logs_digest")?)?;
    if digest != expected_digest {
        return Err(format!(
            "ordered log mismatch {name}: reference={expected_digest} revm={digest}"
        )
        .into());
    }
    let expected_output = bytes(text_field(expected, "execution_output")?)?;
    if output != &expected_output {
        return Err(format!(
            "execution output mismatch {name}: reference=0x{} revm=0x{}",
            hex::encode(expected_output),
            hex::encode(output)
        )
        .into());
    }
    println!(
        "REVM_TX_PARITY_PASS name={} status={} gas_used={} logs_digest={} output_digest={}",
        name, actual_status, gas_used, digest, keccak256(output)
    );
    Ok(name)
}

fn tx_env(
    caller: Address,
    spec: &Value,
    chain_id: u64,
) -> Result<TxEnv, Error> {
    let nonce = u64_field(spec, "nonce")?;
    let gas_limit = u64_field(spec, "gas_limit")?;
    let gas_price_u256 = u256_field(spec, "gas_price")?;
    let gas_price: u128 = gas_price_u256
        .try_into()
        .map_err(|_| "gas_price does not fit u128")?;
    let value = u256_field(spec, "value")?;
    let to = address(text_field(spec, "to")?)?;
    let data = bytes(text_field(spec, "data")?)?;

    TxEnv::builder()
        .caller(caller)
        .gas_limit(gas_limit)
        .gas_price(gas_price)
        .gas_priority_fee(None)
        .value(value)
        .data(data)
        .chain_id(Some(chain_id))
        .nonce(nonce)
        .kind(TxKind::Call(to))
        .build()
        .map_err(|error| format!("invalid differential tx env: {error}").into())
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        return Err("usage: pft_revm_historical_replay <reference.json> <runtime.hex> <output.json>".into());
    }
    let reference_path = Path::new(&args[1]);
    let runtime_path = Path::new(&args[2]);
    let output_path = Path::new(&args[3]);
    let reference: Value = serde_json::from_slice(&fs::read(reference_path)?)?;
    let provider_id = env::var("NQC_PFT_UPSTREAM_ID")?;
    if text_field(&reference, "provider_id")? != provider_id {
        return Err(format!(
            "reference provider mismatch: reference={} runtime={provider_id}",
            text_field(&reference, "provider_id")?
        )
        .into());
    }

    let classification = text_field(&reference, "classification")?;
    if classification != "SYNTHETIC_TRANSACTIONS_OVER_IMMUTABLE_HISTORICAL_MAINNET_STATE" {
        return Err(format!("unexpected reference classification: {classification}").into());
    }
    let anchor_json = field(&reference, "anchor")?;
    if u64_field(anchor_json, "number")? != ANCHOR_NUMBER
        || text_field(anchor_json, "hash")?.to_lowercase() != ANCHOR_HASH
    {
        return Err("reference historical anchor mismatch".into());
    }

    let chain_id = 1u64;
    let source = RethIpcSource::connect(&RethIpcConfig::new(
        env::var("NQC_PFT_IPC_PATH")?,
    ))
    .await?;
    let anchor = source.canonical_block_at(ANCHOR_NUMBER).await?;
    if anchor.hash != b256(ANCHOR_HASH)? {
        return Err(format!("provider anchor mismatch: {}", anchor.hash).into());
    }
    source.ensure_canonical(anchor).await?;

    let provider = source.provider();
    let remote = AlloyDB::new(provider, BlockId::hash_canonical(anchor.hash));
    let async_db = AsyncDb::new(remote);
    let mut cache_db = CacheDB::new(async_db);

    let caller = address(text_field(&reference, "caller")?)?;
    let caller_balance = u256_field(&reference, "caller_initial_balance")?;
    cache_db.insert_account_info(
        caller,
        AccountInfo::default()
            .with_balance(caller_balance)
            .with_nonce(0),
    );

    let helper = address(text_field(&reference, "helper")?)?;
    let runtime_text = fs::read_to_string(runtime_path)?;
    let runtime = bytes(runtime_text.trim())?;
    let reference_runtime = bytes(text_field(&reference, "helper_runtime")?)?;
    if runtime != reference_runtime {
        return Err("injected helper runtime differs from reference runtime".into());
    }
    let bytecode = Bytecode::new_raw_checked(runtime)
        .map_err(|error| format!("invalid injected helper runtime: {error}"))?;
    cache_db.insert_account_info(
        helper,
        AccountInfo::default()
            .with_balance(U256::ZERO)
            .with_nonce(0)
            .with_code(bytecode),
    );

    let block = field(&reference, "execution_block")?;
    let number = u64_field(block, "number")?;
    if number != ANCHOR_NUMBER + 1 {
        return Err(format!("execution block is not adjacent: {number}").into());
    }
    let timestamp = u64_field(block, "timestamp")?;
    let beneficiary = address(text_field(block, "beneficiary")?)?;
    let gas_limit = u64_field(block, "gas_limit")?;
    let base_fee_per_gas = u64_field(block, "base_fee_per_gas")?;
    let difficulty = u256_field(block, "difficulty")?;
    let prevrandao = match field(block, "prevrandao")? {
        Value::Null => None,
        Value::String(value) => Some(b256(value)?),
        _ => return Err("execution prevrandao has invalid shape".into()),
    };
    let excess_blob_gas = match field(block, "excess_blob_gas")? {
        Value::Null => None,
        value => Some(
            value
                .as_u64()
                .ok_or_else(|| "excess_blob_gas is not u64".to_string())?,
        ),
    };

    // Block 25,252,137 is after the Osaka mainnet activation at 23,935,694.
    let spec_id = SpecId::OSAKA;
    let ctx = Context::mainnet()
        .with_db(cache_db)
        .modify_block_chained(|env| {
            env.number = U256::from(number);
            env.beneficiary = beneficiary;
            env.timestamp = U256::from(timestamp);
            env.difficulty = difficulty;
            env.gas_limit = gas_limit;
            env.basefee = base_fee_per_gas;
            env.prevrandao = prevrandao;
            if let Some(excess) = excess_blob_gas {
                env.set_blob_excess_gas_and_price(
                    excess,
                    BLOB_BASE_FEE_UPDATE_FRACTION_PRAGUE,
                );
            }
        })
        .modify_cfg_chained(|cfg| {
            cfg.chain_id = chain_id;
            cfg.set_spec_and_mainnet_gas_params(spec_id);
        });
    let mut evm = ctx.build_mainnet();

    let specs = field(&reference, "transaction_specs")?
        .as_array()
        .ok_or_else(|| "transaction_specs must be an array".to_string())?;
    if specs.len() != 5 {
        return Err(format!("expected 5 transaction specs, got {}", specs.len()).into());
    }

    let mut report_txs = Vec::new();
    for (index, spec) in specs.iter().enumerate() {
        let tx = tx_env(caller, spec, chain_id)?;
        let result = evm
            .transact_commit(tx)
            .map_err(|error| format!("REVM transaction {index} failed validation: {error}"))?;
        let success = result.is_success();
        let gas_used = result.tx_gas_used();
        let digest = logs_digest(result.logs());
        let output = result.output().cloned().unwrap_or_default();
        let name = assert_reference_tx(&reference, index, success, gas_used, digest, &output)?;
        let spec_name = text_field(spec, "name")?;
        if name != spec_name {
            return Err(format!(
                "transaction order/name mismatch at {index}: spec={spec_name} reference={name}"
            )
            .into());
        }
        report_txs.push(json!({
            "name": name,
            "status": if success { 1u64 } else { 0u64 },
            "gas_used": gas_used,
            "ordered_logs_digest": format!("{digest:#x}"),
            "execution_output": format!("0x{}", hex::encode(&output)),
        }));
    }

    let final_state = field(&reference, "final_state")?;
    let probe_to = helper;
    let probe_data = bytes(text_field(final_state, "probe_calldata")?)?;
    let probe_nonce = 5u64;
    let probe_gas_price_u256 = u256_field(&reference, "gas_price")?;
    let probe_gas_price: u128 = probe_gas_price_u256
        .try_into()
        .map_err(|_| "probe gas price does not fit u128")?;
    let probe_gas_limit = u64_field(&reference, "gas_limit_per_tx")?;
    let probe_tx = TxEnv::builder()
        .caller(caller)
        .gas_limit(probe_gas_limit)
        .gas_price(probe_gas_price)
        .gas_priority_fee(None)
        .value(U256::ZERO)
        .data(probe_data)
        .chain_id(Some(chain_id))
        .nonce(probe_nonce)
        .kind(TxKind::Call(probe_to))
        .build()
        .map_err(|error| format!("invalid final state probe env: {error}"))?;
    let probe_result = evm
        .transact_one(probe_tx)
        .map_err(|error| format!("REVM final probe failed: {error}"))?;
    if !probe_result.is_success() {
        return Err("REVM final state probe reverted".into());
    }
    let probe_output = probe_result
        .output()
        .cloned()
        .ok_or_else(|| "REVM final probe has no output".to_string())?;
    let expected_probe = bytes(text_field(final_state, "probe_output")?)?;
    if probe_output != expected_probe {
        return Err(format!(
            "final state mismatch: reference=0x{} revm=0x{}",
            hex::encode(expected_probe),
            hex::encode(&probe_output)
        )
        .into());
    }

    source.ensure_canonical(anchor).await?;
    let report = json!({
        "schema_version": 1,
        "gate": "REVM_HISTORICAL_FORK_DIFFERENTIAL",
        "classification": "REVM_VS_ANVIL_SYNTHETIC_TRANSACTIONS_OVER_IMMUTABLE_HISTORICAL_MAINNET_STATE",
        "provider_id": provider_id,
        "anchor": {
            "number": anchor.number,
            "hash": format!("{:#x}", anchor.hash),
        },
        "spec_id": "OSAKA",
        "transactions": report_txs,
        "final_probe_output": format!("0x{}", hex::encode(probe_output)),
        "unexplained_mismatches": 0,
        "real_market_evidence": false,
        "protocol_fork_truth": "NOT_CLOSED",
    });
    fs::write(output_path, serde_json::to_vec_pretty(&report)?)?;
    println!(
        "REVM_HISTORICAL_FORK_DIFFERENTIAL_PASS upstream={} txs=5 unexplained_mismatches=0",
        env::var("NQC_PFT_UPSTREAM_ID")?
    );
    Ok(())
}
