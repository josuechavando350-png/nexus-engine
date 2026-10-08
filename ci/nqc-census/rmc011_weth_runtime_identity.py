#!/usr/bin/env python3
"""Read-only two-operator historical Ethereum WETH code identity.

The fork test is a separate physical predicate. This witness alone cannot
upgrade D08 token compatibility, authorize gas/principal, or certify profit.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path
from rmc016_probe_historical_rpc import rpc, PROVIDERS

SOURCE_ZIP_SHA256 = "280228a3f5f1070fc1f5aa8f9ec7c35a52d86175f1fcd036e7f0bfcfb567ef83"
SOURCE_D08_SHA256 = "9431ea07144ae78e68e0ffcc7f650fa32068ee63fb53ca41ff8a062b87845913"
SOURCE_D12_SHA256 = "bbe6a6365d563eb41125d9fcdba79ac384c21182f31f6761897e0ce2ee8fa3b8"
WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
DECIMALS_SELECTOR = "0x313ce567"
TOTAL_SUPPLY_SELECTOR = "0x18160ddd"
BLOCKS = (
    (25938047, "0x42cf44b75185587327a1aa8fc859cc5f49a639e7256547511430d6068b6f09ab"),
    (26095351, "0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781"),
)
SOURCE_BLOCKERS = (
    "FEE_ON_TRANSFER_UNPROVEN",
    "REBASING_UNPROVEN",
    "TRANSFER_HOOKS_UNPROVEN",
    "UPGRADEABLE_UNPROVEN",
)
DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)\Z")
HASH = re.compile(r"0x[0-9a-f]{64}\Z")
DATA = re.compile(r"0x(?:[0-9a-f]{2})+\Z")
UINT = re.compile(r"0x[0-9a-fA-F]{64}\Z")


def need(ok, reason):
    if not ok:
        raise ValueError(reason)


def canonical(v):
    return (json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def unique_json(raw):
    def pairs_unique(pairs):
        d = {}
        for name, val in pairs:
            need(name not in d, "duplicate source JSON key")
            d[name] = val
        return d
    return json.loads(raw, object_pairs_hook=pairs_unique)


def source_weth_record(archive, expected_sha=SOURCE_ZIP_SHA256):
    raw = archive.read_bytes()
    need(len(raw)<150000 and sha(raw)==expected_sha, "RMC012 authenticated ZIP SHA256 differs")
    with zipfile.ZipFile(archive) as z:
        members=z.infolist()
        names=[m.filename for m in members]
        need(len(names)==2 and set(names)=={"execution-blocker-diagnostic.json","archive.sha256"},
             "D12 source archive has missing, duplicate or extra members")
        for member in members:
            need(member.filename==Path(member.filename).name and member.file_size<100000,
                 "unsafe source ZIP member")
        report_raw=z.read("execution-blocker-diagnostic.json")
        manifest=z.read("archive.sha256")
    need(manifest==(sha(report_raw)+"  execution-blocker-diagnostic.json\n").encode(),
         "source ZIP inner member SHA256 mismatch")
    doc=unique_json(report_raw)
    expect=doc.pop("report_sha256",None)
    need(expect is not None and expect==sha(canonical(doc)),
         "source negative evidence internal commitment mismatch")
    need(doc.get("status")=="RMC012_EXECUTION_BLOCKER_ROOT_CAUSE_DIAGNOSTIC_ONLY" and
         doc.get("source_archive_sha256",{}).get("RMC008")==SOURCE_D08_SHA256 and
         doc.get("source_archive_sha256",{}).get("RMC012")==SOURCE_D12_SHA256 and
         doc.get("d08_token_records")==514279 and
         doc.get("d12_principal_rejection_count")==432 and
         doc.get("d12_principal_capital_feasible")==0 and
         doc.get("required_underlying_source_status")=="ALL_BLOCKED_NOT_ADMITTED" and
         doc.get("d08_token_eligibility_modified") is False and
         doc.get("nexus_executable_trades_proven") is False and
         doc.get("real_market_census_closed") is False,
         "RMC012 source attempted to promote an unproven capital candidate")
    rows=[r for r in doc.get("top_debt_asset_tiers",[]) if r.get("token_address")==WETH]
    need(len(rows)==1, "source WETH Aave record absent or duplicated")
    row=rows[0]
    need(row.get("aave_reserve_source_execution_status")=="BLOCKED" and
         row.get("nqc_execution_eligible") is False and
         row.get("actionable_debt_candidate_count")==11 and
         row.get("actionable_collateral_candidate_count")==175 and
         tuple(row.get("aave_reserve_source_blocker_codes",[]))==SOURCE_BLOCKERS and
         row.get("distinct_additional_uniswap_v2_observation") is True,
         "original Aave WETH compatibility must remain blocked")
    return {
        "token":WETH,
        "aave_execution_eligibility":"BLOCKED",
        "source_compatibility_blockers":list(SOURCE_BLOCKERS),
        "d12_debt_candidates":11,
        "d12_collateral_candidates":175,
        "original_d08_artifact_sha256":SOURCE_D08_SHA256,
        "original_d12_artifact_sha256":SOURCE_D12_SHA256,
        "source_root_cause_artifact_sha256":SOURCE_ZIP_SHA256,
    }


def uint_word(x,label):
    need(type(x) is str and UINT.fullmatch(x) is not None, label+" returned no canonical uint256")
    return int(x,16)


def probe(source, call=rpc, providers=None):
    providers = providers or [p for p in PROVIDERS if p[0] in ("drpc","blast")]
    need(len(providers)==2 and
         [p[0] for p in providers]==["drpc","blast"] and
         providers[0][1]!=providers[1][1],
         "exact two different RPC operators required")
    ledger=[]
    for key,operator,url in providers:
        need(call(url,"eth_chainId",[])=="0x1", "historical RPC wrong chain")
        anchors=[]
        for number,expected_hash in BLOCKS:
            header=call(url,"eth_getBlockByNumber",[hex(number),False])
            need(type(header) is dict and header.get("number")==hex(number) and
                 header.get("hash")==expected_hash and
                 type(header.get("stateRoot")) is str and HASH.fullmatch(header["stateRoot"]) and
                 type(header.get("parentHash")) is str and HASH.fullmatch(header["parentHash"]),
                 "canonical historical block identity/state root mismatch")
            code=call(url,"eth_getCode",[WETH,hex(number)])
            need(type(code) is str and
                 DATA.fullmatch(code.lower()) is not None and len(code)>500,
                 "WETH runtime code missing or malformed at historical block")
            code_raw=bytes.fromhex(code[2:])
            decimals=uint_word(call(url,"eth_call",[{"to":WETH,"data":DECIMALS_SELECTOR},
                                                   hex(number)]),"WETH decimals")
            supply=uint_word(call(url,"eth_call",[{"to":WETH,"data":TOTAL_SUPPLY_SELECTOR},
                                                 hex(number)]),"WETH supply")
            need(decimals==18 and supply>0, "historical WETH ERC20 metadata/supply mismatch")
            anchors.append({
                "block_number":number, "block_hash":expected_hash,
                "parent_hash":header["parentHash"],"state_root":header["stateRoot"],
                "runtime_sha256":sha(code_raw),"runtime_byte_length":len(code_raw),
                "decimals":decimals,"total_supply_wei_observed":str(supply),
            })
        ledger.append({"provider_id":key,"operator":operator,"anchors":anchors})
    need(ledger[0]["anchors"]==ledger[1]["anchors"],
         "two independently operated RPCs disagree on code/header/metadata")
    need(len({r["runtime_sha256"] for r in ledger[0]["anchors"]})==1,
         "WETH runtime code changed between historical decision and D08 anchors")
    out={
        "schema_version":1,
        "status":"RMC011_WETH_TWO_PROVIDER_RUNTIME_IDENTITY_READ_ONLY_PASS",
        "claim_scope":"TWO_HISTORICAL_WETH_RUNTIME_CODE_READS_PLUS_SEPARATE_FORK_TEST_PENDING",
        "token":WETH,
        "source_d08_negative_weth_admission":source,
        "historical_anchor_evidence":ledger,
        "runtime_bytecode_identical_across_two_blocks_and_operators":True,
        "foundry_physical_transfer_witness_included":False,
        "nonzero_operator_funding_proven":False,
        "aave_flash_principal_available_to_nexus_proven":False,
        "native_gas_sponsor_authorized":False,
        "nqc_token_admission_modified":False,
        "nqc_aave_execution_eligibility_certified":False,
        "nqc_liquidation_executed":False,
        "nqc_positive_net_pnl_proven":False,
        "real_market_census_closed":False,
    }
    out["report_sha256"]=sha(canonical(out))
    return out


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--root-cause-zip",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    need(not a.out.exists(),"append-only source witness")
    original=source_weth_record(a.root_cause_zip)
    report=probe(original)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_bytes(canonical(report))
    print(report["status"], "WETH_code_sha256",
          report["historical_anchor_evidence"][0]["anchors"][0]["runtime_sha256"],
          "execution_eligibility_STILL_BLOCKED")


if __name__=="__main__":
    main()
