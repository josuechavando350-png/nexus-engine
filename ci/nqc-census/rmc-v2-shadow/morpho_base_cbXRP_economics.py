#!/usr/bin/env python3
"""NQC Base Morpho source-only canonical witnesses; NO NET P&L, NO RPC WRITES."""
import argparse, hashlib, json, re, sys, time, urllib.request, urllib.error
from pathlib import Path
BASE=8453
MORPHO="0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"
MARKET="0xd4a903dc6d949519060c7707f9604fdc9772c046e05c2e3a8fce0bd7196e4109"
SOURCE="f65c2b526fe93d105b096716515b4eac7b98698cb331048d3c6a8cf936b65ce4"
WAD=10**18
URLS=("https://mainnet.base.org","https://base-rpc.publicnode.com")
# Three hindsight-frozen transaction samples from original PR741 indexed events.
S={
"0x049327359c7be3409a6f0d2f2f0d1d41b32ba7d109d583be0bfe6c696932c0aa":
(52310057,1791409461,"0xbd0dd817c608e552d5f1ae701ab6c4da4fb00005",
[(1060,130753077133,104420768711),(1070,20111989455,16061644170),(1080,2445750947,1953202168),
 (1090,774115658,618216822),(1100,256840009,205115103),(1110,154513334,123395956),
 (1120,96071080,76723363),(1130,85661486,68410153),(1140,62165560,49646062),
 (1150,52779726,42150437),(1160,51108336,40815648)]),
"0xf8d568c220710ee051d225112df92d78b6fb616764eda634337fa1b5e7aba3b2":
(51357175,1789503697,"0xcee740502c9e84118e4a13efc085dff70784863d",[(981,186502312,165653805)]),
"0x8556a70e6a3856038568d72c4f07a73a666e1ec8c7727b95f61a680a0b28b414":
(52274578,1791338503,"0xd12810b19b596347a3afac206d3ca65d08594b3f",
 [(11,30987327206,24143212996),(15,26684262353,20790558196),(19,648469853,505243502),(23,28015956,21828122)])}
class Incomplete(Exception):pass
def need(ok,why):
 if not ok:raise Incomplete(why)
RC=(1,0x8082,0x800000000000808a,0x8000000080008000,0x808b,0x80000001,0x8000000080008081,0x8000000000008009,0x8a,0x88,0x80008009,0x8000000a,0x8000808b,0x800000000000008b,0x8000000000008089,0x8000000000008003,0x8000000000008002,0x8000000000000080,0x800a,0x800000008000000a,0x8000000080008081,0x8000000000008080,0x80000001,0x8000000080008008)
R=((0,36,3,41,18),(1,44,10,45,2),(62,6,43,15,61),(28,55,25,21,56),(27,20,39,8,14))
def keccak(s):
 x=bytearray(s)+b"\x01"
 while len(x)%136!=135:x.append(0)
 x.append(0x80);a=[0]*25;mask=(1<<64)-1
 def rol(v,n):return ((v<<n)|(v>>(64-n)))&mask if n else v
 for off in range(0,len(x),136):
  for i in range(17):a[i]^=int.from_bytes(x[off+i*8:off+i*8+8],"little")
  for rc in RC:
   c=[a[i]^a[i+5]^a[i+10]^a[i+15]^a[i+20] for i in range(5)]
   for i in range(5):
    d=c[(i-1)%5]^rol(c[(i+1)%5],1)
    for j in range(5):a[i+5*j]^=d
   b=[0]*25
   for i in range(5):
    for j in range(5):b[j+5*((2*i+3*j)%5)]=rol(a[i+5*j],R[i][j])
   for i in range(5):
    for j in range(5):a[i+5*j]=b[i+5*j]^((~b[(i+1)%5+5*j])&b[(i+2)%5+5*j])
   a[0]^=rc
 return b"".join(a[i].to_bytes(8,"little") for i in range(4))
def sig(text):return "0x"+keccak(text.encode()).hex()
LIQ=sig("Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)")
XFER=sig("Transfer(address,address,uint256)")
GET="0x"+keccak(b"idToMarketParams(bytes32)").hex()[:8]
def h(s):
 need(isinstance(s,str) and bool(re.fullmatch(r"0x[0-9a-fA-F]+",s)),"BAD_HEX")
 return int(s,16)
def ad(s):
 need(isinstance(s,str) and bool(re.fullmatch(r"0x[0-9a-fA-F]{64}",s)) and int(s[2:26],16)==0,"BAD_ADDRESS_TOPIC")
 return "0x"+s[-40:].lower()
def params(raw):
 need(isinstance(raw,str) and bool(re.fullmatch(r"0x[0-9a-fA-F]{320}",raw)),"NO_MARKET_PARAMS")
 words=[raw[2+64*i:2+64*(i+1)] for i in range(5)]
 need(all(int(w[:24],16)==0 for w in words[:4]),"MARKET_ADDRESS_PADDING")
 result=[("0x"+w[-40:]).lower() for w in words[:4]]
 ll=int(words[4],16)
 need(0<ll<WAD and all(int(v,16)>0 for v in result),"INVALID_LLTV_OR_MARKET")
 need("0x"+keccak(bytes.fromhex(raw[2:])).hex()==MARKET,"MARKET_ID_MISMATCH")
 return {"loan":result[0],"collateral":result[1],"oracle":result[2],"irm":result[3],"lltv":ll}
def lif(ll):
 need(type(ll)==int and 0<ll<WAD,"INVALID_LLTV")
 return min(115*10**16,WAD**2//(WAD-(3*10**17*(WAD-ll)//WAD)))
def decode_liq(log):
 top=log["topics"];data=log["data"]
 need(len(top)==4 and top[0].lower()==LIQ and top[1].lower()==MARKET,"INVALID_LIQ_EVENT")
 need(bool(re.fullmatch(r"0x[0-9a-fA-F]{320}",data)),"BAD_LIQ_DATA")
 nums=[int(data[2+i*64:2+(i+1)*64],16) for i in range(5)]
 return (h(log["logIndex"]),nums[0],nums[2],ad(top[2]),nums[3])
def verify(receipt,tx,record,market):
 block,ts,caller,original=record
 need(receipt["transactionHash"].lower()==tx and h(receipt["blockNumber"])==block and h(receipt["status"])==1,"INVALID_RECEIPT")
 logs=receipt["logs"]
 morpho=[decode_liq(log) for log in logs if log["address"].lower()==MORPHO and len(log["topics"])==4 and log["topics"][0].lower()==LIQ and log["topics"][1].lower()==MARKET]
 need(len(morpho)==len(original),"MISSING_OR_EXTRA_LIQUIDATE")
 need(sorted((i,r,s) for i,r,s,_,_ in morpho)==sorted(original),"INDEXER_OR_CHAIN_EVENT_MISMATCH")
 need(all(caller==c and bad==0 for _,_,_,c,bad in morpho),"CALLER_OR_BAD_DEBT_CONFLICT")
 debt=sum(r for _,r,_,_,_ in morpho);col=sum(s for _,_,s,_,_ in morpho)
 paid=received=0
 for log in logs:
  top=log.get("topics",[])
  if len(top)!=3 or top[0].lower()!=XFER:continue
  val=h(log["data"]);origin=ad(top[1]);dest=ad(top[2]);token=log["address"].lower()
  if token==market["loan"] and origin==caller and dest==MORPHO:paid+=val
  if token==market["collateral"] and origin==MORPHO and dest==caller:received+=val
 need(paid>=debt and received>=col,"ERC20_SETTLEMENT_UNVERIFIED")
 gas=h(receipt["gasUsed"])*h(receipt["effectiveGasPrice"])
 return {"hash":tx,"block":block,"oracle_debt_repaid_raw":str(debt),"collateral_received_raw":str(col),
 "liquidation_count":len(morpho),"erc20_repay_to_morpho_raw":str(paid),"erc20_collateral_to_caller_raw":str(received),
 "gas_used":h(receipt["gasUsed"]),"execution_gas_wei":str(gas),
 "l1_fee_wei_observed":str(h(receipt["l1Fee"])) if receipt.get("l1Fee") else None,
 "transaction_from":receipt["from"].lower(),"liquidator_contract":caller,
 "dex_exit_proven":False,"net_profit_proven":False}
class Provider:
 def __init__(self,url):self.url=url;self.n=0
 def ask(self,method,values):
  need(method in ("eth_chainId","eth_getCode","eth_call","eth_getBlockByNumber","eth_getTransactionReceipt","eth_getTransactionByHash"),"WRITE_RPC_FORBIDDEN")
  self.n+=1;need(self.n<=30,"RPC_CALL_LIMIT")
  body=json.dumps({"jsonrpc":"2.0","id":self.n,"method":method,"params":values}).encode()
  req=urllib.request.Request(self.url,body,{"Content-Type":"application/json","User-Agent":"NQC-ReadOnly-Morpho-Economic-2026"})
  try:
   with urllib.request.urlopen(req,timeout=13) as resp:
    need(resp.status==200,"HTTP_STATUS_DENIED")
    ans=json.loads(resp.read(2000000))
  except (urllib.error.HTTPError,urllib.error.URLError,TimeoutError,OSError,ValueError) as e:
   raise Incomplete("RPC_SOURCE_"+type(e).__name__) from e
  need(isinstance(ans,dict) and ans.get("id")==self.n and not ans.get("error") and ans.get("result") is not None,"RPC_REJECTED_OR_NULL")
  time.sleep(0.08)
  return ans["result"]
def quorum(a,b,keys,why):
 need(all(a.get(x)==b.get(x) for x in keys),why)
def run():
 a,b=(Provider(url) for url in URLS)
 need(h(a.ask("eth_chainId",[]))==BASE and h(b.ask("eth_chainId",[]))==BASE,"CHAIN_MISMATCH")
 block=hex(min(r[0] for r in S.values()))
 c1=a.ask("eth_getCode",[MORPHO,block]);c2=b.ask("eth_getCode",[MORPHO,block])
 need(c1==c2 and len(c1)>100,"MORPHO_RUNTIME_DIVERGENCE")
 calldata=GET+MARKET[2:]
 m1=a.ask("eth_call",[{"to":MORPHO,"data":calldata},block])
 m2=b.ask("eth_call",[{"to":MORPHO,"data":calldata},block])
 need(m1==m2,"MORPHO_MARKET_PARAMS_DIVERGENCE")
 market=params(m1);dec={}
 for label,key in (("loan","loan"),("collateral","collateral")):
  token=market[key]
  u=a.ask("eth_call",[{"to":token,"data":"0x313ce567"},block])
  v=b.ask("eth_call",[{"to":token,"data":"0x313ce567"},block])
  need(u==v and 0<=h(u)<=18,"TOKEN_DECIMALS_DIVERGENCE")
  dec[label]=h(u)
 need(dec["loan"]==6,"USDC_DECIMALS_NOT_SIX")
 out=[]
 for tx,original in S.items():
  number,timestamp=original[:2];tag=hex(number)
  head1=a.ask("eth_getBlockByNumber",[tag,False]);head2=b.ask("eth_getBlockByNumber",[tag,False])
  quorum(head1,head2,("number","hash","parentHash","stateRoot","receiptsRoot","timestamp"),"BLOCK_HEADER_CONFLICT")
  need(h(head1["timestamp"])==timestamp,"INDEXER_TIME_BLOCK_CONFLICT")
  r1=a.ask("eth_getTransactionReceipt",[tx]);r2=b.ask("eth_getTransactionReceipt",[tx])
  quorum(r1,r2,("transactionHash","blockHash","blockNumber","status","gasUsed","effectiveGasPrice","logs"),"RECEIPT_CANONICAL_CONFLICT")
  need(r1["blockHash"].lower()==head1["hash"].lower(),"RECEIPT_REORG")
  t1=a.ask("eth_getTransactionByHash",[tx]);t2=b.ask("eth_getTransactionByHash",[tx])
  quorum(t1,t2,("hash","blockHash","blockNumber","from","to","transactionIndex"),"TX_CANONICAL_CONFLICT")
  need(t1["blockHash"].lower()==head1["hash"].lower() and t1["from"].lower()==r1["from"].lower(),"TX_SENDER_CONFLICT")
  row=verify(r1,tx,original,market)
  row["block_hash"]=head1["hash"].lower()
  row["oracle_incentive_loan_raw_floor"]=str(int(row["oracle_debt_repaid_raw"])*(lif(market["lltv"])-WAD)//WAD)
  out.append(row)
 return {"status":"CANONICAL_SELECTED_THREE_NOT_PROFIT","source_zip_sha256":SOURCE,"market_id":MARKET,
   "morpho_code_sha256":hashlib.sha256(bytes.fromhex(c1[2:])).hexdigest(),
   "market_params":market,"token_decimals":dec,"lif_wad":str(lif(market["lltv"])),
   "selected_transactions":out,"read_only_calls":[a.n,b.n],"full_market_30day_proven":False,
   "dex_exit_proven":False,"net_profit_proven":False,"external_gas_payer_proven":False,"nqc_pnl_usd":"0"}
def main():
 parser=argparse.ArgumentParser();parser.add_argument("--out",required=True);args=parser.parse_args()
 out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
 try:result=run()
 except Incomplete as e:
  result={"status":"INCOMPLETE_CANONICAL_SELECTED_THREE","source_error":str(e),
    "source_zip_sha256":SOURCE,"selected_transactions":[],"net_profit_proven":False,
    "external_gas_payer_proven":False,"nqc_pnl_usd":"0"}
 (out/"canonical-liquidation-audit.json").write_text(json.dumps(result,sort_keys=True,indent=2))
 print(result["status"],result.get("source_error",""),"selected",len(result["selected_transactions"]))
if __name__=="__main__":main()
