#!/usr/bin/env python3
"""One-shot public OpenOcean Base cbXRP->USDC route quotes. NOT executions or historical payouts."""
import argparse,json,hashlib,re,time,sys,urllib.parse,urllib.request,urllib.error
from pathlib import Path

ENDPOINT="https://open-api.openocean.finance/v4/8453/quote"
CBXRP="0xcb585250f852c6c6bf90434ab21a00f02833a4af"
USDC="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
FROZEN_TX="0x049327359c7be3409a6f0d2f2f0d1d41b32ba7d109d583be0bfe6c696932c0aa"
# Last size = actual *indexed* collateral value of one preselected historical Morpho tx.
# NOT currently owned by NQC and NOT an executable liquidation now.
AMOUNTS_RAW=(1000*10**6,10000*10**6,100000*10**6,123660088593)
GAS_WEI=100_000_000 # fixed assumed routing input, NOT current chain gas fee
class Refused(Exception):pass
def need(cond,code):
 if not cond:raise Refused(code)
def uint(s):
 need(isinstance(s,str) and re.fullmatch(r"[0-9]+",s) is not None,"QUOTE_NONINTEGER")
 n=int(s)
 need(0<n<(1<<256),"QUOTE_AMOUNT_OOB")
 return n
def strict_quote(obj,amount):
 need(isinstance(obj,dict) and obj.get("code")==200,"QUOTE_NO_SUCCESS")
 d=obj.get("data")
 need(isinstance(d,dict),"QUOTE_NO_DATA")
 x,y=d.get("inToken"),d.get("outToken")
 need(isinstance(x,dict) and isinstance(y,dict),"QUOTE_TOKEN_MISSING")
 need(str(x.get("address","")).lower()==CBXRP and str(y.get("address","")).lower()==USDC,"QUOTE_WRONG_ASSET")
 need(x.get("decimals")==6 and y.get("decimals")==6,"QUOTE_WRONG_DECIMALS")
 need(uint(str(d.get("inAmount")))==amount,"QUOTE_WRONG_INPUT")
 out=uint(str(d.get("outAmount")))
 gas=d.get("estimatedGas")
 if gas is not None:
  need(str(gas).isdecimal(),"BAD_ESTIMATED_GAS")
  gas=str(gas)
 return {"cbxrp_input_raw":str(amount),"usdc_output_raw":str(out),
         "output_per_cbXRP_micro_usdc_floor":str(out*10**6//amount),
         "estimated_swap_gas_units_api":gas,
         "aggregator_price_impact_reported":str(d.get("price_impact","UNKNOWN")),
         "dex_routes_reported_count":len(d.get("dexes",[])) if isinstance(d.get("dexes"),list) else None}
def quote_url(amount):
 need(type(amount) is int and amount in AMOUNTS_RAW,"UNKNOWN_QUOTE_SIZE")
 q={"inTokenAddress":CBXRP,"outTokenAddress":USDC,
    "amountDecimals":str(amount),"gasPriceDecimals":str(GAS_WEI),"slippage":"1"}
 return ENDPOINT+"?"+urllib.parse.urlencode(q)
class DenyRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  raise Refused("QUOTE_REDIRECT_FORBIDDEN")
def fetch_one(amount):
 url=quote_url(amount)
 req=urllib.request.Request(url,headers={"User-Agent":"NQC-V2-Unfunded-ReadOnly-QuoteProbe/1.0","Accept":"application/json"})
 op=urllib.request.build_opener(DenyRedirect)
 try:
  with op.open(req,timeout=24) as f:
   need(f.status==200,"QUOTE_HTTP_STATUS")
   raw=f.read(600000)
 except urllib.error.HTTPError as e:
  raise Refused("QUOTE_HTTP_"+str(e.code)) from e
 except (OSError,TimeoutError,urllib.error.URLError) as e:
  raise Refused("QUOTE_TRANSPORT_"+type(e).__name__) from e
 try:
  data=json.loads(raw)
 except (ValueError,UnicodeError) as e:
  raise Refused("QUOTE_BAD_JSON") from e
 row=strict_quote(data,amount)
 row["response_sha256"]=hashlib.sha256(raw).hexdigest()
 return row
def envelope(results):
 need(isinstance(results,list) and len(results)==len(AMOUNTS_RAW),"QUOTE_NOT_ALL_SIZES")
 need([int(r["cbxrp_input_raw"]) for r in results]==list(AMOUNTS_RAW),"QUOTE_SIZES_CHANGED")
 ref=int(results[0]["usdc_output_raw"]); ref_amount=AMOUNTS_RAW[0]
 need(ref>0,"QUOTE_REF_ZERO")
 for row in results:
  amount=int(row["cbxrp_input_raw"]); out=int(row["usdc_output_raw"])
  # Percent deviation in UNIT output relative to smallest quote (could be negative).
  bps=10000-(out*ref_amount*10000//(amount*ref))
  row["relative_unit_price_deterioration_bps_vs_1000_cbxrp"]=bps
 return {"status":"FOUR_CURRENT_ROUTE_QUOTES_NOT_HISTORICAL_EXECUTION",
   "quotes":results,"source_provider":"OpenOcean public API Base 8453",
   "not_block_pinned_or_redeemable":True,"not_oracle_historical_parity":True,
   "not_net_profit_or_forward_inclusion":True,"all_quotes_same_timestamp_proven":False,
   "quote_size_unit":"6 decimal cbXRP","quoted_asset":"USDC 6 decimal",
   "historical_frozen_sample_tx":FROZEN_TX,
   "realized_nqc_pnl_usd":"0","gas_sponsor_proven":False}
def run():
 rows=[]
 for i,amount in enumerate(AMOUNTS_RAW):
  if i:time.sleep(1.25)
  rows.append(fetch_one(amount))
 return envelope(rows)
def main():
 p=argparse.ArgumentParser();p.add_argument("--out",required=True);a=p.parse_args()
 dest=Path(a.out);dest.mkdir(parents=True,exist_ok=True)
 try:
  result=run()
 except Refused as e:
  result={"status":"INCOMPLETE_PUBLIC_OPENOCEAN_QUOTES","error":str(e),
   "quotes":[],"not_net_profit_or_forward_inclusion":True,
   "realized_nqc_pnl_usd":"0","gas_sponsor_proven":False}
 (dest/"openocean-four-size-route-quote.json").write_text(json.dumps(result,sort_keys=True,indent=2))
 print(result["status"],result.get("error",""),"rows",len(result["quotes"]))
if __name__=="__main__":sys.exit(main())
