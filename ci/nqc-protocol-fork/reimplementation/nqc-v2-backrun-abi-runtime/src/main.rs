use alloy::{
    primitives::{keccak256, Address, B256, Bytes, U256},
    sol,
    sol_types::{SolCall, SolValue},
};
use serde_json::{json, Value};
use std::{env, fs, process};

sol! {
    struct HopWitnessAbi {
        address pair;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOut;
        uint112 reserve0;
        uint112 reserve1;
    }

    struct ExecutionPlanAbi {
        uint256 chainId;
        uint256 targetBlock;
        bytes32 parentHash;
        address flashAsset;
        uint256 flashAmount;
        uint256 minProfit;
        bytes32 targetProvenance;
        bytes32 candidateProvenance;
        HopWitnessAbi[] hops;
    }

    interface INqcV2BackrunExecutor {
        function execute(ExecutionPlanAbi plan) external returns (uint256 realizedProfit);
    }
}

const TARGET_PROVENANCE: &str =
    "0x2222222222222222222222222222222222222222222222222222222222222222";
const CANDIDATE_PROVENANCE: &str =
    "0x3333333333333333333333333333333333333333333333333333333333333333";
const EVENT_SIGNATURE: &str =
    "BackrunExecuted(bytes32,bytes32,bytes32,uint256,bytes32,address,uint256,uint256,uint256)";

fn fail(message: impl AsRef<str>) -> ! {
    eprintln!("{}", message.as_ref());
    process::exit(1);
}

fn required(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| fail(format!("missing env {name}")))
}

fn parse_address(name: &str) -> Address {
    required(name)
        .parse::<Address>()
        .unwrap_or_else(|error| fail(format!("{name}: {error}")))
}

fn parse_b256_value(value: &str, label: &str) -> B256 {
    value
        .parse::<B256>()
        .unwrap_or_else(|error| fail(format!("{label}: {error}")))
}

fn parse_b256_env(name: &str) -> B256 {
    parse_b256_value(&required(name), name)
}

fn parse_u64_env(name: &str) -> u64 {
    required(name)
        .parse::<u64>()
        .unwrap_or_else(|error| fail(format!("{name}: {error}")))
}

fn strip_0x(value: &str) -> &str {
    value.strip_prefix("0x").unwrap_or(value)
}

fn parse_hex(value: &str, label: &str) -> Vec<u8> {
    hex::decode(strip_0x(value))
        .unwrap_or_else(|error| fail(format!("{label}: invalid hex: {error}")))
}

fn plan() -> ExecutionPlanAbi {
    let token_a = parse_address("TOKEN_A");
    let token_b = parse_address("TOKEN_B");
    let pair0 = parse_address("PAIR0");
    let pair1 = parse_address("PAIR1");

    let hops = vec![
        HopWitnessAbi {
            pair: pair0,
            tokenIn: token_a,
            tokenOut: token_b,
            amountIn: U256::from(100_000u64),
            amountOut: U256::from(180_000u64),
            reserve0: 1_000_000u64.into(),
            reserve1: 2_000_000u64.into(),
        },
        HopWitnessAbi {
            pair: pair1,
            tokenIn: token_b,
            tokenOut: token_a,
            amountIn: U256::from(180_000u64),
            amountOut: U256::from(101_000u64),
            reserve0: 3_000_000u64.into(),
            reserve1: 4_000_000u64.into(),
        },
    ];

    ExecutionPlanAbi {
        chainId: U256::from(parse_u64_env("CHAIN_ID")),
        targetBlock: U256::from(parse_u64_env("TARGET_BLOCK")),
        parentHash: parse_b256_env("PARENT_HASH"),
        flashAsset: token_a,
        flashAmount: U256::from(100_000u64),
        minProfit: U256::from(100u64),
        targetProvenance: parse_b256_value(TARGET_PROVENANCE, "target provenance"),
        candidateProvenance: parse_b256_value(CANDIDATE_PROVENANCE, "candidate provenance"),
        hops,
    }
}

fn encode() {
    let p = plan();
    let plan_hash = keccak256(p.abi_encode());
    let calldata = INqcV2BackrunExecutor::executeCall { plan: p }.abi_encode();
    println!(
        "{}",
        json!({
            "calldata": format!("0x{}", hex::encode(calldata)),
            "plan_hash": format!("{plan_hash:#x}"),
            "target_provenance": TARGET_PROVENANCE,
            "candidate_provenance": CANDIDATE_PROVENANCE,
        })
    );
}

fn decode_return(value: &str) {
    let bytes = parse_hex(value, "return");
    if bytes.len() != 32 {
        fail(format!("return length {} != 32", bytes.len()));
    }
    let realized = U256::from_be_slice(&bytes);
    if realized != U256::from(900u64) {
        fail(format!("realized profit {realized} != 900"));
    }
    println!("{}", json!({"realized_profit": realized.to_string(), "status":"PASS"}));
}

fn word(data: &[u8], index: usize) -> &[u8] {
    let start = index * 32;
    let end = start + 32;
    if end > data.len() {
        fail("event data shorter than expected");
    }
    &data[start..end]
}

fn b256_word(data: &[u8], index: usize) -> B256 {
    B256::from_slice(word(data, index))
}

fn u256_word(data: &[u8], index: usize) -> U256 {
    U256::from_be_slice(word(data, index))
}

fn address_word(data: &[u8], index: usize) -> Address {
    let w = word(data, index);
    Address::from_slice(&w[12..32])
}

fn decode_event(path: &str) {
    let raw = fs::read_to_string(path).unwrap_or_else(|error| fail(format!("{path}: {error}")));
    let value: Value = serde_json::from_str(&raw)
        .unwrap_or_else(|error| fail(format!("{path}: invalid json: {error}")));

    let topics = value["topics"]
        .as_array()
        .unwrap_or_else(|| fail("event topics missing"));
    if topics.len() != 4 {
        fail(format!("topic count {} != 4", topics.len()));
    }

    let expected_topic0 = keccak256(EVENT_SIGNATURE.as_bytes());
    let topic0 = parse_b256_value(
        topics[0].as_str().unwrap_or_else(|| fail("topic0 not string")),
        "topic0",
    );
    if topic0 != expected_topic0 {
        fail(format!("event signature mismatch: {topic0:#x} != {expected_topic0:#x}"));
    }

    let indexed_plan_hash = parse_b256_value(
        topics[1].as_str().unwrap_or_else(|| fail("topic1 not string")),
        "plan hash topic",
    );
    let indexed_target = parse_b256_value(
        topics[2].as_str().unwrap_or_else(|| fail("topic2 not string")),
        "target provenance topic",
    );
    let indexed_candidate = parse_b256_value(
        topics[3].as_str().unwrap_or_else(|| fail("topic3 not string")),
        "candidate provenance topic",
    );

    let expected_plan_hash = parse_b256_env("EXPECTED_PLAN_HASH");
    if indexed_plan_hash != expected_plan_hash {
        fail(format!(
            "plan hash topic mismatch: {indexed_plan_hash:#x} != {expected_plan_hash:#x}"
        ));
    }
    if indexed_target != parse_b256_value(TARGET_PROVENANCE, "target provenance") {
        fail("target provenance topic mismatch");
    }
    if indexed_candidate != parse_b256_value(CANDIDATE_PROVENANCE, "candidate provenance") {
        fail("candidate provenance topic mismatch");
    }

    let data_hex = value["data"]
        .as_str()
        .unwrap_or_else(|| fail("event data missing"));
    let data = parse_hex(data_hex, "event data");
    if data.len() != 32 * 6 {
        fail(format!("event data length {} != 192", data.len()));
    }

    let target_block = u256_word(&data, 0);
    let parent_hash = b256_word(&data, 1);
    let flash_asset = address_word(&data, 2);
    let flash_amount = u256_word(&data, 3);
    let premium = u256_word(&data, 4);
    let realized_profit = u256_word(&data, 5);

    if target_block != U256::from(parse_u64_env("TARGET_BLOCK")) {
        fail(format!("target block mismatch: {target_block}"));
    }
    if parent_hash != parse_b256_env("PARENT_HASH") {
        fail(format!("parent hash mismatch: {parent_hash:#x}"));
    }
    if flash_asset != parse_address("TOKEN_A") {
        fail(format!("flash asset mismatch: {flash_asset}"));
    }
    if flash_amount != U256::from(100_000u64) {
        fail(format!("flash amount mismatch: {flash_amount}"));
    }
    if premium != U256::from(100u64) {
        fail(format!("premium mismatch: {premium}"));
    }
    if realized_profit != U256::from(900u64) {
        fail(format!("event realized profit mismatch: {realized_profit}"));
    }

    println!(
        "{}",
        json!({
            "plan_hash": format!("{indexed_plan_hash:#x}"),
            "target_block": target_block.to_string(),
            "parent_hash": format!("{parent_hash:#x}"),
            "flash_asset": format!("{flash_asset:#x}"),
            "flash_amount": flash_amount.to_string(),
            "premium": premium.to_string(),
            "realized_profit": realized_profit.to_string(),
            "status": "PASS"
        })
    );
}

fn main() {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("encode") => encode(),
        Some("decode-return") => {
            let value = args.next().unwrap_or_else(|| fail("decode-return requires hex"));
            decode_return(&value);
        }
        Some("decode-event") => {
            let path = args.next().unwrap_or_else(|| fail("decode-event requires json path"));
            decode_event(&path);
        }
        other => fail(format!("unknown command: {other:?}")),
    }
}
