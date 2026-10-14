#!/usr/bin/env python3
"""47 historically indexed Aave winner FULL-receipt native-gas census.

Strict source-bound, read-only. This measures competitor gas, NOT NQC's
standalone transaction gas, profits, possible capture, builder payments or
prospective opportunity arrival rates. Costs are wei, not invented USD.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import statistics
import time
from urllib.request import Request, urlopen

import postwindow_competition_capacity_hurdle as proof
import blockscout_aave_89390_indexed_research as index

RPC_URLS = {
    "drpc":"https://eth.drpc.org",
    "publicnode":"https://ethereum-rpc.publicnode.com",
}
MAX_TXS=47
MAX_BLOCKS=47
MAX_CALLS_PER_SOURCE=110  # 1 chain + <=47 blocks +47 receipts +2 head rechecks
MAX_BODY=6_000_000
MAX_RECEIPT_LOGS=10_000
HEX32=re.compile(r"0x[0-9a-fA-F]{64}\Z")
HEXQ=re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z")


class Rejected(ValueError):
    pass


def need(ok,msg):
    if not ok:raise Rejected(msg)


def num(v,name):
    need(type(v) is str and HEXQ.fullmatch(v),name+" must be a strict RPC quantity")
    return int(v,16)


def h32(v,name):
    need(type(v) is str and HEX32.fullmatch(v),name+" must be bytes32")
    return v.lower()


def utc():
    return datetime.now(timezone.utc).isoformat()


def canonical(v):
    return (json.dumps(v,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()


def group_indexed_events(report,rows):
    need(report.get("indexed_event_count")==53 and
         report.get("unique_indexed_winner_tx_count")==MAX_TXS and
         report.get("unique_indexed_pair_count")==21 and
         report.get("source_rest_indexer_full_onchain_completeness") is False,
         "indexed source scope or cardinality changed")
    need(type(rows) is list and len(rows)==53,"expected precisely 53 source events")
    groups=defaultdict(list)
    ids=set()
    for r in rows:
        need(type(r) is dict and type(r.get("block")) is int and
             index.POST_START<=r["block"]<=index.POST_END and
             type(r.get("tx_hash")) is str and HEX32.fullmatch(r["tx_hash"]) and
             type(r.get("log_index")) is int and r["log_index"]>=0 and
             type(r.get("transaction_index")) is int and
             r["transaction_index"]>=0 and
             type(r.get("raw_topics")) is list and len(r["raw_topics"])==4 and
             all(type(x) is str and HEX32.fullmatch(x) for x in r["raw_topics"]) and
             type(r.get("raw_data")) is str and
             re.fullmatch(r"0x[0-9a-fA-F]{256}",r["raw_data"]),
             "incomplete original indexed receipt event")
        identity=(r["block"],r["tx_hash"],r["log_index"])
        need(identity not in ids,"duplicate source log identity")
        ids.add(identity)
        groups[r["tx_hash"]].append(r)
    need(len(groups)==MAX_TXS,"not exactly 47 original unique competitor txs")
    result={}
    for tx,items in sorted(groups.items()):
        need(len({v["block"] for v in items})==1 and
             len({v["transaction_index"] for v in items})==1,
             "winning tx belongs to inconsistent blocks or positions")
        result[tx]={"tx_hash":tx, "block_number":items[0]["block"],
                    "transaction_index":items[0]["transaction_index"],
                    "source_rows":sorted(items,key=lambda x:x["log_index"])}
    need(sum(len(x["source_rows"]) for x in result.values())==53,"source logs dropped")
    blocks={x["block_number"] for x in result.values()}
    need(1<=len(blocks)<=MAX_BLOCKS,"source block census invalid")
    return result,sorted(blocks)


def verify_header(raw,height):
    need(type(raw) is dict and num(raw.get("number"),"block.number")==height,
         "canonical block not returned")
    hashval=h32(raw.get("hash"),"block.hash")
    parent=h32(raw.get("parentHash"),"block.parentHash")
    root=h32(raw.get("stateRoot"),"block.stateRoot")
    need(parent!=hashval,"degenerate canonical ancestry")
    timestamp=num(raw.get("timestamp"),"block.timestamp")
    base=num(raw.get("baseFeePerGas"),"block.baseFeePerGas")
    gas_limit=num(raw.get("gasLimit"),"block.gasLimit")
    need(timestamp>0 and base>0 and gas_limit>21000,
         "invalid historical block base fee/gas limit")
    return {"number":height,"hash":hashval,"parent_hash":parent,
            "state_root":root,"timestamp":timestamp,
            "base_fee_wei":base,"block_gas_limit":gas_limit}


def verify_competitor_receipt(receipt,expected,block):
    """One paid competitor transaction with ALL its original indexed events."""
    need(type(receipt) is dict,"receipt object unavailable")
    need(h32(receipt.get("transactionHash"),"receipt.transactionHash")==expected["tx_hash"],
         "TRANSACTION_HASH_MISMATCH")
    need(h32(receipt.get("blockHash"),"receipt.blockHash")==block["hash"],
         "CANONICAL_BLOCK_HASH_MISMATCH")
    need(num(receipt.get("blockNumber"),"receipt.blockNumber")==block["number"],
         "RECEIPT_BLOCK_NUMBER_MISMATCH")
    need(num(receipt.get("transactionIndex"),"receipt.transactionIndex")==
         expected["transaction_index"],
         "RECEIPT_TRANSACTION_INDEX_MISMATCH")
    need(num(receipt.get("status"),"receipt.status")==1,
         "HISTORICAL_WINNER_TRANSACTION_STATUS_NOT_SUCCESS")
    gas=num(receipt.get("gasUsed"),"receipt.gasUsed")
    rate=num(receipt.get("effectiveGasPrice"),"receipt.effectiveGasPrice")
    need(21000<=gas<=block["block_gas_limit"] and rate>=block["base_fee_wei"],
         "invalid gasUsed/fee below baseFee or block gasLimit")
    tx_type=num(receipt.get("type","0x0"),"receipt.type")
    need(tx_type in (0,1,2,3,4),"unsupported transaction envelope type")
    blob_gas=receipt.get("blobGasUsed")
    blob_price=receipt.get("blobGasPrice")
    if blob_gas is not None or blob_price is not None:
        need(tx_type==3 and blob_gas is not None and blob_price is not None,
             "incomplete/mismatched blob gas accounting")
        extra_blob_wei=num(blob_gas,"blobGasUsed")*num(blob_price,"blobGasPrice")
    else:
        need(tx_type!=3,"EIP-4844 tx must contain blob gas receipt fields")
        extra_blob_wei=0
    observed_logs=receipt.get("logs")
    need(type(observed_logs) is list and len(observed_logs)<=MAX_RECEIPT_LOGS,
         "receipt logs absent or over bound")
    wanted=expected["source_rows"]
    matched={}
    for original in wanted:
        matches=[v for v in observed_logs if type(v) is dict and
                 type(v.get("address")) is str and v["address"].lower()==index.POOL
                 and type(v.get("logIndex")) is str and
                 num(v["logIndex"],"LiquidationCall log index")==original["log_index"]]
        need(len(matches)==1,"source expected liquidation log absent/duplicated")
        item=matches[0]
        if "removed" in item:
            need(item["removed"] is False,"liquidation log removed")
        actual=index.normalize(item,block["number"],block["number"])
        for field in ("block","tx_hash","transaction_index","log_index",
                      "collateral_asset","debt_asset","borrower_sha256",
                      "debt_raw","collateral_raw","raw_topics","raw_data",
                      "raw_event_hex_data_sha256"):
            need(actual[field]==original[field],
                 "indexed log differs from canonical receipt in "+field)
        need(h32(item.get("blockHash"),"log.blockHash")==block["hash"],
             "canonical liquidator log from other block hash")
        matched[original["log_index"]]=actual["raw_event_hex_data_sha256"]
    need(len(matched)==len(wanted),"source and receipt event count inconsistent")
    base_wei=gas*block["base_fee_wei"]
    priority_wei=gas*(rate-block["base_fee_wei"])
    paid_wei=gas*rate+extra_blob_wei
    need(paid_wei==base_wei+priority_wei+extra_blob_wei,
         "fee identity conservation failed")
    return {
        "tx_hash":expected["tx_hash"],
        "block_number":block["number"],"block_hash":block["hash"],
        "source_transaction_index":expected["transaction_index"],
        "source_liquidation_log_count":len(wanted),
        "distinct_asset_pairs_in_transaction":len({
            (x["collateral_asset"],x["debt_asset"]) for x in wanted
        }),
        "canonical_aave_log_indexes":sorted(matched),
        "matched_raw_liquidation_commitments":matched,
        "original_competitor_receipt_gas_used":gas,
        "effective_gas_price_wei":rate,
        "historical_block_base_fee_wei":block["base_fee_wei"],
        "priority_fee_per_gas_wei":rate-block["base_fee_wei"],
        "base_fee_burn_wei":base_wei,
        "priority_fee_paid_wei":priority_wei,
        "blob_fee_paid_wei":extra_blob_wei,
        "total_receipt_native_fee_wei":paid_wei,
        "canonical_original_competitor_gas_counted_once":True,
        "is_nqc_standalone_gas_used":False,
        "covers_offchain_builder_payments":False,
    }


class RPC:
    def __init__(self,provider,allowed_txs,allowed_blocks,transport=None):
        need(provider in RPC_URLS,"RPC provider not allowlisted")
        need(type(allowed_txs) is set and len(allowed_txs)==47 and
             type(allowed_blocks) is set and 1<=len(allowed_blocks)<=47,
             "unbounded indexed historical receipt identity set")
        self.provider=provider
        self.url=RPC_URLS[provider]
        self.allowed_txs=allowed_txs
        self.allowed_blocks=allowed_blocks
        self.calls=0
        self.transcript=[]
        self.transport=transport or self.network

    @staticmethod
    def network(url,method,params):
        need(url in set(RPC_URLS.values()),"unauthorized RPC URL")
        need(method in ("eth_chainId","eth_getBlockByNumber",
                        "eth_getTransactionReceipt"),"RPC writes prohibited")
        payload=json.dumps({"jsonrpc":"2.0","id":47,
                            "method":method,"params":params}).encode()
        request=Request(url,method="POST",data=payload,
                        headers={"Content-Type":"application/json",
                                 "User-Agent":"NQC-V2-CompetitorNativeGas-ReadOnly/1"})
        with urlopen(request,timeout=25) as response:
            data=response.read(MAX_BODY+1)
        need(len(data)<=MAX_BODY,"RPC reply too large")
        def unique_fields(pairs):
            obj={}
            for k,v in pairs:
                need(k not in obj,"duplicate RPC response field")
                obj[k]=v
            return obj
        raw=json.loads(data,object_pairs_hook=unique_fields,
                       parse_constant=lambda v:(_ for _ in ()).throw(
                           Rejected("nonfinite JSON field "+v)))
        need(type(raw) is dict and raw.get("jsonrpc")=="2.0" and
             raw.get("id")==47 and "error" not in raw and "result" in raw,
             "RPC error/malformed response")
        return raw["result"]

    def call(self,method,params):
        need(self.calls<MAX_CALLS_PER_SOURCE,"public RPC budget exceeded")
        if method=="eth_chainId":
            need(params==[],"chain query malformed")
        elif method=="eth_getBlockByNumber":
            need(type(params) is list and len(params)==2 and
                 type(params[0]) is str and HEXQ.fullmatch(params[0]) and
                 int(params[0],16) in self.allowed_blocks and params[1] is False,
                 "unapproved block read")
        elif method=="eth_getTransactionReceipt":
            need(type(params) is list and len(params)==1 and
                 type(params[0]) is str and HEX32.fullmatch(params[0]) and
                 params[0].lower() in self.allowed_txs,"unapproved receipt hash")
        else:
            raise Rejected("non-read-only RPC method")
        self.calls+=1
        record={"method":method,"params":params,"started_at_utc":utc()}
        try:
            if self.transport==self.network:
                time.sleep(.5)  # never evade provider rate limits
            result=self.transport(self.url,method,params)
            record["result_sha256"]=sha256(canonical(result)).hexdigest()
            return result
        except Exception as exc:
            record["error_type"]=type(exc).__name__
            record["error_detail"]=str(exc).split("https://")[0][:160]
            raise
        finally:
            record["finished_at_utc"]=utc()
            self.transcript.append(record)


def observe_source(provider,grouped,blocks,transport=None):
    rpc=RPC(provider,set(grouped),set(blocks),transport)
    row={"source":provider,"status":"INCOMPLETE_COMPETITOR_GAS_SOURCE",
         "errors":[],"receipts_verified":0,"blocks_verified":0,
         "witnesses":[]}
    try:
        need(num(rpc.call("eth_chainId",[]),"chainId")==1,"non-Ethereum RPC")
        headers={}
        for height in blocks:
            headers[height]=verify_header(
                rpc.call("eth_getBlockByNumber",[hex(height),False]),height)
            row["blocks_verified"]+=1
        for tx,c in sorted(grouped.items()):
            receipt=rpc.call("eth_getTransactionReceipt",[tx])
            try:
                proof=verify_competitor_receipt(receipt,c,headers[c["block_number"]])
            except Exception:
                # Preserve source-visible identity fields on failure, without
                # weakening any byte/receipt/fee check or claiming complete parity.
                row["rejected_receipt_identity"]={
                    "source_tx":tx,
                    "expected_block":c["block_number"],
                    "expected_block_hash":headers[c["block_number"]]["hash"],
                    "expected_transaction_index":c["transaction_index"],
                    "returned":{k:receipt.get(k) for k in (
                        "transactionHash","blockHash","blockNumber",
                        "transactionIndex","status","gasUsed",
                        "effectiveGasPrice","type"
                    )} if type(receipt) is dict else None,
                    "source_response_sha256":sha256(canonical(receipt)).hexdigest(),
                }
                raise
            row["witnesses"].append(proof)
            row["receipts_verified"]+=1
        # The first and last source anchors must be byte-identical after the
        # all-transaction scan; anything else is a canonical reorg or source drift.
        for height in (blocks[0],blocks[-1]):
            check=verify_header(
                rpc.call("eth_getBlockByNumber",[hex(height),False]),height)
            need(check==headers[height],"historical block changed during gas scan")
        need(len(row["witnesses"])==MAX_TXS and row["receipts_verified"]==MAX_TXS,
             "incomplete source canonical receipt universe")
        row["status"]="FULL_47_COMPETITOR_RECEIPTS_CANONICAL_GAS_WITNESS"
    except Exception as exc:
        row["errors"].append({"type":type(exc).__name__,
                              "detail":str(exc).split("https://")[0][:240]})
    row["rpc_calls_used"]=rpc.calls
    row["transcript"]=rpc.transcript
    need(rpc.calls<=MAX_CALLS_PER_SOURCE,"source RPC budget violated")
    return row


def nearest_rank(values,pct):
    need(type(values) is list and values and
         type(pct) is int and 0<pct<=100,"bad percentile")
    sorted_vals=sorted(values)
    rank=(len(sorted_vals)*pct+99)//100
    return sorted_vals[rank-1]


def statistical_report(witnesses):
    need(len(witnesses)==MAX_TXS and len({
        x["tx_hash"] for x in witnesses})==MAX_TXS,"missing/duplicate receipt economics")
    specs={
        "gas_used": [w["original_competitor_receipt_gas_used"] for w in witnesses],
        "effective_price_wei_per_gas":[w["effective_gas_price_wei"] for w in witnesses],
        "priority_price_wei_per_gas":[w["priority_fee_per_gas_wei"] for w in witnesses],
        "gas_fee_native_wei":[w["total_receipt_native_fee_wei"] for w in witnesses],
    }
    result={}
    for name,values in specs.items():
        need(all(type(x) is int and x>=0 for x in values),"gas units/price not integer")
        result[name]={"min":min(values),"p50_nearest_rank":nearest_rank(values,50),
                      "p90_nearest_rank":nearest_rank(values,90),
                      "p99_nearest_rank":nearest_rank(values,99),
                      "max":max(values),
                      "total_across_distinct_competitor_txs":sum(values)}
    gas_paid=sum(w["total_receipt_native_fee_wei"] for w in witnesses)
    return {
        "sample_size_distinct_paid_competitor_transactions":len(witnesses),
        "source_aave_liquidation_logs_verified":sum(
            x["source_liquidation_log_count"] for x in witnesses),
        "native_gas_paid_by_distinct_competitors_wei":gas_paid,
        "gas_fee_breakdown_wei":{
          "base_fee_burn":sum(w["base_fee_burn_wei"] for w in witnesses),
          "onchain_priority_fee":sum(w["priority_fee_paid_wei"] for w in witnesses),
          "blob_fee":sum(w["blob_fee_paid_wei"] for w in witnesses),
        },
        "distributions":result,
        "empirical_historical_distribution_not_probability_of_nqc_win":True,
        "not_equivalent_to_nqc_cold_transaction_gas":True,
        "offchain_builder_payments_absent_from_receipts":True,
        "wei_to_usd_not_computed_without_authenticated_same_block_fx":True,
    }


def build(index_report,rows,transport_factory=None):
    grouped,blocks=group_indexed_events(index_report,rows)
    out={"schema_version":1,
         "status":"INCOMPLETE_COMPETITOR_RECEIPT_GAS_NOT_NQC_NET",
         "started_at_utc":utc(),
         "source_index_sha256":proof.INDEX_ARTIFACT_SHA,
         "source_historical_indexer_sha256":index.SOURCE_RMC016_SHA,
         "source_liquidation_events_indexed":53,
         "source_unique_competitor_winner_transactions":47,
         "source_unique_asset_pairs":21,
         "source_unique_event_bearing_blocks":len(blocks),
         "source_block_window":{"first":index.POST_START,"last":index.POST_END},
         "sources":{},
         "complete_two_url_receipt_parity":False,
         "competitor_gas_statistics":None,
         "hindsight_selected_historical_winner_transactions":True,
         "blockscout_indexer_not_exhaustive_ethereum_liquidations":True,
         "two_public_rpc_urls_do_not_prove_independent_operators":True,
         "these_are_competitor_transactions_not_nqc_transactions":True,
         "cold_nqc_complete_transaction_gas_used_verified":False,
         "builder_out_of_band_inclusion_payments_established":False,
         "true_nqc_competitive_capture_rate_calibrated":False,
         "nqc_gross_route_surplus_in_this_universe_established":False,
         "nonrecourse_external_native_gas_payer_committed":False,
         "nqc_net_ev_proven":False,
         "RMC_closed":False,
         "P2_shadow_certified":False,
         "canary_live_authorized":False,
         "commercial_score_upgrade":False,
         "nqc_realized_pnl_usd":"0",
    }
    for name in ("drpc","publicnode"):
        out["sources"][name]=observe_source(
            name,grouped,blocks,
            transport_factory(name) if transport_factory else None)
    a,b=(out["sources"][i] for i in ("drpc","publicnode"))
    if a["status"]==b["status"]=="FULL_47_COMPETITOR_RECEIPTS_CANONICAL_GAS_WITNESS":
        if a["witnesses"]!=b["witnesses"]:
            out["status"]="MISMATCH_TWO_PUBLIC_URLS_COMPETITOR_GAS_UNCERTIFIED"
            out["source_mismatch_ledger"]=[
                {"tx_hash":x["tx_hash"],
                 "drpc_witness_sha256":sha256(canonical(x)).hexdigest(),
                 "publicnode_witness_sha256":sha256(canonical(y)).hexdigest()}
                for x,y in zip(a["witnesses"],b["witnesses"]) if x!=y]
            need(len(out["source_mismatch_ledger"])>0,
                 "different witnesses without classified source deltas")
        else:
            out["status"]="TWO_URL_47_COMPETITOR_RECEIPTS_GAS_PARITY_NO_NQC_GAS"
            out["complete_two_url_receipt_parity"]=True
            out["competitor_gas_statistics"]=statistical_report(a["witnesses"])
    out["finished_at_utc"]=utc()
    return out


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--indexed-artifact",type=Path,required=True)
    cli.add_argument("--out",type=Path,required=True)
    args=cli.parse_args()
    need(args.out.is_absolute() and args.out.parent.is_dir() and
         not args.out.exists(),"new exact-absolute report required")
    source,rows,manifest=proof.authenticate_index_archive(
        args.indexed_artifact.read_bytes())
    doc=build(source,rows)
    doc["authenticated_source_provenance"]=manifest
    with args.out.open("xb") as handle:handle.write(canonical(doc))
    print(doc["status"],"verified_receipts",[
        (k,v["receipts_verified"],v["blocks_verified"]) for k,v in doc["sources"].items()
    ],"two_url_parity",doc["complete_two_url_receipt_parity"])
    return 0


if __name__=="__main__":
    raise SystemExit(main())
