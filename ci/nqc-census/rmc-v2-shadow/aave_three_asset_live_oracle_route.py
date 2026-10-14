#!/usr/bin/env python3
"""Exact canonical Aave V3 oracle routing for three original NQC route assets.

READ ONLY: authenticated Ethereum chainId=1, ONE EIP-1898 blockHash, two public
provider results, runtime bytecode identity and the actual on-chain path:
Aave Pool.ADDRESSES_PROVIDER → Provider.getPriceOracle →
Oracle.getSourceOfAsset(WETH|USDC|USDT) + Oracle.getAssetPrice(asset).
Optionally test a source's aggregator() hop without assuming SVR participation.
Neither the presence of an aggregator nor a matching price confers private
oracle-update access or right to a builder's slot.

No signed tx, wallet, gas expenditure, private stream, paid RPC or mainnet write.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
from threading import Lock
import time
from urllib.request import Request, urlopen

import prospective_recent_borrow_cohort as borrow

POOL="0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
WETH="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
USDC="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
USDT="0xdac17f958d2ee523a2206206994597c13d831ec7"
ASSETS=(("WETH",WETH),("USDC",USDC),("USDT",USDT))
SELECTORS={
    "ADDRESSES_PROVIDER":"0x0542975c",
    "getPriceOracle":"0xfca513a8",
    "getSourceOfAsset":"0x92bf2be0",
    "getAssetPrice":"0xb3596f07",
    "BASE_CURRENCY":"0xe19f4700",
    "BASE_CURRENCY_UNIT":"0x8c89b64f",
    "aggregator":"0x245a7bfc",
    "decimals":"0x313ce567",
    "latestRoundData":"0xfeaf968c",
}
# Independent Ethereum Keccak-256 selectors, NOT SHA3-256.
MAX_CALLS=38
MAX_BYTES=210_000
MAX_REQUEST=6_000
MAX_PIN_AGE_SEC=180
MAX_TIP_DRIFT=3
MAX_ROUTER_DEPTH=1
MIN_PROVIDER_SPACING_SEC=.40
MAX_CODE_BYTES=70_000
UINT256_MAX=(1<<256)-1
HEX32=re.compile(r"0x[0-9a-fA-F]{64}\Z")
HEXQ=re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z")
HEXDATA=re.compile(r"0x(?:[0-9a-fA-F]{2})*\Z")
ADDR=re.compile(r"0x[0-9a-f]{40}\Z")


class Rejected(ValueError):
    pass


def need(ok,why):
    if not ok:raise Rejected(why)


def canonical(obj):
    return (json.dumps(obj,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()


def now():
    return {"utc_ns":time.time_ns(),"monotonic_ns":time.monotonic_ns()}


def parse_json(raw):
    def unique(rows):
        o={}
        for k,v in rows:
            need(k not in o,"duplicate JSON-RPC property")
            o[k]=v
        return o
    return json.loads(raw,object_pairs_hook=unique,
        parse_constant=lambda t:(_ for _ in ()).throw(Rejected("invalid JSON number")))


def uint(raw):
    need(type(raw) is str and HEXQ.fullmatch(raw),"invalid Ethereum RPC quantity")
    return int(raw,16)


def word_int(data):
    need(type(data) is str and HEX32.fullmatch(data),
         "not exactly one ABI 32-byte word")
    return int(data,16)


def address_word(data):
    v=word_int(data)
    need(0<v<2**160,"missing/bad ABI address from original contract")
    return "0x"+f"{v:040x}"


def optional_address_word(data):
    v=word_int(data)
    need(v<2**160,"bad optional aggregator address ABI")
    return None if v==0 else "0x"+f"{v:040x}"


def call_address(selector,address):
    need(selector in (SELECTORS["getSourceOfAsset"],SELECTORS["getAssetPrice"]) and
         type(address) is str and ADDR.fullmatch(address),
         "outside exactly 2 canonical oracle address queries")
    return selector+"0"*24+address[2:]


def code_meta(data):
    need(type(data) is str and HEXDATA.fullmatch(data) and data!="0x" and
         0<len(data[2:])//2<=MAX_CODE_BYTES,
         "no bounded EVM runtime code deployed")
    raw=bytes.fromhex(data[2:])
    return {"runtime_bytes":len(raw),"runtime_sha256":sha256(raw).hexdigest()}


class RPC:
    def __init__(self,provider,transport=None,clock=time.monotonic,sleeper=time.sleep):
        need(provider in borrow.RPC_ENDPOINTS,"unapproved public RPC provider")
        self.provider=provider
        self.url=borrow.RPC_ENDPOINTS[provider]
        self.transport=transport or self.network
        self.clock=clock
        self.sleeper=sleeper
        self.last=None
        self.guard=Lock()
        self.allowed={POOL:{SELECTORS["ADDRESSES_PROVIDER"]}}
        self.code_allowed={POOL}
        self.calls=0
        self.transcript=[]
        self.pin=None

    @staticmethod
    def network(url,method,params):
        need(url in borrow.RPC_ENDPOINTS.values(),"not pinned source URL")
        need(method in {"eth_chainId","eth_blockNumber",
                        "eth_getBlockByNumber","eth_getCode","eth_call"},
             "no Ethereum write or arbitrary contract call allowed")
        req_bytes=canonical({"jsonrpc":"2.0","id":433,"method":method,
                             "params":params})
        need(len(req_bytes)<=MAX_REQUEST,"outgoing Ethereum RPC too large")
        req=Request(url,data=req_bytes,method="POST",headers={
            "Content-Type":"application/json",
            "User-Agent":"NQC-V2-READONLY-AAVE-ORACLE-ROUTER/1"})
        with urlopen(req,timeout=34) as resp:
            raw=resp.read(MAX_BYTES+1)
        need(len(raw)<=MAX_BYTES,"oversized Ethereum read")
        parsed=parse_json(raw)
        need(type(parsed) is dict and parsed.get("jsonrpc")=="2.0" and
             parsed.get("id")==433 and "error" not in parsed and
             "result" in parsed,"RPC/provider failure, do not infer oracle absence")
        return parsed["result"]

    def authorize(self,address,selectors,*,code=True):
        need(type(address) is str and ADDR.fullmatch(address) and
             address!="0x"+"0"*40 and
             type(selectors) in (tuple,list,set) and
             all(s in SELECTORS.values() for s in selectors),
             "not an authenticated source contract route")
        self.allowed[address]=set(selectors)
        if code:self.code_allowed.add(address)

    def call(self,method,args):
        need(self.calls<MAX_CALLS,"bounded provider request budget exhausted")
        if method in ("eth_chainId","eth_blockNumber"):
            need(args==[],"invalid chain/tip parameters")
        elif method=="eth_getBlockByNumber":
            need(type(args) is list and len(args)==2 and
                 type(args[0]) is str and HEXQ.fullmatch(args[0]) and
                 args[1] is False,"only numbered canonical Ethereum header")
        elif method=="eth_getCode":
            need(type(args) is list and len(args)==2 and
                 args[0] in self.code_allowed and self.pin is not None and
                 args[1]=={"blockHash":self.pin,"requireCanonical":True},
                 "only authorized code at exact original blockhash")
        elif method=="eth_call":
            need(type(args) is list and len(args)==2 and
                 type(args[0]) is dict and set(args[0])=={"to","data"} and
                 self.pin is not None and
                 args[1]=={"blockHash":self.pin,"requireCanonical":True},
                 "only EIP1898 original canonical pinned state eth_call")
            dest=args[0]["to"];payload=args[0]["data"]
            need(dest in self.allowed and type(payload) is str and
                 len(payload)>=10 and payload[:10] in self.allowed[dest],
                 "eth_call unapproved contract/selector")
            sig=payload[:10]
            if sig in (SELECTORS["getSourceOfAsset"],SELECTORS["getAssetPrice"]):
                need(len(payload)==74 and
                     payload in {call_address(sig,a) for _,a in ASSETS},
                     "unapproved oracle asset outside WETH/USDC/USDT")
            else:
                need(len(payload)==10,"malformed selector with extra calldata")
        else:
            raise Rejected("Ethereum RPC method outside strict read-only allowlist")
        with self.guard:
            seen=self.clock()
            if self.last is not None and seen-self.last<MIN_PROVIDER_SPACING_SEC:
                self.sleeper(MIN_PROVIDER_SPACING_SEC-(seen-self.last))
            self.last=self.clock()
            self.calls+=1
        begun=now()
        row={"method":method,"provider":self.provider,
             "requested_utc_ns":begun["utc_ns"],
             "params_sha256":sha256(canonical(args)).hexdigest()}
        try:
            result=self.transport(self.url,method,args)
            row["response_sha256"]=sha256(canonical(result)).hexdigest()
            return result
        except Exception as exc:
            row["source_error_type"]=type(exc).__name__
            row["source_error"]=str(exc).split("https://")[0][:170]
            raise
        finally:
            row["elapsed_monotonic_ns"]=now()["monotonic_ns"]-begun["monotonic_ns"]
            self.transcript.append(row)

    def read(self,address,payload):
        return self.call("eth_call",[
            {"to":address,"data":payload},
            {"blockHash":self.pin,"requireCanonical":True},
        ])

    def code(self,address):
        return self.call("eth_getCode",[
            address,{"blockHash":self.pin,"requireCanonical":True}])

    def tip(self):
        need(uint(self.call("eth_chainId",[]))==1,"not Ethereum mainnet")
        return uint(self.call("eth_blockNumber",[]))

    def header(self,height):
        return borrow.header(self.call("eth_getBlockByNumber",[hex(height),False]),height)


def paired(clients, fn):
    with ThreadPoolExecutor(max_workers=2) as pool:
        f={p:pool.submit(fn,c) for p,c in clients.items()}
        result={p:fu.result() for p,fu in f.items()}
    need(set(result)=={"drpc","publicnode"} and
         result["drpc"]==result["publicnode"],
         "Ethereum public sources do not match the exact same frozen call")
    return result["drpc"]


def attest_code(clients,address):
    raw=paired(clients,lambda c:c.code(address))
    return code_meta(raw)


def one_optional(clients,address,selector,kind):
    # Optional SOURCE wrapper inspection is not a required Aave route method.
    # BOTH providers must agree about success OR failure, not elevate a single
    # one-sided response to public source authority.
    def attempt(client):
        try:
            return {"ok":True,"value":client.read(address,selector)}
        except Exception as exc:
            return {"ok":False,"type":type(exc).__name__}
    result=paired(clients,attempt)
    if not result["ok"]:
        return {"status":"SOURCE_SELECTOR_UNAVAILABLE_NO_PRIVATE_ACCESS_PROOF",
                "method":kind,"same_error_type_on_both_sources":True}
    return {"status":"SELECTOR_RESPONSE_IDENTICAL_TWO_SOURCES",
            "method":kind,"raw":result["value"]}


def collect(out,transport_factory=None,now_fn=now,reader_factory=None):
    need(isinstance(out,Path) and out.is_absolute() and out.is_dir() and
         not list(out.iterdir()),"fresh empty absolute evidence folder")
    frozen={"assets":[{"symbol":symbol,"address":addr} for symbol,addr in ASSETS],
            "known_canonical_aave_pool":POOL,
            "method_selectors":SELECTORS,
            "precommitted_before_current_RPC":now_fn(),
            "future_mempool_or_liquidation_winner_not_used":True}
    pre=out/"assets-and-ABI-sealed-before-network.json"
    pre.write_bytes(canonical(frozen))
    report={
        "schema_version":1,
        "status":"INCOMPLETE_AAVE_ORACLE_ROUTE_SOURCE_NOT_SVR_DENIAL",
        "precommit_sha256":sha256(pre.read_bytes()).hexdigest(),
        "fixed_asset_set":[a["symbol"] for a in frozen["assets"]],
        "block":None,"pool_provider_oracle":None,"asset_routes":[],
        "errors":[],"trace":{},
        "EIP1898_same_canonical_block_two_public_source_parity":False,
        "source_address_does_not_prove_dedicated_Chainlink_SVR":True,
        "proxy_aggregator_selector_not_private_mempool_visibility":True,
        "first_seen_pre_inclusion_report":False,
        "signed_or_submitted_mainnet_tx":False,
        "nqc_live_profit_or_sponsorship_proven":False,
        "market_wide_opportunity_recurrence_proven":False,
        "commercial_score_upgrade":False,
        "RMC_closed":False,"P2_shadow_certified":False,
        "canary_live_authorized":False,
        "user_mxn2000_spent":False,
        "OWN_CAPITAL_ZERO_INCLUDING_GAS_UNCHANGED":True,
        "nqc_realized_pnl_usd":"0",
    }
    clients={}
    try:
        need([x["symbol"] for x in frozen["assets"]]==["WETH","USDC","USDT"],
             "source assets changed")
        for provider in ("drpc","publicnode"):
            transport=transport_factory(provider) if transport_factory else None
            clients[provider]=(reader_factory(provider,transport)
                              if reader_factory else RPC(provider,transport))
        tips=paired(clients,lambda c:c.tip()) if False else {
            p:c.tip() for p,c in clients.items()}
        report["provider_tips"]=tips
        need(abs(tips["drpc"]-tips["publicnode"])<=MAX_TIP_DRIFT,
             "public Ethereum source tips too divergent")
        height=min(tips.values())-2
        header=paired(clients,lambda c:c.header(height))
        begun=now_fn()
        need(0<=begun["utc_ns"]//1_000_000_000-header["timestamp"]
             <=MAX_PIN_AGE_SEC,"pinned oracle source block stale/future")
        for c in clients.values():c.pin=header["hash"]
        report["block"]=header
        pool_code=attest_code(clients,POOL)
        provider=address_word(paired(clients,
            lambda c:c.read(POOL,SELECTORS["ADDRESSES_PROVIDER"])))
        for c in clients.values():c.authorize(
            provider,[SELECTORS["getPriceOracle"]])
        provider_code=attest_code(clients,provider)
        oracle=address_word(paired(clients,
            lambda c:c.read(provider,SELECTORS["getPriceOracle"])))
        for c in clients.values():c.authorize(
            oracle,[SELECTORS["getSourceOfAsset"],
                    SELECTORS["getAssetPrice"],
                    SELECTORS["BASE_CURRENCY"],
                    SELECTORS["BASE_CURRENCY_UNIT"]])
        oracle_code=attest_code(clients,oracle)
        base_cur=paired(clients,
            lambda c:c.read(oracle,SELECTORS["BASE_CURRENCY"]))
        base_unit=paired(clients,
            lambda c:c.read(oracle,SELECTORS["BASE_CURRENCY_UNIT"]))
        currency=optional_address_word(base_cur)
        unit=word_int(base_unit)
        need(0<unit<=10**36,"invalid Aave base currency price unit")
        report["pool_provider_oracle"]={
            "canonical_aave_v3_pool":POOL,
            "pool_runtime":pool_code,
            "pool_addresses_provider":provider,
            "provider_runtime":provider_code,
            "onchain_price_oracle":oracle,
            "oracle_runtime":oracle_code,
            "oracle_base_currency":currency,
            "oracle_base_currency_raw_abi":base_cur.lower(),
            "oracle_base_currency_unit":str(unit),
            "all_contract_runtime_equal_two_sources":True,
        }
        results=[]
        for symbol,asset in ASSETS:
            source=address_word(paired(clients,
                lambda c:c.read(oracle,call_address(
                    SELECTORS["getSourceOfAsset"],asset))))
            for c in clients.values():c.authorize(
                source,[SELECTORS["aggregator"],SELECTORS["decimals"],
                        SELECTORS["latestRoundData"]])
            src_code=attest_code(clients,source)
            rawprice=paired(clients,
                lambda c:c.read(oracle,call_address(
                    SELECTORS["getAssetPrice"],asset)))
            price=word_int(rawprice)
            need(price>0,"Aave returned nonpositive onchain asset price")
            aggregator=one_optional(clients,source,SELECTORS["aggregator"],"aggregator()")
            resolved=None
            if aggregator["status"]=="SELECTOR_RESPONSE_IDENTICAL_TWO_SOURCES":
                candidate=optional_address_word(aggregator["raw"])
                if candidate:
                    for c in clients.values():c.authorize(candidate,[])
                    resolved={"address":candidate,
                              "deployed_code":attest_code(clients,candidate),
                              "deeper_proxy_or_aggregator_chain_fully_proven":False}
            decimals=one_optional(clients,source,SELECTORS["decimals"],"decimals()")
            if decimals["status"]=="SELECTOR_RESPONSE_IDENTICAL_TWO_SOURCES":
                v=word_int(decimals["raw"])
                need(v<=36,"feed decimals outside sensible uint8/decimal range")
                decimals["value"]=v
            rounddata=one_optional(clients,source,SELECTORS["latestRoundData"],"latestRoundData()")
            if rounddata["status"]=="SELECTOR_RESPONSE_IDENTICAL_TWO_SOURCES":
                raw=rounddata["raw"]
                need(type(raw) is str and
                     re.fullmatch(r"0x[0-9a-fA-F]{320}",raw),
                     "malformed 5-word Chainlink-compatible round ABI")
                nums=[int(raw[2+i*64:2+(i+1)*64],16) for i in range(5)]
                # Round answer int256 is signed. Do not equate to Oracle output.
                signed=nums[1] if nums[1]<2**255 else nums[1]-2**256
                rounddata["decoded"]={
                    "round_id":str(nums[0]),"signed_answer_raw":str(signed),
                    "started_at_unix":str(nums[2]),"updated_at_unix":str(nums[3]),
                    "answered_in_round":str(nums[4])}
            results.append({
                "asset_symbol":symbol,"canonical_asset":asset,
                "aave_oracle_registered_source":source,
                "source_runtime_sha256_two_public_urls":src_code,
                "oracle_get_asset_price_raw":str(price),
                "oracle_price_unit":str(unit),
                "optional_source_aggregator_selector":aggregator,
                "optional_resolved_one_hop_aggregator":resolved,
                "optional_source_decimals":decimals,
                "optional_source_round_data":rounddata,
                "source_may_be_wrapper_or_proxy":True,
                "SVR_eligible_private_update_channel_proven":False,
                "do_not_interpret_source_rounddata_as_same_economic_price":True,
            })
        report["asset_routes"]=results
        endheaders=paired(clients,lambda c:c.header(height))
        need(endheaders==header,"oracle source canonical block reorged during read")
        need(0<=now_fn()["utc_ns"]//1_000_000_000-header["timestamp"]
             <=MAX_PIN_AGE_SEC,"oracle route block became stale during read")
        report["EIP1898_same_canonical_block_two_public_source_parity"]=True
        report["status"]="CURRENT_AAVE_THREE_ASSET_ONCHAIN_ORACLE_ROUTE_NO_SVR_AUTHORITY"
    except Exception as exc:
        report["errors"].append({"type":type(exc).__name__,
                                 "detail":str(exc).split("https://")[0][:190]})
    report["source_rpc_call_counts"]={p:c.calls for p,c in clients.items()}
    report["trace"]={p:c.transcript for p,c in clients.items()}
    report["finish_time"]=now_fn()
    (out/"aave-oracle-source-route.json").write_bytes(canonical(report))
    return report


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out",type=Path,required=True)
    args=ap.parse_args()
    need(args.out.is_absolute() and not args.out.exists() and
         args.out.parent.is_dir(),"new absolute experiment directory")
    args.out.mkdir()
    result=collect(args.out)
    print(result["status"],"markets",len(result["asset_routes"]),
          "block",result.get("block",{}).get("number") if result.get("block") else None,
          "source_errors",result["errors"])
    return 0  # Incomplete source remains INCOMPLETE in strict jq gate.

if __name__=="__main__":
    raise SystemExit(main())
