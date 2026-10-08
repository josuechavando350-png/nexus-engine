#!/usr/bin/env python3
"""Bind original top-three WETH borrower previous HF to authentic block timestamps.

Emits only a read-only fork input bundle. Passing this producer alone does not
simulate liquidation, capture, inclusion, flash/gas credit, or profit.
"""
from __future__ import annotations

import argparse, hashlib, json, re, zipfile
from pathlib import Path
from rmc016_probe_historical_rpc import PROVIDERS, rpc
from rmc016_top3_preblock_health import RANKED, WAD, canonical, digest, require
from rmc016_rank1_prestate_probe import checked_block

SOURCE_ARTIFACT_SHA = "069652fdb01f6921979edad188634a2fd6d72860163cbf6b3d47fab5fabe6fd6"
EXPECTED_HEALTH_FACTORS = (
    "1000000001993818630",
    "1000701093031081909",
    "1000489719586999148",
)
WANTED = {"top3-preblock-hf.json","source-sha256.txt","archive.sha256"}
HEX40 = re.compile(r"0x[0-9a-f]{40}\Z")


def read_source(path):
    raw=path.read_bytes()
    require(len(raw)<100000 and digest(raw)==SOURCE_ARTIFACT_SHA,
            "original top3 health authority ZIP SHA256 changed")
    with zipfile.ZipFile(path) as z:
        info=z.infolist()
        names=[x.filename for x in info]
        require(len(set(names))==len(names) and set(names)==WANTED,
                "source ZIP members missing/duplicated")
        require(all(x.filename==Path(x.filename).name and x.file_size<50000 and
                    (x.external_attr>>16)&0o170000!=0o120000 for x in info),
                "unsafe upstream evidence ZIP members")
        files={n:z.read(n) for n in names}
    checked=set()
    for line in files["archive.sha256"].decode("ascii").splitlines():
        require(re.fullmatch(r"[0-9a-f]{64}  [a-zA-Z0-9._-]+",line) is not None,
                "invalid original top3 inner SHA line")
        dg,name=line.split("  ")
        require(name in WANTED-{"archive.sha256"} and name not in checked,
                "missing/duplicated inner source member")
        require(dg==digest(files[name]),"upstream inner member changed")
        checked.add(name)
    require(checked==WANTED-{"archive.sha256"},"source ZIP manifest missing members")
    report=json.loads(files["top3-preblock-hf.json"])
    commitment=report.pop("report_sha256",None)
    require(type(commitment) is str and commitment==digest(canonical(report)),
            "upstream source report commitment mismatch")
    report["report_sha256"]=commitment
    require(report.get("status")=="RMC016_TOP3_HISTORICAL_WETH_PREBLOCK_HEALTH_TRUTH_ONLY"
            and report.get("observed_historical_top_three_count")==3
            and report.get("observed_predecessor_below_one_count")==0
            and report.get("observed_predecessor_not_below_one_count")==3
            and report.get("independent_two_provider_parity") is True
            and report.get("source_selection_uses_future_winner_knowledge") is True
            and report.get("evidence_of_ex_ante_discovery_or_strategy_capture") is False
            and report.get("replayed_real_liquidation_in_preblock") is False
            and report.get("flash_principal_and_gas_externally_financed") is False
            and report.get("real_market_census_closed") is False,
            "original previous-block health truth missing mandatory negative claims")
    records=report.get("three_source_rows")
    quorum=report.get("provider_records")
    require(type(records) is list and len(records)==3
            and type(quorum) is list and len(quorum)==2
            and [x.get("provider_id") for x in quorum]==["drpc","blast"]
            and quorum[0].get("rows")==quorum[1].get("rows"),
            "previous source independent provider quorum invalid")
    for i,(tx,block,_,_) in enumerate(RANKED):
        row=records[i]
        full=quorum[0]["rows"][i]
        require(row.get("rank")==i+1
                and row.get("historical_competitor_tx")==tx
                and row.get("previous_block_number")==block-1
                and row.get("health_factor_wad")==EXPECTED_HEALTH_FACTORS[i]
                and row.get("below_one_at_previous_block") is False
                and full.get("winner_transaction_hash")==tx
                and full.get("winner_block_number")==block
                and full.get("predecessor_block",{}).get("hash")==row["previous_block_hash"]
                and full.get("predecessor_block",{}).get("state_root")==row["previous_block_state_root"]
                and full.get("account_data",{}).get("health_factor_wad")==EXPECTED_HEALTH_FACTORS[i]
                and type(full.get("borrower")) is str and HEX40.fullmatch(full["borrower"]),
                "source rank/HF/borrower/previous state identity drift")
    return report


def one_operator(provider,report,call=rpc):
    pid,operator,url=provider
    require(call(url,"eth_chainId",[])=="0x1","wrong historic Ethereum chain")
    samples=[]
    for i,(tx,block,_,_) in enumerate(RANKED):
        source=report["provider_records"][0]["rows"][i]
        pre=source["predecessor_block"]
        h0=call(url,"eth_getBlockByNumber",[hex(block-1),False])
        h1=call(url,"eth_getBlockByNumber",[hex(block),False])
        earlier=checked_block(h0,block-1)
        winner=checked_block(h1,block)
        require(earlier["hash"]==pre["hash"] and
                earlier["state_root"]==pre["state_root"] and
                winner["hash"]==source["winner_block_hash"] and
                winner["parent_hash"]==earlier["hash"],
                "ranked winner/preceding canonical state identity disagreement")
        raw_t0=h0.get("timestamp")
        raw_t1=h1.get("timestamp")
        require(type(raw_t0) is str and type(raw_t1) is str and
                re.fullmatch(r"0x(?:0|[1-9a-f][0-9a-f]*)",raw_t0) is not None and
                re.fullmatch(r"0x(?:0|[1-9a-f][0-9a-f]*)",raw_t1) is not None,
                "invalid authenticated historical block timestamps")
        t0=int(raw_t0,16);t1=int(raw_t1,16)
        require(0<t0<t1 and t1-t0<=120,"historical timestamp ordering/interval implausible")
        samples.append({
            "rank":i+1,
            "historical_winner_tx":tx,
            "borrower":source["borrower"],
            "source_borrower_identity_sha256":source["source_borrower_identity_sha256"],
            "previous_block_number":block-1,
            "previous_block_hash":earlier["hash"],
            "previous_block_timestamp":t0,
            "winning_block_number":block,
            "winning_block_hash":winner["hash"],
            "winning_block_timestamp":t1,
            "previous_health_factor_wad":EXPECTED_HEALTH_FACTORS[i],
        })
    return {"provider_id":pid,"operator":operator,"time_records":samples}


def assess(report,*,call=rpc,providers=None):
    providers=providers or [x for x in PROVIDERS if x[0] in ("drpc","blast")]
    require(len(providers)==2 and [x[0] for x in providers]==["drpc","blast"]
            and providers[0][1]!=providers[1][1],"exact two independent RPC operators required")
    samples=[one_operator(p,report,call=call) for p in providers]
    require(samples[0]["time_records"]==samples[1]["time_records"],
            "two independent historical block timestamp operators disagree")
    out={
        "schema_version":1,
        "status":"RMC015_REAL_TOP3_WETH_PREBLOCK_AND_WINNER_TIME_ANCHORS_PASS",
        "source_artifact_sha256":SOURCE_ARTIFACT_SHA,
        "source_report_sha256":report["report_sha256"],
        "historical_retroactively_selected_competitor_count":3,
        "source_all_three_previous_health_factors_above_one":True,
        "source_time_window_verified_for_all_three":True,
        "canonical_time_anchors":samples[0]["time_records"],
        "source_two_operator_time_consensus":True,
        "operator_progress":samples,
        "time_only_fork_execution_performed":False,
        "actual_intrablock_trigger_certified":False,
        "capturable_ex_ante_opportunity_proven":False,
        "actual_nexus_liquidation_or_positive_pnl_proven":False,
        "own_capital_zero_gas_sponsor_proven":False,
        "real_market_census_closed":False,
    }
    out["report_sha256"]=digest(canonical(out))
    return out


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--source-zip",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    require(not a.out.exists(),"append-only time-anchor evidence")
    source=read_source(a.source_zip)
    output=assess(source)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_bytes(canonical(output))
    print(output["status"],[(x["rank"],x["previous_block_timestamp"],
        x["winning_block_timestamp"]) for x in output["canonical_time_anchors"]],
        "future_winner_selection_not_a_signal")


if __name__=="__main__":
    main()
