#!/usr/bin/env python3
"""Three-source immutable native-gas evidence vs NQC historical route call gas.

PR694 competitor mined *receipts* contain actual gasUsed/effectiveGasPrice.
PR698 NQC local historical funded-route harness measures only a nested
gasleft() delta after test setup. PR700 contains exact same-block ETH/USD
oracle answers on the causally reconstructed liquidation triggers.

Never substitute competitor receipt gasUsed for NQC transaction gasUsed.
Native fees of a competitor are factual in ETH; on-chain oracle USD conversion
and hypothetical NQC whole-tx sensitivity are NOT realized net P&L.
No chain writes, RPC calls, signing, deployment, market fills or paid gas.
"""
from __future__ import annotations

import argparse
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
import re
import stat
import zipfile

import postwindow_economic_envelope as funded

COMPETITOR_ZIP_SHA = "3dc59eca6051d7aa11e45d1042953ae61eca29ae032b0f70c4f441f4be621931"
COMPETITOR_HEAD = "1908bfc36375e79ddf057278f6f02fd9d829a0dc"
COMPETITOR_PRODUCER_PY_SHA = "3ca808648770535d259893828910c9b5efd8a00d81e431dffbcce6fa1559d644"
COMPETITOR_REPORT_SHA = "d0ec5aaa4d228c5508760afbf1e3230957e1881913939b10682f1d8795fc63c2"
ROUTE_ZIP_SHA = funded.EXPECTED_ARTIFACT_SHA256
ORACLE_ZIP_SHA = "ca495ebdb9b8c7f8ed8438e5c3226b58b9c31c0d50e44ef35d6fce2cec232dde"
ORACLE_HEAD = "9208aa3cb29325ecb3a90557d1c62114c697bf02"
ORACLE_TREE = "cc19baf261e33fdcbd8ac765fcc5e446af322d86"
EXPECTED = {
    "WETH_COLLATERAL_USDC_DEBT": {
        "block":26142067,
        "tx":"0x08db2e5d5f4e627f9fb4d12a780aac26aed725fab36b70fb9647119872d74625",
        "gas_used":2740350, "effective_price_wei":1086577108,
        "trigger":"0x20dd5bccadb185dbac34c94c8d00bf363a4a0b779fe1fddcdcfd8a3066d96c8b",
        "expected_oracle_answer_after_raw":254164650000,
    },
    "WETH_COLLATERAL_USDT_DEBT": {
        "block":26149038,
        "tx":"0xe05b78bfeff1496c696bc8c9385c8e702352ce02df6a3225fa1d047439cdde91",
        "gas_used":591280, "effective_price_wei":2504340523,
        "trigger":"0x8195ce367cbf91e713b487af24dcb004def69e1c7ac9f62ce2aaedba04c4566b",
        "expected_oracle_answer_after_raw":240967670000,
    },
}
WEI_PER_ETH = 10**18
ORACLE_DECIMALS_FACTOR = 10**8
USD_MICROS = 10**6
# Upper/lower economic SENSITIVITY ONLY; not on-chain NQC receipt gasUsed.
HYPOTHETICAL_WHOLE_TX_GAS = (1_250_000,1_750_000,2_500_000)
MAX_ZIP = 20_000_000
HEX40 = re.compile(r"[0-9a-f]{40}\Z")
HEX32 = re.compile(r"0x[0-9a-f]{64}\Z")
SHA64 = re.compile(r"[0-9a-f]{64}\Z")
UINT_DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)\Z")


class Rejected(ValueError):
    pass


def need(ok, why):
    if not ok:
        raise Rejected(why)


def positive_integer(v, name):
    need(type(v) is int and v > 0 and v < 2**256,
         name+" must be positive integer")
    return v


def dec_positive(v, name):
    need(type(v) is str and UINT_DECIMAL.fullmatch(v) is not None,
         name+" must be canonical decimal string")
    return positive_integer(int(v),name)


def ceildiv(n, d):
    need(type(n) is int and n>=0 and type(d) is int and d>0,
         "invalid ceildiv arguments")
    return (n+d-1)//d


def read_json_strict(raw):
    def pairs(rows):
        result={}
        for key,value in rows:
            need(key not in result, "duplicate JSON property "+key)
            result[key]=value
        return result
    def reject_constant(v):
        raise Rejected("invalid JSON constant "+v)
    return json.loads(raw,object_pairs_hook=pairs,parse_constant=reject_constant)


def open_zip(raw, exact_digest, max_total=140_000_000):
    need(type(raw) is bytes and 0<len(raw)<=MAX_ZIP,
         "immutable source ZIP invalid/oversized")
    need(sha256(raw).hexdigest()==exact_digest,"immutable source ZIP SHA-256 drift")
    z=zipfile.ZipFile(BytesIO(raw))
    members=z.infolist()
    names=[x.filename for x in members if not x.is_dir()]
    need(len(members)<=350 and len(names)==len(set(names)) and
         sum(x.file_size for x in members)<=max_total,
         "unsafe/duplicated source ZIP members or inflated content")
    for item in members:
        name=item.filename
        p=PurePosixPath(name)
        need(name==str(p) and not p.is_absolute() and ".." not in p.parts
             and "\\" not in name and item.file_size<=55_000_000
             and not stat.S_ISLNK(item.external_attr>>16),
             "unsafe source ZIP path/type/size")
    return z,set(names)


def verify_manifest(z,names,manifest, prefix="./", full=True):
    need(manifest in names,"missing source manifest")
    records={}
    for line in z.read(manifest).decode("ascii").splitlines():
        match=re.fullmatch(r"([0-9a-f]{64})  (.+)",line)
        need(match is not None,"malformed SHA-256 manifest entry")
        digest,name=match.groups()
        need(name.startswith(prefix),"unexpected member manifest prefix")
        name=name[len(prefix):]
        need(name not in records and name in names and name!=manifest,
             "duplicate/absent/recursive manifest name")
        records[name]=digest
    if full:
        need(set(records)==names-{manifest},
             "source manifest omits unexpected members")
    for name,digest in records.items():
        need(sha256(z.read(name)).hexdigest()==digest,"source member SHA mismatch "+name)
    return set(records)


def authenticate_competitor(raw):
    z,names=open_zip(raw,COMPETITOR_ZIP_SHA)
    try:
        need(names=={
            "actual-receipt-evidence.sha256","source-evidence.sha256",
            "immutable-indexer.zip","real-competitor-receipts.json",
            "producer.py","negative-tests.py","nonclaims.json",
            "adversarial-tests.log","provider-exit-status.txt",
            "source.stderr","source.stdout",
        },"original competitor source evidence set drift")
        receipt=verify_manifest(z,names,"actual-receipt-evidence.sha256",prefix="",full=False)
        source=verify_manifest(z,names,"source-evidence.sha256",prefix="",full=False)
        need(receipt=={"immutable-indexer.zip","real-competitor-receipts.json"} and
             source=={"producer.py","negative-tests.py","nonclaims.json",
                      "adversarial-tests.log"},
             "positive source/receipt manifest scope changed")
        need(sha256(z.read("real-competitor-receipts.json")).hexdigest()==COMPETITOR_REPORT_SHA,
             "receipt report byte identity changed")
        need(sha256(z.read("producer.py")).hexdigest()==COMPETITOR_PRODUCER_PY_SHA,
             "receipt producer code bytes changed")
        need(sha256(z.read("immutable-indexer.zip")).hexdigest()==
             "b3d82ccd21cd683424b99c020732d2e2978ce2981a51b46df177a2d22c7bb722",
             "original indexer archive drift")
        need(z.read("provider-exit-status.txt").decode("ascii").strip()=="source_exit=0",
             "original receipt producer had non-successful exit")
        report=read_json_strict(z.read("real-competitor-receipts.json"))
        claims=read_json_strict(z.read("nonclaims.json"))
    finally:
        z.close()
    need(report.get("status")=="TWO_PUBLIC_RPC_HISTORICAL_RECEIPT_PARITY_NO_NEXUS_CAPTURE" and
         report.get("source_indexer_artifact_sha256")==
         "b3d82ccd21cd683424b99c020732d2e2978ce2981a51b46df177a2d22c7bb722" and
         set(report.get("rpc_provider_ids",[]))=={"drpc","blast"} and
         len(report.get("historical_receipt_witnesses",[]))==2,
         "competitor receipt coverage/authenticity changed")
    for key in ("RMC_closed","P2_shadow_certified","canary_live_authorized",
                "commercial_score_upgrade","net_execution_after_gas_builder_swap_flash_costs_proven",
                "external_nonrecourse_gas_funding_proven",
                "competitive_ex_ante_Nexus_capture_probability_calibrated",
                "full_89390_block_completeness_certified"):
        need(report.get(key) is False,"competitor source falsely promoted "+key)
    need(report.get("nqc_realized_pnl_usd")=="0" and
         claims.get("source_commit")==COMPETITOR_HEAD and
         claims.get("no_Nexus_production_PnL") is True and
         claims.get("no_Nexus_tx_or_wallet_signature") is True,
         "competitor proof or NQC P&L changed")
    cases={}
    for item in report["historical_receipt_witnesses"]:
        need(type(item) is dict and type(item.get("header")) is dict and
             type(item.get("receipt_witness")) is dict,"historical receipt witness invalid")
        w=item["receipt_witness"]
        label=w.get("label")
        need(label in EXPECTED and label not in cases,"invalid/duplicated competitor winner")
        fixed=EXPECTED[label]
        h=item["header"]
        need(type(h.get("number")) is int and h["number"]==fixed["block"] and
             type(h.get("hash")) is str and HEX32.fullmatch(h["hash"]) and
             w.get("block_hash")==h["hash"] and
             w.get("block_number")==fixed["block"] and
             w.get("tx_hash")==fixed["tx"] and
             w.get("receipt_event_identity_matches") is True and
             w.get("historical_competitor_execution_only") is True and
             w.get("realized_Nexus_revenue_from_this_tx")=="0" and
             w.get("indexed_raw_event_sha256")==w.get("canonical_event_raw_sha256"),
             "wrong canonical winner/receipt identity")
        gas=dec_positive(w.get("receipt_gas_used_raw"),"competitor receipt gasUsed")
        price=dec_positive(w.get("receipt_effective_gas_price_wei_raw"),
                           "competitor receipt effectiveGasPrice")
        need(gas==fixed["gas_used"] and price==fixed["effective_price_wei"],
             "competitor transaction receipt amounts changed")
        cases[label]={"label":label,"tx":fixed["tx"],"block":fixed["block"],
                      "block_hash":h["hash"],"gas_used":gas,
                      "effective_gas_price_wei":price,
                      "fee_paid_native_wei":gas*price,
                      "is_nqc_transaction":False}
    need(set(cases)==set(EXPECTED),"source missing one competitor receipt")
    return cases,{
        "artifact_zip_sha256":COMPETITOR_ZIP_SHA,
        "producer_commit":COMPETITOR_HEAD,
        "report_sha256":COMPETITOR_REPORT_SHA,
        "source_manifests_verified":2,
        "cryptographic_archive_whole_zip_covers_provider_logs":True,
        "two_urls_do_not_prove_operator_independence":True,
    }


def authenticate_route(raw):
    try:
        doc,proof=funded.authenticate_archive(raw)
        cases=funded.authenticated_cases(doc)
    except (ValueError,AssertionError,KeyError,TypeError) as exc:
        raise Rejected("route source did not certify:"+type(exc).__name__) from exc
    need(len(cases)==2 and set(x["label"] for x in cases)==set(EXPECTED),
         "source route case population drift")
    return {v["label"]:v for v in cases},proof


def authenticate_oracle(raw):
    z,names=open_zip(raw,ORACLE_ZIP_SHA,max_total=300_000_000)
    try:
        need({"manifest.sha256","code-commit.txt","code-tree.txt",
              "attempt/oracle-causality.json"}<=names,
             "oracle producer essential data missing")
        checked=verify_manifest(z,names,"manifest.sha256",prefix="./",full=True)
        need(z.read("code-commit.txt").decode("ascii").strip()==ORACLE_HEAD and
             z.read("code-tree.txt").decode("ascii").strip()==ORACLE_TREE,
             "oracle producer commit/tree drift")
        report=read_json_strict(z.read("attempt/oracle-causality.json"))
    finally:
        z.close()
    need(report.get("status")=="HISTORICAL_ORACLE_PRICE_CAUSALITY_ONLY" and
         len(report.get("cases",[]))==2 and report.get("errors")==[] and
         report.get("historical_selection_uses_future_winner") is True and
         report.get("nqc_realized_pnl_usd")=="0",
         "oracle source truth or commercial scope changed")
    for key in ("RMC_closed","P2_shadow_certified","canary_live_authorized",
                "commercial_score_upgrade","nqc_net_margin_proven",
                "prospective_detection_proven","external_nonrecourse_gas_funding_proven",
                "oracle_causality_is_not_mempool_visibility"):
        if key=="oracle_causality_is_not_mempool_visibility":
            need(report.get(key) is True,"oracle false prospective authority")
        else:
            need(report.get(key) is False,"oracle false source authority")
    cases={}
    for item in report["cases"]:
        name=item.get("label")
        need(name in EXPECTED and name not in cases and
             item.get("two_endpoint_parity") is True,"oracle case unverified")
        fixed=EXPECTED[name]
        need(item.get("first_tx")==fixed["trigger"],"oracle tx0 trigger drift")
        providers=item.get("providers")
        need(type(providers) is dict and set(providers)=={"blast","drpc"} and
             providers["blast"]==providers["drpc"],
             "oracle price/tx0 two URL metrics differ")
        obj=providers["drpc"]
        tx=obj.get("tx")
        m=obj.get("metrics")
        need(type(tx) is dict and type(m) is dict and
             tx.get("index")==0 and tx.get("tx_hash")==fixed["trigger"] and
             tx.get("block_number")==fixed["block"] and
             tx.get("block_hash")==(
                 "0xabd4ae6e806b202086cd782829077958a223c39c25e1637f3db186b2d907e8a1"
                 if name=="WETH_COLLATERAL_USDC_DEBT" else
                 "0xb20390e6485876b0fd8a1910a9b8b613e509b36e00d67121d9202cd2cc34c6f6") and
             m.get("NQC_PRICE_FREEZE_REVERTS_TRIGGER")==1,
             "oracle price trigger identity unsupported")
        after=positive_integer(m.get("NQC_FEED_ANSWER_AFTER"),"Chainlink answer after")
        before=positive_integer(m.get("NQC_FEED_ANSWER_BEFORE"),"Chainlink answer before")
        need(before>after and after==fixed["expected_oracle_answer_after_raw"] and
             m.get("NQC_ORACLE_PRICE_AFTER")==after and
             m.get("NQC_HF_BEFORE_TX0")>=10**18 and
             0<m.get("NQC_HF_AFTER_TX0")<10**18,
             "oracle price/HF causal fork drift")
        cases[name]={"block":fixed["block"],
                     "eth_usd_chainlink_answer_raw_8_decimals":after,
                     "historical_trigger_price_causal_only":True}
    need(set(cases)==set(EXPECTED),"oracle causal case missing")
    return cases,{
        "artifact_zip_sha256":ORACLE_ZIP_SHA,
        "producer_commit":ORACLE_HEAD,
        "producer_tree":ORACLE_TREE,
        "sha256_manifest_members_verified":len(checked),
    }


def gas_usd_micros(gas_units,effective_gas_wei,eth_usd_answer_raw):
    for v,n in ((gas_units,"gas"),(effective_gas_wei,"effective gas wei"),
                (eth_usd_answer_raw,"ETHUSD raw")):
        positive_integer(v,n)
    return ceildiv(gas_units*effective_gas_wei*eth_usd_answer_raw*USD_MICROS,
                   WEI_PER_ETH*ORACLE_DECIMALS_FACTOR)


def build(competitors,routes,oracles,provenance):
    need(set(competitors)==set(routes)==set(oracles)==set(EXPECTED),
         "exact two-case source labels required")
    result=[]
    for label in sorted(EXPECTED):
        comp,route,oracle=competitors[label],routes[label],oracles[label]
        feewei=positive_integer(comp["effective_gas_price_wei"],"on-chain effective price")
        gas=positive_integer(comp["gas_used"],"competitor receipt gas")
        base=positive_integer(route["block_base_fee_wei"],"historical block base fee")
        gross=positive_integer(route["gross_call_gas_not_receipt_gas"],
                               "NQC fork gasleft call delta")
        surplus=positive_integer(route["surplus_asset_micros"],"funded route surplus")
        feed=positive_integer(oracle["eth_usd_chainlink_answer_raw_8_decimals"],
                              "on-chain ETH USD price")
        need(gas==EXPECTED[label]["gas_used"] and
             feewei==EXPECTED[label]["effective_price_wei"] and
             feed==EXPECTED[label]["expected_oracle_answer_after_raw"],
             "exact receipt/oracle cases mutated")
        need(feewei>=base,"successful historical receipt effectiveGasPrice below basefee")
        need(comp["block"]==oracle["block"]==EXPECTED[label]["block"],
             "fee receipt and Chainlink price context not same historical block")
        need(comp["is_nqc_transaction"] is False,
             "competitor tx cannot become a NQC tx")
        paid_wei=gas*feewei
        need(paid_wei==comp["fee_paid_native_wei"],
             "competitor actually paid wei identity mismatch")
        base_fee_wei=gas*base
        tip_paid_wei=paid_wei-base_fee_wei
        # USD units are SOURCE CHAINLINK ORACLE approximate dollars, not a
        # bank-settled USD receipt or a quote of actual builder side payments.
        gas_usd=gas_usd_micros(gas,feewei,feed)
        scenarios=[]
        for assumed_gas in HYPOTHETICAL_WHOLE_TX_GAS:
            need(assumed_gas>=gross,"hypothetical gas below metered route call")
            native_micros=gas_usd_micros(assumed_gas,feewei,feed)
            scenesurplus=surplus-native_micros
            scenarios.append({
                "assumed_nqc_whole_transaction_gas":assumed_gas,
                "fee_per_gas_wei_is_historical_competitor_observation":feewei,
                "gas_cost_usd_micros_at_historical_chainlink":native_micros,
                "hypothetical_residual_stable_asset_usd_micros_if_peg_one":scenesurplus,
                "synthetic_not_nqc_receipt_or_expected_net":True,
                "builder_failed_bid_sponsor_and_operating_costs_missing":True,
            })
        result.append({
            "label":label,
            "historical_block":comp["block"],
            "competitor_transaction_hash":comp["tx"],
            "competitor_successful_receipt_gas_used":gas,
            "competitor_effective_gas_price_wei":feewei,
            "historical_aave_block_base_fee_wei":base,
            "competitor_priority_fee_per_gas_wei_from_receipt":feewei-base,
            "competitor_total_native_gas_paid_wei":paid_wei,
            "competitor_base_fee_paid_wei":base_fee_wei,
            "competitor_eip1559_priority_fee_paid_wei":tip_paid_wei,
            "chainlink_eth_usd_price_after_trigger_raw_8_decimals":feed,
            "competitor_native_gas_usd_oracle_equivalent_micros":gas_usd,
            "competitor_gas_is_not_nqc_gas":True,
            "nqc_selected_historical_route_surplus_before_native_costs_micros":surplus,
            "nqc_internal_execute_call_gasleft_delta_not_transaction_gas_used":gross,
            "nqc_internal_call_gas_only_hypothetical_usd_at_competitor_effective_price":
                gas_usd_micros(gross,feewei,feed),
            "hypothetical_nqc_full_tx_gas_sensitivity":scenarios,
            "stablecoin_usd_peg_externally_verified":False,
            "competitor_private_side_payments_absent_proven":False,
            "cold_nqc_transaction_receipt_gas_used_verified":False,
            "actual_nqc_native_gas_payment_verified":False,
            "nqc_native_gas_sponsor_nonrecourse_verified":False,
            "nqc_transaction_was_submitted":False,
            "nqc_competitive_capture_proven":False,
            "nqc_net_profit_proven":False,
        })
    return {
        "schema_version":1,
        "status":"COMPETITOR_NATIVE_GAS_FACTS_AND_NQC_GAS_SENSITIVITY_NO_NET",
        "sources":provenance,
        "cases":result,
        "full_competitor_receipt_gas_is_not_route_fork_gas":True,
        "source_historical_winners_chosen_with_future_knowledge":True,
        "historical_chainlink_usd_fx_is_not_fiat_settlement":True,
        "no_nqc_cold_whole_transaction_receipt":True,
        "no_actual_nqc_gas_or_priority_fee_payment":True,
        "no_calibrated_mev_builder_inclusion_failed_attempt_sponsor_costs":True,
        "no_prospective_capture_rate":True,
        "no_45000_55000_monthly_net_forecast":True,
        "no_source_exhaustive_de_fi_opportunity_census":True,
        "no_gas_spending_from_mxn2000":True,
        "OWN_CAPITAL_ZERO_INCLUDING_NATIVE_GAS_POLICY_UNCHANGED":True,
        "commercial_score_upgrade":False,
        "RMC_closed":False,
        "P2_shadow_certified":False,
        "canary_live_authorized":False,
        "nqc_realized_pnl_usd":"0",
    }


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--competitor-zip",required=True,type=Path)
    p.add_argument("--route-zip",required=True,type=Path)
    p.add_argument("--oracle-zip",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    need(a.out.is_absolute() and a.out.parent.is_dir() and not a.out.exists(),
         "fresh absolute evidence output required")
    comp,cprov=authenticate_competitor(a.competitor_zip.read_bytes())
    routes,rprov=authenticate_route(a.route_zip.read_bytes())
    oracles,oprov=authenticate_oracle(a.oracle_zip.read_bytes())
    report=build(comp,routes,oracles,{
        "competitor_receipt":cprov,"nqc_funded_fork_route":rprov,
        "oracle_price_and_hf_causality":oprov})
    with a.out.open("xb") as fd:
        fd.write((json.dumps(report,sort_keys=True,separators=(",",":"))+"\n").encode())
    for case in report["cases"]:
        print(case["label"],"actual competitor gas ETH wei",
              case["competitor_total_native_gas_paid_wei"],
              "oracle USD-equivalent micros",
              case["competitor_native_gas_usd_oracle_equivalent_micros"],
              "not NQC native gasUsed, PnL or capture")
    return 0


if __name__=="__main__":
    raise SystemExit(main())
