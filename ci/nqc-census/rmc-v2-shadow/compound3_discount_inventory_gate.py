#!/usr/bin/env python3
"""Compound III cUSDCv3 same-block REAL reserve-eligibility census, NO TRADE.

Gate independently checks 2 public Ethereum RPCs, exact Comet v3 deployment,
market reserves vs target, pause status and supported collaterals. Positive gate
only means protocol could accept discounted collateral sale at this block, NOT
DEX profit, available Morpho-USDC flash, gas sponsor, or capture probability.
"""
from __future__ import annotations
import argparse,json,re,hashlib,time,urllib.request,urllib.error,sys
from datetime import datetime,timezone
from pathlib import Path

CHAIN=1
COMET='0xc3d688b66703497daa19211eedff47f25384cdc3'
USDC='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
PROVIDERS=('https://ethereum-rpc.publicnode.com','https://eth.drpc.org')
S={'getReserves':'0902f1ac','targetReserves':'32176c49','numAssets':'a46fe83b','getAssetInfo':'c8c7fe6b','getCollateralReserves':'9ff567f8','quoteCollateral':'7ac88ed1','baseToken':'c55dae63','isBuyPaused':'d8e5f611'}
MAX_ASSETS=24
MAX_RPC_CALLS=84
QUOTE_USDC_RAW=1000*10**6
class Incomplete(ValueError):pass
def need(ok,why):
 if not ok:raise Incomplete(why)
def hexi(s,label):
 need(type(s) is str and bool(re.fullmatch(r'0x[0-9a-fA-F]+',s)),'BAD_HEX_'+label)
 return int(s,16)
def word(s,label):
 need(type(s) is str and bool(re.fullmatch(r'0x[0-9a-fA-F]{64}',s)),'BAD_WORD_'+label)
 return int(s,16)
def signed(raw):
 x=word(raw,'SIGNED')
 return x-2**256 if x >= 2**255 else x
def uint_word(v,label,bits=256):
 x=word(v,label)
 need(x<2**bits,'WORD_RANGE_'+label)
 return x
def addr_word(raw,label):
 n=uint_word(raw,label)
 need(n < 2**160,'INVALID_ADDRESS_WORD_'+label)
 return '0x'+format(n,'040x')
def format_addr(a):
 need(type(a) is str and bool(re.fullmatch(r'0x[0-9a-fA-F]{40}',a)),'BAD_ADDRESS')
 return a.lower()
def enc_uint(n):
 need(type(n) is int and 0<=n<2**256,'BAD_UINT_ENCODING')
 return format(n,'064x')
def enc_addr(a):
 return format(int(format_addr(a),16),'064x')
def selector(name,*args):
 need(name in S,'NON_VIEW_METHOD_FORBIDDEN')
 if name=='getAssetInfo':need(len(args)==1 and type(args[0]) is int and 0<=args[0]<MAX_ASSETS,'ASSET_INDEX_CAP')
 elif name=='getCollateralReserves':need(len(args)==1,'ASSET_ARG')
 elif name=='quoteCollateral':need(len(args)==2 and args[1]==QUOTE_USDC_RAW,'QUOTE_SIZE_CHANGED')
 else:need(not args,'UNEXPECTED_ARGS')
 a=''.join(enc_uint(v) if type(v) is int else enc_addr(v) for v in args)
 return '0x'+S[name]+a
class Provider:
 def __init__(self,url):
  need(url in PROVIDERS,'UNAPPROVED_RPC_URL')
  self.url=url;self.n=0
 def ask(self,method,args):
  need(method in ('eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getCode','eth_call'),'WRITE_RPC_FORBIDDEN')
  self.n+=1;need(self.n<=MAX_RPC_CALLS,'RPC_BUDGET_EXHAUSTED')
  payload=json.dumps({'jsonrpc':'2.0','id':self.n,'method':method,'params':args},separators=(',',':')).encode()
  req=urllib.request.Request(self.url,payload,headers={'Content-Type':'application/json','User-Agent':'NQC-CompoundIII-Discount-ReadOnly/1.0'},method='POST')
  try:
   with urllib.request.urlopen(req,timeout=15) as r:
    need(r.status==200,'RPC_HTTP_UNEXPECTED')
    raw=r.read(1000001)
    need(len(raw)<1000001,'RPC_RESPONSE_TOO_LARGE')
    doc=json.loads(raw)
  except urllib.error.HTTPError as e:raise Incomplete('RPC_HTTP_'+str(e.code)+'_'+method) from e
  except (TimeoutError,OSError,ValueError,urllib.error.URLError) as e:raise Incomplete('RPC_TRANSPORT_'+type(e).__name__+'_'+method) from e
  need(type(doc) is dict and doc.get('id')==self.n and not doc.get('error') and doc.get('result') is not None,'RPC_NULL_OR_ERROR_'+method)
  time.sleep(.10)
  return doc['result']
 def block(self,height):return self.ask('eth_getBlockByNumber',[hex(height),False])
 def get(self,name,height,*args):
  tx={'to':COMET,'data':selector(name,*args)}
  try:return self.ask('eth_call',[tx,hex(height)])
  except Incomplete as e:raise Incomplete('CALL_'+name+'_'+str(e)) from e

def asset_info(raw,ix):
 need(type(raw) is str and bool(re.fullmatch(r'0x[0-9a-fA-F]{512}',raw)),'BAD_ASSET_INFO_ABI')
 w=['0x'+raw[2+64*i:2+(i+1)*64] for i in range(8)]
 need(uint_word(w[0],'offset',8)==ix,'ASSET_INFO_OFFSET_DRIFT')
 asset=addr_word(w[1],'token');feed=addr_word(w[2],'feed')
 need(int(asset,16)!=0 and int(feed,16)!=0,'ASSET_OR_PRICE_FEED_ZERO')
 scale=uint_word(w[3],'scale',64)
 need(scale>0 and scale in (10**6,10**8,10**18),'ASSET_DECIMALS_UNRECOGNIZED')
 for v in w[4:7]:need(uint_word(v,'factor',64)<10**18,'INVALID_COLLATERAL_FACTOR')
 return {'offset':ix,'asset':asset,'price_feed':feed,'scale':scale,
         'borrow_factor_wad':str(uint_word(w[4],'borrow',64)),
         'liquidation_factor_wad':str(uint_word(w[6],'liquidation',64)),
         'supply_cap_raw':str(uint_word(w[7],'supplyCap',128))}

def block_identity(a,b):
 keys=('number','hash','parentHash','stateRoot','receiptsRoot','timestamp')
 need(type(a) is dict and type(b) is dict,'BAD_BLOCK_OBJECT')
 for k in keys:need(a.get(k) is not None and a[k]==b.get(k),'BLOCK_IDENTITY_DIVERGENCE_'+k)
 need(hexi(a['number'],'number')>0,'ZERO_BLOCK')
 return {k:a[k] for k in keys}

def source_value_quorum(a,b,label):
 need(type(a) is str and type(b) is str and a.lower()==b.lower(),'PROVIDER_DIVERGENCE_'+label)
 return a

def gate(reserve,target,paused,assets):
 need(type(reserve) is int and type(target) is int and type(paused) is bool and isinstance(assets,list),'GATE_TYPES')
 need(target>=0,'TARGET_NEGATIVE')
 eligible=(reserve<target) and (not paused)
 positive=[a for a in assets if int(a.get('reserves_raw','0'))>0]
 actionable=eligible and bool(positive)
 return {'reserves_below_target':reserve<target,'buy_not_paused':not paused,
         'inventory_positive_assets':len(positive),
         'candidate_discount_purchase_allowed_on_snapshot':actionable,
         'candidate_assets_source_only':[x['asset'] for x in positive] if actionable else [],
         'explicit_no_available_buy_collateral_if_blocked':not actionable}

def utc():return datetime.now(timezone.utc).isoformat()
def attempt():
 ps=[Provider(x) for x in PROVIDERS]
 for p in ps:need(hexi(p.ask('eth_chainId',[]),'chain')==CHAIN,'WRONG_CHAIN')
 heights=[hexi(p.ask('eth_blockNumber',[]),'head') for p in ps]
 need(max(heights)-min(heights)<=4,'PROVIDER_HEAD_GAP')
 height=min(heights)
 headers=[p.block(height) for p in ps]
 bh=block_identity(*headers)
 code=[p.ask('eth_getCode',[COMET,hex(height)]) for p in ps]
 source_value_quorum(*code,'COMET_BYTECODE')
 need(len(code[0])>20,'EMPTY_COMET_CODE')
 pairs={}
 for name in ('getReserves','targetReserves','numAssets','baseToken','isBuyPaused'):
  v=[p.get(name,height) for p in ps]
  pairs[name]=source_value_quorum(*v,name)
 reserves=signed(pairs['getReserves'])
 target=uint_word(pairs['targetReserves'],'target')
 n=uint_word(pairs['numAssets'],'assets_count',8)
 need(n>0,'ZERO_ASSET_COUNT')
 need(addr_word(pairs['baseToken'],'baseToken')==USDC,'NON_USDC_COMET')
 paused=bool(uint_word(pairs['isBuyPaused'],'paused',8))
 # Compound III forbids buyCollateral if either global base-reserve condition
 # fails, irrespective of whether the market has 8 or 24 collateral tokens.
 # No asset enumeration is necessary or permitted for a negative GLOBAL gate.
 # Crucially, do not call a skipped collateral inventory ZERO.
 global_buy_gate_open=(reserves<target and not paused)
 # A second exact header witness certifies the global gate BEFORE riskier
 # collateral enumeration. If later provider queries fail, this checkpoint is
 # genuine two-provider same-block evidence, not a guessed partial inventory.
 early_tail=[p.block(height) for p in ps]
 block_identity(*early_tail);block_identity(headers[0],early_tail[0])
 checkpoint={'certified_global_gate_only':True,'block':bh,
             'reserve_base_signed_raw_usdc':str(reserves),
             'target_reserve_raw_usdc':str(target),
             'num_assets':n,'is_buy_paused':paused,
             'global_buy_gate_open':global_buy_gate_open,
             'full_collateral_inventory_certified':False,
             'dex_exit_quote_certified':False,'nqc_realized_profit_usd':'0'}
 assets=[]
 quotes=[]
 if global_buy_gate_open:
  try:
   need(n<=MAX_ASSETS,'ASSET_ENUMERATION_OUTSIDE_CAP')
   for ix in range(n):
    info=source_value_quorum(*(p.get('getAssetInfo',height,ix) for p in ps),'asset_'+str(ix))
    a=asset_info(info,ix)
    bal=source_value_quorum(*(p.get('getCollateralReserves',height,a['asset']) for p in ps),'balance_'+str(ix))
    a['reserves_raw']=str(uint_word(bal,'collateral_reserves'))
    assets.append(a)
   decision=gate(reserves,target,paused,assets)
   decision['inventory_evaluated']=True
   for a in assets:
    if int(a['reserves_raw'])<=0:continue
    q=source_value_quorum(*(p.get('quoteCollateral',height,a['asset'],QUOTE_USDC_RAW) for p in ps),'quote_'+a['asset'])
    amount=uint_word(q,'quote_out')
    quotes.append({'collateral_asset':a['asset'],'usdc_in_raw':str(QUOTE_USDC_RAW),
                   'collateral_out_raw_at_quoted_block':str(amount),
                   'full_1000_usdc_purchase_has_sufficient_reserves':0<amount<=int(a['reserves_raw']),
                   'dex_sale_output_proven':False,'pnl_proven':False})
  except Incomplete as e:
   e.global_gate_checkpoint=checkpoint
   raise
 else:
  decision=gate(reserves,target,paused,[])
  decision['inventory_evaluated']=False
  decision['inventory_positive_assets']=None
  decision['explicit_no_available_buy_collateral_if_blocked']=False
  decision['source_global_gate_closed_without_inventory_claim']=True
  # Stop after verifying the canonical same-block global gate. This status
  # does not certify the existence OR absence of any collateral inventory.
 tail=[p.block(height) for p in ps]
 block_identity(*tail);block_identity(headers[0],tail[0])
 return {'status':('SAME_BLOCK_COMET_DISCOUNT_RESERVE_GATE_SOURCE_ONLY' if global_buy_gate_open else 'SAME_BLOCK_COMET_GLOBAL_BUY_GATE_CLOSED_SOURCE_ONLY'),
         'source_chain':'Ethereum mainnet 1','comet':COMET,'block':bh,'reserve_base_signed_raw_usdc':str(reserves),
         'target_reserve_raw_usdc':str(target),'asset_count':n,'collateral_inventory_was_fully_enumerated':global_buy_gate_open,'certified_global_gate':checkpoint,'assets':assets,
         'gate':decision,'quotes':quotes,
         'rpc_counts':[p.n for p in ps],
         'quote_is_not_own_capital_or_net_profit':True,
         'realized_nqc_pnl_usd':'0','independent_native_gas_sponsor_proven':False,
         'morpho_usdc_flash_capacity_proven':False,'nqc_executable_strategy_proven':False,
         'current_dex_selling_quotes_proven':False,'competitor_capture_proven':False,
         'user_mainnet_transaction_authorized':False,
         'commercial_promotion_allowed':False}

def main(argv=None):
 parser=argparse.ArgumentParser();parser.add_argument('--out',required=True);a=parser.parse_args(argv)
 p=Path(a.out);p.mkdir(parents=True,exist_ok=True)
 out={'status':'INCOMPLETE_COMPOUND_READONLY_RESERVES','realized_nqc_pnl_usd':'0',
      'commercial_promotion_allowed':False,'user_mainnet_transaction_authorized':False}
 try:out=attempt()
 except Incomplete as e:
  out['source_blocker']=str(e)
  if hasattr(e,'global_gate_checkpoint'):
   out['certified_global_gate']=e.global_gate_checkpoint
 except Exception as e:out['source_blocker']='UNEXPECTED_'+type(e).__name__
 out['observed_utc']=utc()
 (p/'discount-reserves.json').write_text(json.dumps(out,indent=2,sort_keys=True)+'\n')
 print(out['status'],'base_USDC_reserves',out.get('reserve_base_signed_raw_usdc'),
       'below_target',out.get('gate',{}).get('reserves_below_target'),
       'collateral_with_inventory',out.get('gate',{}).get('inventory_positive_assets'),
       'source_reason',out.get('source_blocker'))
 return 0
if __name__=='__main__':sys.exit(main())
