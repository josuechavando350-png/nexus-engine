#!/usr/bin/env python3
"""Generate recovered/reimplemented V2 historical parity executable."""
import argparse
import json
from pathlib import Path

from reserve_balance_witness import digest

EXPECTED_SELECTORS = {
    "token0()": "0x0dfe1681",
    "token1()": "0xd21220a7",
    "getReserves()": "0x0902f1ac",
    "getPair(address,address)": "0xe6a43905",
    "getAmountsOut(uint256,address[])": "0xd06ca61f",
}


def q(value):
    return json.dumps(str(value))


def generate(w):
    unsigned = {k: v for k, v in w.items() if k != "attestation_sha256"}
    if digest(unsigned) != w["attestation_sha256"]:
        raise ValueError("V2 witness attestation mismatch")
    if w["selectors"] != EXPECTED_SELECTORS:
        raise ValueError("V2 selector lock mismatch")
    if w["providers"] != ["blastapi-public", "mevblocker-rpc"]:
        raise ValueError("V2 provider lock mismatch")
    if len(w["cases"]) != 2:
        raise ValueError("expected exactly two historical anchors")

    lines = [
        "use alloy::primitives::{keccak256, Address, B256, U256};",
        "use nqc_state::{RethIpcConfig, RethIpcSource};",
        "use nqc_v2_state_reimplementation::{V2CanonicalReader, V2FactorySpec};",
        "use std::{env, io, str::FromStr};",
        "type Error = Box<dyn std::error::Error>;",
        "fn addr(s: &str) -> Result<Address, Error> { Ok(Address::from_str(s)?) }",
        "fn uint(v: u128) -> U256 { U256::from(v) }",
        "#[tokio::main]",
        "async fn main() -> Result<(), Error> {",
        'let upstream = env::var("NQC_PFT_UPSTREAM_ID")?;',
        'let source = RethIpcSource::connect(&RethIpcConfig::new(env::var("NQC_PFT_IPC_PATH")?)).await?;',
        "let reader = V2CanonicalReader::from_reth(&source, 1).await?;",
    ]

    for signature, selector in EXPECTED_SELECTORS.items():
        b = ",".join(str(v) for v in bytes.fromhex(selector[2:]))
        lines.append(
            f'assert_eq!(&keccak256({q(signature)}.as_bytes()).as_slice()[..4], &[{b}]);'
        )

    lines += [
        "let mut state_checks = 0u64;",
        "let mut quote_checks = 0u64;",
    ]

    for case in w["cases"]:
        pairs = {p["pair"]: p for p in case["pairs"]}
        single = case["quotes"]["single_usdc_weth"]
        multi = case["quotes"]["multi_usdc_weth_dai"]
        factory = case["factory"]
        pair_addrs = list(pairs.keys())
        lines += [
            "{",
            f"let anchor = source.canonical_block_at({int(case['block_number'])}).await?;",
            f"assert_eq!(anchor.hash, B256::from_str({q(case['block_hash'])})?);",
            f"assert_eq!(anchor.timestamp, {int(case['timestamp'])});",
            f"let pair_addresses = vec![{','.join('addr('+q(p)+')?' for p in pair_addrs)}];",
            "let snapshot = reader.read_pairs_at(",
            f"    V2FactorySpec {{ factory: addr({q(factory)})?, fee_bps: {int(case['fee_bps'])}, max_pairs: {len(pair_addrs)} }},",
            "    &pair_addresses,",
            "    anchor,",
            ").await?;",
            "assert_eq!(snapshot.anchor, anchor);",
            f"assert_eq!(snapshot.pairs.len(), {len(pair_addrs)});",
        ]
        for p in case["pairs"]:
            lines += [
                "{",
                f"let expected_pair = addr({q(p['pair'])})?;",
                "let pair = snapshot.pairs.iter().find(|p| p.pair == expected_pair)",
                "    .ok_or_else(|| io::Error::other("missing V2 pair"))?;",
                f"assert_eq!(pair.token0, addr({q(p['token0'])})?);",
                f"assert_eq!(pair.token1, addr({q(p['token1'])})?);",
                f"assert_eq!(pair.reserve0, uint({int(p['reserve0'])}u128));",
                f"assert_eq!(pair.reserve1, uint({int(p['reserve1'])}u128));",
                f"assert_eq!(pair.block_timestamp_last, {int(p['block_timestamp_last'])});",
                "state_checks += 1;",
                "}",
            ]

        lines += [
            "let graph = snapshot.routable_graph()?;",
            f"let single = graph.best_exact_in_route(addr({q(single['path'][0])})?, addr({q(single['path'][-1])})?, uint({int(single['amount_in'])}u128), 1)?",
            "    .ok_or_else(|| io::Error::other("missing canonical single-hop route"))?;",
            "assert_eq!(single.hops.len(), 1);",
            f"assert_eq!(single.hops[0].pair, addr({q('0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc')})?);",
            f"assert_eq!(single.amount_out, uint({int(single['amounts'][-1])}u128));",
            "quote_checks += 1;",
            f"let multi = graph.best_exact_in_route(addr({q(multi['path'][0])})?, addr({q(multi['path'][-1])})?, uint({int(multi['amount_in'])}u128), 2)?",
            "    .ok_or_else(|| io::Error::other("missing canonical multi-hop route"))?;",
            "assert_eq!(multi.hops.len(), 2);",
            f"assert_eq!(multi.hops[0].pair, addr({q('0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc')})?);",
            f"assert_eq!(multi.hops[1].pair, addr({q('0xa478c2975ab1ea89e8196811f51a7b7ade33eb11')})?);",
            f"assert_eq!(multi.hops[0].amount_out, uint({int(multi['amounts'][1])}u128));",
            f"assert_eq!(multi.amount_out, uint({int(multi['amounts'][-1])}u128));",
            "quote_checks += 1;",
            "source.ensure_canonical(anchor).await?;",
            'println!("V2_HISTORICAL_PARITY_PASS upstream={} block={} pairs={} single_out={} multi_out={}", upstream, anchor.number, snapshot.pairs.len(), single.amount_out, multi.amount_out);',
            "}",
        ]

    lines += [
        "assert_eq!(state_checks, 4);",
        "assert_eq!(quote_checks, 4);",
        'println!("V2_HISTORICAL_TOTAL upstream={} state_checks={} quote_checks={}", upstream, state_checks, quote_checks);',
        "Ok(())",
        "}",
        "",
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("witness", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    data = json.loads(args.witness.read_text())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(generate(data))
