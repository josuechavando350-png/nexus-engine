#!/usr/bin/env python3
"""NQC V2 ATLAS-CAPITAL-001: bounded, read-only, multi-chain Atlas bond gate.

Strictly NO wallet, signatures, payment, transaction submission, relay bidding,
paid credentials, retries after rate limits, or gas expenditure. Chainlink
Atlas documentation + code are controls, not assumed proof that a searcher
is eligible or that NQC can finance native gas with own capital 0.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen

SOURCES = {
 "base": {
  "chain_id":8453,
  "atlas":"0x583dCfef0D240DC80753F0F0B26513feE27D9B77",
  "control":"0xa5E1a36938769cbd5a26f5e19D8FCB379f597c83",
  "endpoints":("https://base-rpc.publicnode.com", "https://mainnet.base.org"),
  "recommended_bond":"0.1 ETH", "currency":"ETH"},
 "arbitrum": {
  "chain_id":42161,
  "atlas":"0x8ad1aE9D97C79aA68A0a151E83ff3942f68F86C1",
  "control":"0xe15BBa987C002ecc3586e81244517877D294d291",
  "endpoints":("https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"),
  "recommended_bond":"0.1 ETH", "currency":"ETH"},
 "bnb": {
  "chain_id":56,
  "atlas":"0x21B7d28B882772A1Cfe633Daee6f42ebb95DeC4E",
  "control":"0x7D50b32444609A9B53BcF208c159C8d0d0767835",
  "endpoints":("https://bsc-rpc.publicnode.com", "https://bsc-dataseed.binance.org"),
  "recommended_bond":"1 BNB", "currency":"BNB"},
}
# Verified against Chainlink SVR Atlas Ethereum docs (2026-10-14) and
# FastLane Labs atlas source commit 083dccd05a2c92e0e9cae90ac404504f741bc493.
ATLAS_SORTER_BLOB = "517f0a39d0199091027702b29bcb697e04d0bcdb"
ATLAS_ATLETH_BLOB = "9f868fced242a19d14917742398a6d5ebeee0a93"
ATLAS_SOLVERBASE_BLOB = "f23db0ddaaabd9d14be1150b531153bb9e4f2a1f"
MAX_CALLS_PER_PROVIDER = 11
MAX_RPC_BYTES = 500_000
MAX_OUTPUT_BYTES = 3_000_000
MIN_INTERVAL_SECONDS = 0.3
MAX_TIP_DIFF = {"base":5,"arbitrum":16,"bnb":6}
HEX32=re.compile(r"0x[0-9a-fA-F]{64}\Z")
QUANTITY=re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z")
CODE=re.compile(r"0x(?:[0-9a-fA-F]{2})*\Z")

class Reject(ValueError):
    pass

def need(condition, reason):
    if not condition: raise Reject(reason)

def canon(value):
    return (json.dumps(value,sort_keys=True,separators=(",", ":"),ensure_ascii=True)+"\n").encode()

# Ethereum Keccak-f[1600] (not Python SHA3) independently checked with
# empty-string / ERC20 transfer signature golden vectors.
_RC=(
0x0000000000000001,0x0000000000008082,0x800000000000808a,0x8000000080008000,
0x000000000000808b,0x0000000080000001,0x8000000080008081,0x8000000000008009,
0x000000000000008a,0x0000000000000088,0x0000000080008009,0x000000008000000a,
0x000000008000808b,0x800000000000008b,0x8000000000008089,0x8000000000008003,
0x8000000000008002,0x8000000000000080,0x000000000000800a,0x800000008000000a,
0x8000000080008081,0x8000000000008080,0x0000000080000001,0x8000000080008008)
_RHO=((0,1,62,28,27),(36,44,6,55,20),(3,10,43,25,39),
      (41,45,15,21,8),(18,2,61,56,14))
_MASK=(1<<64)-1

def keccak256(blob):
    need(type(blob) is bytes and len(blob)<=65536,"keccak input invalid/bounded")
    def rol(v,n):return (((v<<n)|(v>>(64-n)))&_MASK) if n else v
    padded=bytearray(blob);padded.append(1)
    while len(padded)%136!=135:padded.append(0)
    padded.append(0x80);a=[0]*25
    for off in range(0,len(padded),136):
        for i in range(17):a[i]^=int.from_bytes(padded[off+i*8:off+i*8+8],"little")
        for rc in _RC:
            col=[a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20] for x in range(5)]
            for x in range(5):
                d=col[(x-1)%5]^rol(col[(x+1)%5],1)
                for y in range(5):a[x+y*5]^=d
            b=[0]*25
            for x in range(5):
                for y in range(5): b[y+5*((2*x+3*y)%5)]=rol(a[x+5*y],_RHO[y][x])
            for x in range(5):
                for y in range(5):a[x+5*y]=b[x+5*y]^((~b[(x+1)%5+5*y])&b[(x+2)%5+5*y])
            a[0]^=rc
    return b"".join(a[i].to_bytes(8,"little") for i in range(4))

def selector(signature):
    need(type(signature) is str and signature.isascii() and len(signature)<100,
         "not bounded ABI signature")
    return "0x"+keccak256(signature.encode())[:4].hex()

SIGS={
 "balanceOfBonded(address)": "Atlas: bonded balance of one address",
 "bondedTotalSupply()":"Atlas: total bonded native asset",
 "getSolverGasLimit()":"SVR DappControl: per-operation gas cap",
 "ESCROW_DURATION()":"Atlas: native bond withdrawal delay",
}
CALLS={name:selector(name) for name in SIGS}
ZERO_ADDRESS="0x"+"0"*40

def encode_address_call(name,address):
    need(name=="balanceOfBonded(address)" and type(address) is str and
         re.fullmatch(r"0x[0-9a-fA-F]{40}",address),"unknown ABI target")
    return CALLS[name]+"0"*24+address[2:].lower()

def positive_eligibility(bonded_wei,max_fee_wei,execution_gas,calldata_gas,
                         surcharge_bps=0):
    """Lower-bound *eligibility* toy, not a deployed Atlas bid validator.
    Pinned Sorter code requires bonded >= (maxFee * (exec+calldata)).withSurcharge.
    Avoid exact surcharge reproduction; this min bound is <= actual cost.
    """
    values=(bonded_wei,max_fee_wei,execution_gas,calldata_gas,surcharge_bps)
    need(all(type(v) is int and 0<=v<2**256 for v in values),"negative/overflow integer")
    need(execution_gas+calldata_gas<2**256 and
         max_fee_wei*(execution_gas+calldata_gas)<2**256,
         "overflow potential maximum gas obligation")
    must_cover=max_fee_wei*(execution_gas+calldata_gas)
    # Additional positive surcharge cannot improve eligibility.
    need(surcharge_bps<=10000,"stress bound surcharge unsupported")
    return {"bonded_wei":str(bonded_wei),
            "simple_lower_bound_wei":str(must_cover),
            "positive_fee_zero_bond_ineligible":max_fee_wei>0 and
             execution_gas+calldata_gas>0 and bonded_wei==0,
            "meets_simple_lower_bound_not_full_atlas_eligibility":bonded_wei>=must_cover,
            "full_deployed_verification_proven":False}

def quantity(v):
    need(type(v) is str and QUANTITY.fullmatch(v),"invalid quantity")
    return int(v,16)

def header(raw,expected):
    need(type(raw) is dict and quantity(raw.get("number"))==expected,"invalid block height")
    for k in ("hash","parentHash","stateRoot"):
        need(type(raw.get(k)) is str and HEX32.fullmatch(raw[k]),"invalid header "+k)
    need(quantity(raw.get("timestamp"))>0,"invalid block timestamp")
    return {"number":expected,"hash":raw["hash"].lower(),
            "parent_hash":raw["parentHash"].lower(),
            "state_root":raw["stateRoot"].lower(),
            "timestamp":quantity(raw["timestamp"])}

def word(raw):
    need(type(raw) is str and re.fullmatch(r"0x[0-9a-fA-F]{64}",raw),
         "not exactly ABI uint256")
    return int(raw,16)

class Readonly:
    def __init__(self,chain,source,*,transport=None,wait=time.sleep,monotonic=time.monotonic):
        need(chain in SOURCES and source in (0,1),"unapproved chain/provider")
        self.chain=chain;self.source=source
        self.url=SOURCES[chain]["endpoints"][source]
        self.transport=transport or self.http
        self.wait=wait;self.monotonic=monotonic;self.last=None
        self.calls=0;self.transcript=[]
        self.pinned_height=None

    @staticmethod
    def http(url,method,params):
        need(any(url in v["endpoints"] for v in SOURCES.values()),"unapproved rpc host")
        packet=canon({"jsonrpc":"2.0","id":771,"method":method,"params":params})
        need(len(packet)<=2000,"RPC request too big")
        req=Request(url,method="POST",data=packet,headers={
            "Content-Type":"application/json","User-Agent":"NQC-V2-ATLAS-CAPITAL-READONLY/1"})
        with urlopen(req,timeout=20) as resp:
            need(resp.geturl()==url and resp.getcode()==200,"RPC redirect/error")
            data=resp.read(MAX_RPC_BYTES+1)
        need(len(data)<=MAX_RPC_BYTES,"RPC response excessive")
        decoded=json.loads(data,object_pairs_hook=Readonly.unique,
                           parse_constant=lambda c:(_ for _ in ()).throw(Reject("bad constant")))
        need(type(decoded) is dict and decoded.get("jsonrpc")=="2.0" and
             decoded.get("id")==771 and "error" not in decoded and "result" in decoded,
             "RPC source error/invalid envelope")
        return decoded["result"]

    @staticmethod
    def unique(pairs):
        out={}
        for k,v in pairs:
            need(k not in out,"duplicate JSON key")
            out[k]=v
        return out

    def call(self,method,params):
        need(self.calls<MAX_CALLS_PER_PROVIDER,"RPC bound exhausted")
        if method in ("eth_chainId","eth_blockNumber"):
            need(params==[],"only no-arg chain/tip")
        elif method=="eth_getBlockByNumber":
            need(type(params) is list and len(params)==2 and
                 type(params[0]) is str and QUANTITY.fullmatch(params[0]) and
                 params[1] is False and self.pinned_height is not None and
                 quantity(params[0])==self.pinned_height,
                 "only one numbered/frozen canonical header")
        elif method in ("eth_getCode","eth_call"):
            need(self.pinned_height is not None and type(params) is list and
                 len(params)==2 and params[1]==hex(self.pinned_height),
                 "state only at numbered pinned block")
            atlas=SOURCES[self.chain]["atlas"].lower()
            ctrl=SOURCES[self.chain]["control"].lower()
            if method=="eth_getCode":
                need(type(params[0]) is str and params[0].lower() in (atlas,ctrl),
                     "unknown contract for code read")
            else:
                need(type(params[0]) is dict and set(params[0])=={"to","data"},
                     "eth_call bounded object required")
                to,data=params[0]["to"].lower(),params[0]["data"]
                need((to==atlas and data in (
                         CALLS["bondedTotalSupply()"],
                         CALLS["ESCROW_DURATION()"],
                         encode_address_call("balanceOfBonded(address)",ZERO_ADDRESS))) or
                     (to==ctrl and data==CALLS["getSolverGasLimit()"]),
                     "eth_call outside admitted contract/method")
        else:raise Reject("non-readonly Ethereum method forbidden")
        if self.last is not None:
            delta=MIN_INTERVAL_SECONDS-(self.monotonic()-self.last)
            if delta>0:self.wait(delta)
        self.last=self.monotonic()
        self.calls+=1
        at=time.monotonic_ns()
        row={"chain":self.chain,"source_index":self.source,"method":method,
             "request_sha256":hashlib.sha256(canon(params)).hexdigest()}
        try:
            result=self.transport(self.url,method,params)
            row["result_sha256"]=hashlib.sha256(canon(result)).hexdigest()
            return result
        except Exception as error:
            row["error_type"]=type(error).__name__
            row["http_status"]=getattr(error,"code",None)
            raise
        finally:
            row["elapsed_ns"]=time.monotonic_ns()-at
            self.transcript.append(row)

def matched(clients,method,params):
    left=clients[0].call(method,params)
    right=clients[1].call(method,params)
    need((left.lower() if type(left) is str else left)==
         (right.lower() if type(right) is str else right),
         "same-block dual-public-provider parity failed for "+method)
    return left

def snapshot(chain,clients):
    need(chain in SOURCES and len(clients)==2 and [c.chain for c in clients]==[chain,chain],
         "two exact chain clients required")
    same=SOURCES[chain]
    chain_ids=[quantity(c.call("eth_chainId",[])) for c in clients]
    need(chain_ids==[same["chain_id"]]*2,"wrong chainId")
    heights=[quantity(c.call("eth_blockNumber",[])) for c in clients]
    need(max(heights)-min(heights)<=MAX_TIP_DIFF[chain],
         "public RPC tips not close enough")
    block=min(heights)-8
    need(block>1,"invalid selected height")
    for c in clients:c.pinned_height=block
    h=header(matched(clients,"eth_getBlockByNumber",[hex(block),False]),block)
    code={}
    for key in ("atlas","control"):
        c=matched(clients,"eth_getCode",[same[key],hex(block)])
        need(type(c) is str and CODE.fullmatch(c) and
             0<len(c[2:])//2<=100000,"missing/bad deployed Atlas runtime")
        code[key]={"address":same[key],"byte_length":len(c[2:])//2,
                   "runtime_sha256":hashlib.sha256(bytes.fromhex(c[2:])).hexdigest()}
    signatures=[("balanceOfBonded(address)","atlas",
                 encode_address_call("balanceOfBonded(address)",ZERO_ADDRESS)),
                ("bondedTotalSupply()","atlas",CALLS["bondedTotalSupply()"]),
                ("getSolverGasLimit()","control",CALLS["getSolverGasLimit()"]),
                ("ESCROW_DURATION()","atlas",CALLS["ESCROW_DURATION()"])]
    result={}
    for name,receiver,calldata in signatures:
        result[name]=word(matched(clients,"eth_call",[
            {"to":same[receiver],"data":calldata},hex(block)]))
    again=header(matched(clients,"eth_getBlockByNumber",[hex(block),False]),block)
    need(again==h,"shallow reorg/head mismatch")
    need(result["getSolverGasLimit()"]>0 and result["ESCROW_DURATION()"]>0,
         "deployed gas/escrow parameters invalid")
    return {"status":"TWO_PUBLIC_SOURCE_PINNED_ATLAS_BOND_INTERFACE_PASS_NO_PRODUCTION_AUTHORITY",
            "chain_id":same["chain_id"],"block":h,"contracts":code,
            "source_bonded_balance_zero_address_wei":str(result["balanceOfBonded(address)"]),
            "deployed_bonded_total_native_wei":str(result["bondedTotalSupply()"]),
            "deployed_solver_gas_limit":result["getSolverGasLimit()"],
            "escrow_duration_in_blocks":result["ESCROW_DURATION()"],
            "dual_endpoint_operator_independence_proven":False,
            "deployed_bytecode_equivalent_to_pinned_source_proven":False}

def source_assessment():
    # A source-locked decision, not claiming deployed bytecode equivalence.
    example=positive_eligibility(0,1_000_000_000,300_000,80_000)
    need(example["positive_fee_zero_bond_ineligible"],"zero bond must not be eligible")
    return {
        "candidate":"Atlas financed via Chainlink's transaction submission",
        "network_transaction_payer":"Chainlink oracle/bundler advances L2 native fees",
        "liability":"Solver must bond native assets, pay bid and applicable gas; solver-caused fails charged",
        "signer_bond_identity":"same EOA address must bond and sign solverOp",
        "recommended_bonds_not_minimums":{
            "Base":"0.1 ETH","Arbitrum":"0.1 ETH","BNB":"1 BNB"},
        "one_solver_account_per_auction_per_block_documented":True,
        "zero_bond_source_guard_from_pinned_Sorter":True,
        "example_positive_wei_fee_zero_bond_source_eligible":False,
        "independent_financier_terms_authenticated":False,
        "third_party_bond_might_reconcile_OWN_CAPITAL_only_under_verified_contract":True,
        "actual_third_party_sponsor_proven":False,
        "nonrecourse_gas_proven":False,
        "atlas_live_bid_permission":False,
        "net_profit_verified":False}

def run(out:Path,clients=None):
    need(out.is_absolute() and not out.exists() and out.parent.is_dir(),
         "new absolute output dir expected")
    out.mkdir()
    seal={"schema_version":1,"generated_before_network_ns":time.time_ns(),
          "chain_names":list(SOURCES),
          "contract_pins":{key:{k:v for k,v in row.items() if k!="endpoints"}
                           for key,row in SOURCES.items()},
          "public_read_only_methods":["eth_chainId","eth_blockNumber",
                                       "eth_getBlockByNumber","eth_getCode","eth_call"],
          "zero_address_not_user_wallet":ZERO_ADDRESS,
          "no_sign_send_bid_or_spend":True}
    (out/"sealed-before-network.json").write_bytes(canon(seal))
    report={"schema_version":1,"original_seal_sha256":hashlib.sha256(canon(seal)).hexdigest(),
            "status":"INCOMPLETE_MULTI_CHAIN_SOURCE", "chains":{},"errors":[],
            "source_admission":source_assessment(),"transcripts":{},
            "atlas_sponsored_own_capital_zero_proven":False,
            "PFT_closed":True,"RMC_closed":False,"Shadow_certified":False,
            "LIVE_authorized":False,"NQC_realized_pnl_USD":"0"}
    for chain in SOURCES:
        pair=clients[chain] if clients is not None else [Readonly(chain,0),Readonly(chain,1)]
        try:report["chains"][chain]=snapshot(chain,pair)
        except Exception as exc:
            report["chains"][chain]={"status":"INCOMPLETE_CHAIN_SOURCE", "error_type":type(exc).__name__}
            report["errors"].append({"chain":chain,"error_type":type(exc).__name__})
        report["transcripts"][chain]=[c.transcript for c in pair]
    report["status"]=("ALL_THREE_CHAIN_ONCHAIN_INTERFACE_PARITY_SOURCE_ONLY" if
        all(x["status"]=="TWO_PUBLIC_SOURCE_PINNED_ATLAS_BOND_INTERFACE_PASS_NO_PRODUCTION_AUTHORITY"
            for x in report["chains"].values()) and len(report["chains"])==3
            else "INCOMPLETE_MULTI_CHAIN_SOURCE")
    (out/"atlas-bond-viability.json").write_bytes(canon(report))
    return report

if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--out",type=Path,required=True)
    args=p.parse_args()
    report=run(args.out)
    for chain,case in report["chains"].items():
        print("ATLAS",chain,case["status"],"gas_limit",case.get("deployed_solver_gas_limit"))
    print("NQC_FINAL",report["status"],"sponsor","NOT_PROVEN")
