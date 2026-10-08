#!/usr/bin/env python3
"""Independently observe Aave health factor at preceding historical block.

The borrower is selected with hindsight from a future winner receipt. This
read-only HF state is not a discovered prior signal or NQC profit/capture proof.
"""
from __future__ import annotations
import argparse, hashlib, json, re, zipfile
from pathlib import Path
from rmc016_probe_historical_rpc import PROVIDERS, rpc
from rmc016_rank1_prestate_probe import TX,BLOCK,canonical,digest,require,HEX64
from rmc016_rank1_prestate_probe import WINNER_HASH

SOURCE_ZIP_SHA = "01778616235930c3ac02f0aa1f3d1e8a7e5185317022ecf74707a278bd9be964"
AAVE_POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
GET_ACCOUNT_DATA = "0xbf92857c"  # keccak256("getUserAccountData(address)")[:4]
WAD = 10**18
WORD6 = re.compile(r"0x[0-9a-fA-F]{384}\Z")
HEX40 = re.compile(r"0x[0-9a-f]{40}\Z")


def authentic_prestate_report(path):
    data=path.read_bytes()
    require(len(data)<40000 and digest(data)==SOURCE_ZIP_SHA,
            "upstream prestate ZIP source immutable SHA256 mismatch")
    with zipfile.ZipFile(path) as zipobj:
        info=zipobj.infolist()
        names=[x.filename for x in info]
        wanted={"archive.sha256","rank1-prestate-witness.json","producer-source.sha256"}
        require(len(names)==len(set(names)) and set(names)==wanted,
                "prestate ZIP unexpected or duplicate file")
        require(all(x.filename==Path(x.filename).name and
                    x.file_size<16000 and (x.external_attr>>16)&0o170000!=0o120000
                    for x in info),"unsafe prestate ZIP entries")
        blobs={n:zipobj.read(n) for n in names}
    seen=set()
    for line in blobs["archive.sha256"].decode("ascii").splitlines():
        require(re.fullmatch(r"[0-9a-f]{64}  [a-zA-Z0-9._-]+",line) is not None,
                "prestate inner archive SHA line invalid")
        h,name=line.split("  ")
        require(name in wanted-{"archive.sha256"} and name not in seen,
                "duplicate/missing prestate SHA record")
        require(h==digest(blobs[name]),"prestate ZIP member SHA changed")
        seen.add(name)
    require(seen==wanted-{"archive.sha256"},"incomplete prestate checksum manifest")
    report=json.loads(blobs["rank1-prestate-witness.json"])
    source_hash=report.pop("report_sha256",None)
    require(type(source_hash) is str and source_hash==digest(canonical(report)),
            "rank-one original report SHA mismatch")
    report["report_sha256"]=source_hash
    need_fields=(
        report.get("status")=="RMC016_RANK1_SOURCE_AUTHENTICATED_PREDECESSOR_STATE_WITNESS"
        and report.get("tx")==TX and report.get("winning_block_number")==BLOCK
        and report.get("winning_block_hash")==WINNER_HASH
        and report.get("previous_block",{}).get("number")==BLOCK-1
        and report.get("independent_operator_receipt_and_parent_hash_consensus") is True
        and report.get("source_selection_retrospective_from_future_winner_tx") is True
        and report.get("borrower_liquidatable_at_previous_block_proven") is False
        and report.get("nexus_realized_net_profit_proven") is False
        and report.get("real_market_census_closed") is False
    )
    require(need_fields,"upstream rank-one source scope falsely promoted")
    borrower=report.get("borrower_address_for_local_fork_only")
    require(type(borrower) is str and HEX40.fullmatch(borrower) is not None,
            "unbound borrower address")
    blockhash=report["previous_block"].get("hash")
    state_root=report["previous_block"].get("state_root")
    require(type(blockhash) is str and HEX64.fullmatch(blockhash) and
            type(state_root) is str and HEX64.fullmatch(state_root),
            "source preceding block not canonical")
    return report


def decode_user_account_data(answer):
    require(type(answer) is str and WORD6.fullmatch(answer) is not None,
            "Aave returned unexpected getUserAccountData ABI")
    words=[int(answer[2+64*i:2+64*(i+1)],16) for i in range(6)]
    collateral,debt,available,threshold,ltv,hf=words
    require(0<=threshold<=10000 and 0<=ltv<=10000,
            "Aave returned invalid bps parameter")
    require(debt>0 and collateral>=0,"observed borrower has no debt at previous block")
    return {
        "total_collateral_base":str(collateral),
        "total_debt_base":str(debt),
        "available_borrows_base":str(available),
        "current_liquidation_threshold_bps":threshold,
        "ltv_bps":ltv,
        "health_factor_wad":str(hf),
    }


def observe_one(provider,source,call=rpc):
    pid,operator,url=provider
    require(call(url,"eth_chainId",[])=="0x1","historical provider wrong chain")
    target=source["previous_block"]
    block=call(url,"eth_getBlockByNumber",[hex(BLOCK-1),False])
    require(type(block) is dict and int(block.get("number","-1"),16)==BLOCK-1,
            "provider lost predecessor block")
    require(block.get("hash")==target["hash"] and
            block.get("stateRoot")==target["state_root"],
            "historical predecessor block hash/state root not matching original witness")
    borrower=source["borrower_address_for_local_fork_only"]
    calldata=GET_ACCOUNT_DATA+borrower[2:].rjust(64,"0")
    returned=call(url,"eth_call",[{"to":AAVE_POOL,"data":calldata},hex(BLOCK-1)])
    return {"provider_id":pid,"operator":operator,
            "source_previous_block_hash":block["hash"],
            "source_previous_block_state_root":block["stateRoot"],
            "position":decode_user_account_data(returned)}


def assess(source,*,call=rpc,providers=None):
    providers=providers or [p for p in PROVIDERS if p[0] in ("drpc","blast")]
    require(len(providers)==2 and [x[0] for x in providers]==["drpc","blast"]
            and providers[0][1]!=providers[1][1],
            "two distinct Ethereum RPC operators required")
    observations=[observe_one(p,source,call=call) for p in providers]
    first,second=observations
    require((first["source_previous_block_hash"],first["source_previous_block_state_root"],
             first["position"]) ==
            (second["source_previous_block_hash"],second["source_previous_block_state_root"],
             second["position"]),"Aave previous-block account-state mismatch across RPC operators")
    hf=int(first["position"]["health_factor_wad"])
    liquidatable=hf<WAD
    status=("RMC016_RANK1_PREBLOCK_HEALTH_FACTOR_BELOW_ONE" if liquidatable
            else "RMC016_RANK1_PREBLOCK_HEALTH_FACTOR_NOT_BELOW_ONE")
    out={
        "schema_version":1,"status":status,
        "immutable_source_zip_sha256":SOURCE_ZIP_SHA,
        "source_report_sha256":source["report_sha256"],
        "source_retrospective_competitor_transaction":TX,
        "source_retrospective_selection_only":True,
        "ethereum_chain_id":1,
        "previous_block_number":BLOCK-1,
        "previous_block_hash":source["previous_block"]["hash"],
        "aave_pool":AAVE_POOL,
        "borrower_source_identity_sha256":source["borrower_identity_sha256"],
        "account_data":first["position"],
        "health_factor_below_one_at_predecessor":liquidatable,
        "candidate_can_be_considered_for_preblock_fork_liquidation":liquidatable,
        "independent_operator_account_state_consensus":True,
        "operators":observations,
        "discovery_or_capture_prior_to_winner_proven":False,
        "atomic_liquidation_replayed":False,
        "external_gas_sponsor_authorized":False,
        "nexus_net_profit_proven":False,
        "real_market_census_closed":False,
    }
    out["report_sha256"]=digest(canonical(out))
    return out


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--source-zip",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    require(not a.out.exists(),"append-only output path required")
    source=authentic_prestate_report(a.source_zip)
    output=assess(source)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_bytes(canonical(output))
    print(output["status"],"block",BLOCK-1,
          "HF_WAD",output["account_data"]["health_factor_wad"],
          "Nexus_executed",False)


if __name__=="__main__":
    main()
