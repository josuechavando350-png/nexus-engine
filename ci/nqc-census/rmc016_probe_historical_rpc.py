#!/usr/bin/env python3
"""Read-only historical Ethereum RPC admission probe; zero Nexus P&L authority.

Do not proceed to event/receipt reconstruction unless two independently
operated RPCs agree on exact historical block hashes and a real receipt.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

CHAIN_ID = 1
START_BLOCK = 25880316
START_HASH = "0x0b29e0c8c1997f059f82e7fed67e047269f68422ab194d56546c1c9833469d96"
END_BLOCK = 26095351
END_HASH = "0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781"
AAVE_POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
LIQUIDATION_TOPIC = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286"
KNOWN_LIQUIDATION_TX = "0x5a5088f209fd231f5e7bd1f507444a201baf0294fbc2c366415e630fc46c13d9"
PROVIDERS = (
    ("publicnode", "PublicNode", "https://ethereum-rpc.publicnode.com"),
    ("drpc", "dRPC", "https://eth.drpc.org"),
    ("llama", "LlamaNodes", "https://eth.llamarpc.com"),
    ("blockpi", "BlockPI", "https://ethereum.public.blockpi.network/v1/rpc/public"),
    ("blast", "BlastAPI", "https://eth-mainnet.public.blastapi.io"),
    ("blockscout", "Blockscout", "https://eth.blockscout.com/api/eth-rpc"),
)
HEX32 = re.compile(r"^0x[0-9a-f]{64}$")
MAX_RESPONSE = 8_000_000

def require(ok, message):
    if not ok:
        raise ValueError(message)

def canonical(obj):
    return (json.dumps(obj, sort_keys=True, separators=(",", ":")) + "\n").encode()

def sha256(data):
    return hashlib.sha256(data).hexdigest()

def as_hex_quantity(v, label):
    require(type(v) is str and re.fullmatch(r"0x(?:0|[1-9a-f][0-9a-f]*)",v) is not None,
            label + ": invalid hex quantity")
    return int(v,16)

def checked_header(block, number, expected_hash):
    require(type(block) is dict,"missing header")
    require(as_hex_quantity(block.get("number"),"number")==number, "header number mismatch")
    require(block.get("hash")==expected_hash,"historical block hash mismatch/reorg")
    require(type(block.get("parentHash")) is str and HEX32.fullmatch(block["parentHash"]) is not None,
            "missing parent hash")
    require(type(block.get("stateRoot")) is str and HEX32.fullmatch(block["stateRoot"]) is not None,
            "missing state root")
    t=as_hex_quantity(block.get("timestamp"),"timestamp")
    require(t>0,"invalid historical timestamp")
    return {"number":number,"hash":expected_hash,"parent_hash":block["parentHash"],
            "state_root":block["stateRoot"],"timestamp":t}

def checked_log(log,lo,hi):
    require(type(log) is dict,"invalid log")
    require(log.get("address","").lower()==AAVE_POOL,"unexpected pool")
    topics=log.get("topics")
    require(type(topics) is list and len(topics)==4 and topics[0]==LIQUIDATION_TOPIC,
            "unexpected LiquidationCall topic")
    require(all(type(t) is str and HEX32.fullmatch(t) for t in topics),"malformed topics")
    block=as_hex_quantity(log.get("blockNumber"),"log block")
    require(lo<=block<=hi,"log outside requested range")
    require(type(log.get("transactionHash")) is str and HEX32.fullmatch(log["transactionHash"]) is not None,
            "missing log tx hash")
    require(type(log.get("blockHash")) is str and HEX32.fullmatch(log["blockHash"]) is not None,
            "missing log block hash")
    require(as_hex_quantity(log.get("logIndex"),"logIndex")>=0,"bad logIndex")
    require(log.get("removed") is False,"reorg-removed log")
    require(type(log.get("data")) is str and re.fullmatch(r"0x[0-9a-f]*",log["data"]) is not None
            and len(log["data"])==2+4*64,"invalid LiquidationCall ABI data")
    return [block,log["transactionHash"],log["logIndex"],sha256(canonical(log))]

def checked_receipt(txid,receipt):
    require(type(receipt) is dict,"receipt absent")
    require(receipt.get("transactionHash")==txid,"wrong transaction receipt")
    require(as_hex_quantity(receipt.get("status"),"status")==1,"reverted transaction")
    require(type(receipt.get("blockHash")) is str and HEX32.fullmatch(receipt["blockHash"]) is not None,
            "receipt block hash absent")
    used=as_hex_quantity(receipt.get("gasUsed"),"gasUsed")
    price=as_hex_quantity(receipt.get("effectiveGasPrice"),"effectiveGasPrice")
    require(used>0 and price>0,"invalid receipt gas")
    require(any(type(x) is dict and x.get("address","").lower()==AAVE_POOL and
                x.get("topics",[None])[0]==LIQUIDATION_TOPIC
                for x in receipt.get("logs",[])),
            "reference receipt lacks Aave liquidation")
    return {"block_hash":receipt["blockHash"],
            "gas_used":str(used),"effective_gas_price_wei":str(price),
            "transaction_gas_wei":str(used*price)}

def rpc(url,method,params):
    payload=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params},
                       separators=(",",":")).encode()
    request=Request(url,data=payload,
                    headers={"Accept":"application/json","Content-Type":"application/json",
                             "User-Agent":"NQC-RMC016-ReadOnly/1.0"},method="POST")
    for attempt in range(2):
        try:
            with urlopen(request,timeout=18) as stream:
                raw=stream.read(MAX_RESPONSE+1)
                require(len(raw)<=MAX_RESPONSE,"RPC response exceeds bound")
                doc=json.loads(raw)
                require(type(doc) is dict and doc.get("jsonrpc")=="2.0" and doc.get("id")==1,
                        "noncanonical JSON-RPC envelope")
                require("error" not in doc and "result" in doc,
                        "JSON-RPC returned error: "+str(doc.get("error"))[:220])
                return doc["result"]
        except (HTTPError,URLError,TimeoutError,ValueError) as e:
            if attempt or isinstance(e,HTTPError) and e.code in (400,401,403,404):
                body = ""
                if isinstance(e,HTTPError):
                    try: body = e.read(512).decode("utf-8","replace")
                    except Exception: pass
                raise ValueError(type(e).__name__+": "+str(e)[:160]+(" BODY "+body[:256] if body else "")) from e
            time.sleep(1)
    raise ValueError("unreachable RPC retry")

def probe_one(provider,call=rpc):
    name,operator,url=provider
    def query(method, params):
        try:
            return call(url,method,params)
        except Exception as error:
            raise ValueError(f"{method}: {type(error).__name__}: {str(error)[:180]}") from error
    chain=as_hex_quantity(query("eth_chainId",[]),"chain id")
    require(chain==CHAIN_ID,"wrong RPC chain")
    a=checked_header(query("eth_getBlockByNumber",[hex(START_BLOCK),False]),
                     START_BLOCK,START_HASH)
    z=checked_header(query("eth_getBlockByNumber",[hex(END_BLOCK),False]),
                     END_BLOCK,END_HASH)
    lo=END_BLOCK-9
    logs=query("eth_getLogs",[{"address":AAVE_POOL,"topics":[LIQUIDATION_TOPIC],
                                 "fromBlock":hex(lo),"toBlock":hex(END_BLOCK)}])
    require(type(logs) is list,"getLogs not supported")
    checked=[checked_log(log,lo,END_BLOCK) for log in logs]
    ref=checked_receipt(KNOWN_LIQUIDATION_TX,
        query("eth_getTransactionReceipt",[KNOWN_LIQUIDATION_TX]))
    return {"provider_id":name,"operator":operator,"chain_id":chain,
            "start":a,"end":z,"sampled_log_count":len(checked),
            "sampled_logs_commitment":sha256(canonical(sorted(checked))),
            "reference_receipt":ref}

def evaluate(results):
    admitted=[x["evidence"] for x in results if x.get("admitted") is True]
    require(len({x["provider_id"] for x in admitted})==len(admitted),"duplicate provider IDs")
    operators={x["operator"] for x in admitted}
    matched=len(admitted)>=2 and len(operators)>=2
    if matched:
        critical=lambda a:(a["start"],a["end"],a["sampled_log_count"],
                            a["sampled_logs_commitment"],a["reference_receipt"])
        matched=all(critical(a)==critical(admitted[0]) for a in admitted[1:])
    return matched

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--out",required=True,type=Path)
    args=parser.parse_args()
    rows=[]
    for p in PROVIDERS:
        try:
            value=probe_one(p)
            rows.append({"provider_id":p[0],"operator":p[1],"admitted":True,"evidence":value})
        except Exception as e:
            rows.append({"provider_id":p[0],"operator":p[1],"admitted":False,
                         "rejection_code":"HISTORICAL_RPC_UNAVAILABLE_OR_MISMATCH",
                         "detail":str(e)[:240]})
    success=evaluate(rows)
    report={"schema_version":1,
            "status":"RMC016_HISTORICAL_RPC_PREFLIGHT_PASS" if success else
                     "RMC016_HISTORICAL_RPC_PREFLIGHT_BLOCKED",
            "terminal_economic_authority":False,
            "historical_winner_reconstruction_complete":False,
            "nexus_pnl_proven":False,
            "expected_winner_transactions":127,"expected_liquidation_events":139,
            "source_window":{"chain_id":CHAIN_ID,"start_block":START_BLOCK,"start_hash":START_HASH,
                             "end_block":END_BLOCK,"end_hash":END_HASH},
            "pool":AAVE_POOL,"topic0":LIQUIDATION_TOPIC,
            "sample_scope":"LAST_10_BLOCKS_AND_SEPARATE_KNOWN_RECEIPT_ONLY",
            "independent_provider_quorum":success,
            "results":rows}
    report["commitment_sha256"]=sha256(canonical(report))
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_bytes(canonical(report))
    print(report["status"],"quorum=",success,flush=True)
    return 0 if success else 2

if __name__=="__main__":
    sys.exit(main())
