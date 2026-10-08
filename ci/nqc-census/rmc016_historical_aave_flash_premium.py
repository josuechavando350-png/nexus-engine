#!/usr/bin/env python3
"""Exact historical Aave Pool flashLoanSimple premium, NOT available Nexus capital.

Reads authenticated historical rival receipts/price archives and independently
observes previous-block Aave Pool FLASHLOAN_PREMIUM_TOTAL() via two RPC operators.
No oracle lookahead, no available-liquidity claim and no Nexus revenue claim.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path
from rmc016_probe_historical_rpc import AAVE_POOL,PROVIDERS,rpc
from rmc016_weth_cashflow_audit import WETH,canonical,require,uint,signed_usd_wad

AUDIT_ZIP_SHA="79cd8ee2056df668d31169444271bafb8f8ff3552e993000cf4e7df63ad28cb3"
RANK2_ZIP_SHA="ece575718b4834293ffb0a6e42f4329f41b39fef4b1befcad96eac507df1a92f"
PRICED13_ZIP_SHA="5ae6c45b53ded26f327270758c248f7f4ec0ff1365f550e54dcf28feb4a83a03"
SELECTOR="0x074b2e43" # keccak256("FLASHLOAN_PREMIUM_TOTAL()")[0:4]
KNOWN_RANKS=(
 "0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba",
 "0xb5b3f61e5a0becc1e2007d87cbea708fe40139478fac4c5eea5633b4b4beb1fb",
 "0x3c8757b8e83e098f64d88d0244709c7cdcf50ef67238e24d32357bcb679b5adb",
)
UINT32=re.compile(r"0x[0-9a-fA-F]{64}\Z")
HASH32=re.compile(r"0x[0-9a-f]{64}\Z")

def digest(raw):return hashlib.sha256(raw).hexdigest()
def load_verified_archive(path,sha,member):
    raw=path.read_bytes()
    require(len(raw)<200000 and digest(raw)==sha,"archive SHA-256 mismatch")
    with zipfile.ZipFile(path) as z:
        names=z.namelist()
        require(len(names)==2 and set(names)=={"archive.sha256",member},"wrong/duplicate archive members")
        for i in z.infolist():
            require(i.filename==Path(i.filename).name and i.file_size<=100000,
                    "unsafe archive entry")
        data=z.read(member)
        manifest=z.read("archive.sha256")
    require(manifest== (digest(data)+"  "+member+"\n").encode(),
            "archive member checksum mismatch")
    doc=json.loads(data)
    require(type(doc) is dict,"JSON source not an object")
    original=doc.pop("report_sha256",None)
    require(type(original) is str and original==digest(canonical(doc)),
            "source report commitment not conserved")
    doc["report_sha256"]=original
    return doc

def verified_candidates(audit,rank2,priced):
    require(audit.get("status")=="RMC016_HISTORICAL_WETH_WETH_COST_BUDGET_DIAGNOSTIC_ONLY" and
            audit.get("historical_weth_weth_winner_transactions")==9 and
            audit.get("historical_positive_after_hypothetical_5bps_transactions")==8 and
            audit.get("external_flash_principal_authenticated") is False and
            audit.get("real_market_census_closed") is False,"economic audit source overclaim")
    rows=audit["all_nine_weth_weth_records"]
    require(type(rows) is list and len(rows)==9 and
            [r["transaction_hash"] for r in rows[:3]]==list(KNOWN_RANKS),
            "prior historical top-3 rank chain mismatch")
    require(rank2.get("status")=="RMC016_RANK2_WETH_DUAL_OPERATOR_PREBLOCK_ORACLE_PASS" and
            rank2.get("selected_rank")==2 and rank2.get("nexus_net_profit_proven") is False and
            rank2.get("real_market_census_closed") is False and
            rank2.get("row",{}).get("transaction_hash")==KNOWN_RANKS[1] and
            rank2["row"].get("two_independent_operator_price_consensus") is True,
            "rank-two oracle certificate incomplete")
    require(priced.get("status")=="TWO_HISTORICAL_WETH_WINNER_PREBLOCK_ORACLE_PRICES_PASS" and
            priced.get("nexus_realized_profitability_proven") is False and
            priced.get("real_market_census_closed") is False and
            priced.get("exact_intratransaction_price_proven") is False,
            "prior two priced source overclaim")
    prices={x["transaction_hash"]:x for x in priced["transactions"]}
    require(set(prices)=={KNOWN_RANKS[0],KNOWN_RANKS[2]},
            "rank-one and rank-three source sample identity drift")
    price_refs={KNOWN_RANKS[1]:rank2["row"]}
    candidates=[]
    for i, tx in enumerate(KNOWN_RANKS):
        r=rows[i]
        doc=(price_refs[tx] if i==1 else prices[tx])
        pre=(doc["historical_preblock_oracle"] if i==1 else doc["preblock"])
        later=(doc["historical_winner_block_end_oracle"] if i==1 else doc["block_end"])
        require(pre.get("block")==r["block_number"]-1 and
                later.get("block")==r["block_number"] and
                later.get("hash")==r["block_hash"] and
                type(pre.get("hash")) is str and HASH32.fullmatch(pre["hash"]),
                "price reference or block hash not bound to original transaction")
        gas=(doc["historical_winner_full_tx_gas_wei"] if i==1 else doc["historical_winner_gas_wei"])
        require(uint(gas,"historical gas")==uint(r["winner_full_tx_gas_wei"],"archive gas"),
                "cross-source competitor gas mismatch")
        if i==1:
            require(int(doc["historical_after_winner_gas_wei"])==
                    int(r["collateral_minus_debt_minus_winner_gas_wei"]),
                    "rank two economic difference is not source bound")
        price=uint(pre["oracle_usd_base_1e8"],"preblock USD oracle",positive=True)
        debt=uint(r["historical_weth_debt_raw_wei"],"historical debt",positive=True)
        gross=uint(r["collateral_minus_debt_minus_winner_gas_wei"],"observed gross after gas",positive=True)
        candidates.append({
            "rank":i+1,"transaction_hash":tx,"block_number":r["block_number"],
            "historical_previous_block_number":pre["block"],
            "previous_block_hash":pre["hash"],
            "block_hash":r["block_hash"],
            "original_debt_weth_wei":str(debt),
            "original_after_competitor_gas_wei":str(gross),
            "previous_block_weth_usd_base_1e8":str(price),
            "conditional_original_5bps_wei":r["hypothetical_5bps_flash_premium_wei_ceil"],
        })
    return candidates

def historical_observation(candidates,request=rpc,providers=None):
    providers=providers or [p for p in PROVIDERS if p[0] in ("drpc","blast")]
    require(len(providers)==2 and [x[0] for x in providers]==["drpc","blast"] and
            providers[0][1]!=providers[1][1],"must use two independently operated RPCs")
    require(len(candidates)==3 and [x["transaction_hash"] for x in candidates]==list(KNOWN_RANKS),
            "wrong historical WETH top-3 set")
    evidence=[]
    for name,operator,url in providers:
        chain=request(url,"eth_chainId",[])
        require(chain=="0x1","wrong historical RPC chain")
        rows=[]
        for item in candidates:
            n=item["historical_previous_block_number"]
            header=request(url,"eth_getBlockByNumber",[hex(n),False])
            require(type(header) is dict and int(header.get("number","-1"),16)==n and
                    header.get("hash")==item["previous_block_hash"],
                    "historical previous-block header drift")
            premium_hex=request(url,"eth_call",[{"to":AAVE_POOL,"data":SELECTOR},hex(n)])
            require(type(premium_hex) is str and UINT32.fullmatch(premium_hex),
                    "Aave FLASHLOAN_PREMIUM_TOTAL return malformed")
            bps=int(premium_hex,16)
            require(0<=bps<=10000,"historical Aave flash premium outside bps domain")
            rows.append({"block":n,"hash":header["hash"],"premium_bps":bps})
        evidence.append({"provider_id":name,"operator":operator,"rows":rows})
    require(evidence[0]["rows"]==evidence[1]["rows"],
            "two independent RPC operators disagree on historical flash premium")
    observations=evidence[0]["rows"]
    history=[]
    for c,obs in zip(candidates,observations):
        debt=int(c["original_debt_weth_wei"])
        bps=obs["premium_bps"]
        # Aave PercentageMath.percentMul: (amount * bps + 5000) // 10000.
        historical_premium=(debt*bps+5000)//10000
        remaining=int(c["original_after_competitor_gas_wei"])-historical_premium
        history.append({
            **c,
            "aave_pool":AAVE_POOL,"aave_flashloan_simple_premium_bps_preblock":bps,
            "historical_pool_premium_wei_percentmul_half_up":str(historical_premium),
            "historical_after_winner_gas_and_pool_premium_wei":str(remaining),
            "historical_remaining_usd_wad_preblock_reference":str(
                signed_usd_wad(remaining,c["previous_block_weth_usd_base_1e8"])),
            "historical_pool_fee_matches_illustrative_5bps":bps==5,
            "historical_pool_fee_is_availability_quote":False,
            "historical_pool_liquidity_cap_verified":False,
            "nexus_external_gas_funding_proven":False,
            "nexus_capture_proven":False,
            "nexus_net_profit_proven":False
        })
    return history,evidence

def audit(audit_zip,rank2_zip,priced_zip,*,request=rpc,providers=None):
    report_audit=load_verified_archive(audit_zip,AUDIT_ZIP_SHA,"historical-weth-cashflow.json")
    report_rank2=load_verified_archive(rank2_zip,RANK2_ZIP_SHA,"rank2-preblock-weth-price.json")
    report_priced=load_verified_archive(priced_zip,PRICED13_ZIP_SHA,"top-two-weth-prices.json")
    candidates=verified_candidates(report_audit,report_rank2,report_priced)
    reports,operators=historical_observation(candidates,request=request,providers=providers)
    out={
        "schema_version":1,"status":"RMC016_AAVE_PREBLOCK_ACTUAL_FLASH_PREMIUM_3_WETH_WINNERS_PASS",
        "claim_scope":"THREE_HISTORICAL_COMPETITOR_WINNER_PREBLOCK_POOL_PREMIUM_ONLY",
        "source_sha256":{"9_winner_audit":AUDIT_ZIP_SHA,
                         "rank2_oracle":RANK2_ZIP_SHA,"rank1_rank3_oracle":PRICED13_ZIP_SHA},
        "historical_competitor_winners":3,
        "historical_premium_source":"AAVE_V3_POOL_FLASHLOAN_PREMIUM_TOTAL_AT_PREVIOUS_BLOCK_END",
        "network_observed_history":reports,
        "two_rpc_operators":operators,
        "operator_count":2,
        "same_block_flash_principal_liquidity_verified":False,
        "nexus_flash_principal_provider_authorized":False,
        "native_gas_sponsor_authorized":False,
        "actual_historical_nexus_calldata_replayed":False,
        "nexus_capture_calibrated":False,
        "nexus_realized_net_pnl_proven":False,
        "net_monthly_target_proven":False,
        "real_market_census_closed":False,
    }
    out["report_sha256"]=digest(canonical(out))
    return out

def main():
    p=argparse.ArgumentParser()
    for name in ("audit-zip","rank2-zip","priced13-zip","out"):
        p.add_argument("--"+name,required=True,type=Path)
    a=p.parse_args()
    require(not a.out.exists(),"append-only source report required")
    out=audit(a.audit_zip,a.rank2_zip,a.priced13_zip)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_bytes(canonical(out))
    print(out["status"],"premiums_bps",
          [x["aave_flashloan_simple_premium_bps_preblock"] for x in out["network_observed_history"]],
          "nexus_net_UNPROVEN")
if __name__=="__main__":main()
