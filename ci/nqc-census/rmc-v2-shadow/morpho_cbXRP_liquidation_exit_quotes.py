#!/usr/bin/env python3
"""NQC: one finite read-only DEX routing test, not historical captured P&L.

Three exact source-indexer Morpho cbXRP seizure amounts are sent ONLY to public
quote GET APIs KyberSwap and LI.FI. No signing, swaps, RPC writes, keys, wallets,
private subscription, retries or current/historical profit claims.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
from decimal import Decimal, localcontext
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

CHAIN=8453
COLLATERAL='0xcb585250f852c6c6bf90434ab21a00f02833a4af'
LOAN='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
MARKET='0xd4a903dc6d949519060c7707f9604fdc9772c046e05c2e3a8fce0bd7196e4109'
PARENT_SOURCE_GIT_BLOB='2f2e1839b97628d9d0f1d5705b69c1e003f0ca03'
ORIGINAL_INDEXED_CENSUS_ZIP_SHA256='f65c2b526fe93d105b096716515b4eac7b98698cb331048d3c6a8cf936b65ce4'
MAX_QUOTE_CALLS=6
BURN_ADDRESS='0x000000000000000000000000000000000000dEaD'  # data-agnostic placeholder, never a live sender
WAD=10**18
LIF=1126760563380281690
MIN_QUOTE_AMOUNT=1
MAX_U256=2**256-1
SAMPLES=(
    ('median-1event','0xf8d568c220710ee051d225112df92d78b6fb616764eda634337fa1b5e7aba3b2',186_502_312,165_653_805),
    ('upper-tail-4event','0x8556a70e6a3856038568d72c4f07a73a666e1ec8c7727b95f61a680a0b28b414',58_348_075_368,45_460_842_816),
    ('largest-11event','0x049327359c7be3409a6f0d2f2f0d1d41b32ba7d109d583be0bfe6c696932c0aa',154_844_072_724,123_660_088_593),
)
class Rejected(ValueError):pass
class SourceUnavailable(Exception):pass

def need(v,s):
    if not v:raise Rejected(s)

def uint(v,name):
    need(type(v) is str and bool(re.fullmatch(r'(0|[1-9][0-9]*)',v)),name+'_NOT_UINT_STRING')
    n=int(v);need(0<=n<=MAX_U256,name+'_OUT_OF_RANGE');return n

def money(raw):
    sign='-' if raw<0 else ''
    num=abs(raw)
    return sign+f'{num//1000000}.{num%1000000:06d}'

def source_admission(path):
    p=Path(path)
    need(p.is_file(),'PINNED_SOURCE_MISSING')
    data=p.read_bytes()
    header=b'blob '+str(len(data)).encode()+b'\0'
    import hashlib
    need(hashlib.sha1(header+data).hexdigest()==PARENT_SOURCE_GIT_BLOB,'PINNED_SOURCE_BLOB_MISMATCH')
    spec=importlib.util.spec_from_file_location('nqc_morpho_frozen_parent',p)
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
    need(mod.MARKET==MARKET and mod.SOURCE==ORIGINAL_INDEXED_CENSUS_ZIP_SHA256,'PARENT_ORIGIN_DRIFT')
    need(len(mod.S)==3,'PARENT_SAMPLE_COUNT_DRIFT')
    for _,tx,debt,seized in SAMPLES:
        need(tx in mod.S,'PARENT_TX_MISSING')
        rows=mod.S[tx][3]
        need(sum(x[1] for x in rows)==debt and sum(x[2] for x in rows)==seized,'PARENT_SAMPLE_AMOUNT_DRIFT')
    return {'original_parent_blob_sha1':PARENT_SOURCE_GIT_BLOB,
            'original_indexer_zip_sha256':ORIGINAL_INDEXED_CENSUS_ZIP_SHA256,
            'sample_count':len(SAMPLES),'source_sha256':sha256(data).hexdigest()}

def quote_url(provider,seized):
    need(type(seized) is int and seized>0,'INVALID_SEIZURE')
    if provider=='kyberswap':
        qs=urllib.parse.urlencode({'tokenIn':COLLATERAL,'tokenOut':LOAN,'amountIn':str(seized)})
        return 'https://aggregator-api.kyberswap.com/base/api/v1/routes?'+qs
    if provider=='lifi':
        qs=urllib.parse.urlencode({'fromChain':CHAIN,'toChain':CHAIN,'fromToken':COLLATERAL,'toToken':LOAN,
                'fromAmount':str(seized),'fromAddress':BURN_ADDRESS,
                'allowBridges':'none','slippage':'0.005','maxPriceImpact':'0.15','skipSimulation':'true'})
        return 'https://li.quest/v1/quote?'+qs
    raise Rejected('UNKNOWN_PROVIDER')

def get_json(provider,seized,timeout=22):
    url=quote_url(provider,seized)
    # Exactly one GET per provider + size. Never retry or use proxy RPC.
    req=urllib.request.Request(url,headers={'Accept':'application/json','User-Agent':'NQC-Public-DEX-ReadOnly-2026/1.0',
         **({'X-Client-Id':'nqc-research-readonly'} if provider=='kyberswap' else {})})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,req,fp,code,msg,headers,newurl):
            return None
    try:
        with urllib.request.build_opener(NoRedirect()).open(req,timeout=timeout) as r:
            if r.status!=200:raise SourceUnavailable('HTTP_'+str(r.status))
            raw=r.read(450_001)
            if len(raw)>450_000:raise SourceUnavailable('RESPONSE_TOO_LARGE')
    except urllib.error.HTTPError as e:
        raise SourceUnavailable('HTTP_'+str(e.code)) from e
    except (urllib.error.URLError,OSError,TimeoutError) as e:
        raise SourceUnavailable('NETWORK_'+type(e).__name__) from e
    try:
        payload=json.loads(raw,parse_constant=lambda _: (_ for _ in ()).throw(ValueError('json nan')))
    except (ValueError,UnicodeDecodeError) as e:
        raise SourceUnavailable('MALFORMED_JSON') from e
    need(type(payload) is dict,'NONOBJECT_QUOTE')
    return payload,sha256(raw).hexdigest()

def validate_kyber(data,amount):
    need(isinstance(data,dict),'KYBER_WRONG_ROOT')
    need(str(data.get('code')) in ('0','1'),'KYBER_CODE') # Current Kyber success 0/1 across variants
    item=data.get('data')
    need(type(item) is dict and type(item.get('routeSummary')) is dict,'KYBER_MISSING_ROUTE')
    row=item['routeSummary']
    need(str(row.get('tokenIn','')).lower()==COLLATERAL and str(row.get('tokenOut','')).lower()==LOAN,'KYBER_PAIR_MISMATCH')
    need(uint(row.get('amountIn'),'KYBER_INPUT')==amount,'KYBER_AMOUNT_MISMATCH')
    out=uint(row.get('amountOut'),'KYBER_OUTPUT')
    need(out>0,'KYBER_NO_OUTPUT')
    gas=row.get('gasUsd')
    if gas is not None:need(bool(re.fullmatch(r'[0-9]+(?:\.[0-9]+)?',str(gas))),'KYBER_GASUSD_FORMAT')
    return {'amount_out_usdc_raw':str(out),'gas_usd_provider_estimate':str(gas) if gas is not None else None,
        'indexer_quote_timestamp':str(row.get('timestamp')) if row.get('timestamp') else None,
        'route_has_steps':isinstance(row.get('route'),list) and bool(row['route'])}

def validate_lifi(data,amount):
    need(isinstance(data,dict),'LIFI_WRONG_ROOT')
    action=data.get('action');est=data.get('estimate')
    need(type(action) is dict and type(est) is dict,'LIFI_MISSING_ACTION_ESTIMATE')
    need(action.get('fromChainId')==CHAIN and action.get('toChainId')==CHAIN,'LIFI_WRONG_CHAIN')
    frm=action.get('fromToken');to=action.get('toToken')
    need(type(frm) is dict and type(to) is dict,'LIFI_NO_TOKENS')
    need(str(frm.get('address','')).lower()==COLLATERAL and str(to.get('address','')).lower()==LOAN,'LIFI_PAIR_MISMATCH')
    need(frm.get('decimals')==6 and to.get('decimals')==6,'LIFI_DECIMALS_MISMATCH')
    need(uint(action.get('fromAmount'),'LIFI_INPUT')==amount,'LIFI_AMOUNT_MISMATCH')
    out=uint(est.get('toAmount'),'LIFI_OUTPUT')
    mini=uint(est.get('toAmountMin'),'LIFI_MIN_OUTPUT')
    need(out>=mini>0,'LIFI_NO_OUTPUT_OR_BAD_MIN')
    # Skip simulation + placeholder may not be executable, always flag explicitly.
    return {'amount_out_usdc_raw':str(out),'amount_out_min_usdc_raw':str(mini),
        'provider_tool':str(data.get('tool')) if data.get('tool') else None,
        'gas_costs_reported':len(est.get('gasCosts',[])) if isinstance(est.get('gasCosts'),list) else None,
        'quote_uses_placeholder_sender':True,'quote_skips_sender_balance_simulation':True}

def parse(provider,data,amt):
    if provider=='kyberswap':return validate_kyber(data,amt)
    if provider=='lifi':return validate_lifi(data,amt)
    raise Rejected('UNKNOWN_PROVIDER')

def produce(parent_path, fetch=get_json):
    auth=source_admission(parent_path)
    snap=datetime.now(timezone.utc).isoformat()
    rows=[];errors=[];count=0;blocked_providers=set()
    for name,tx,debt,seized in SAMPLES:
        with localcontext() as ctx:
            ctx.prec=36
            breakeven=format((Decimal(debt)/Decimal(seized)).quantize(Decimal('0.00000001')),'f')
        entry={'name':name,'historical_tx':tx,'debt_repaid_usdc_raw':str(debt),
               'historical_seized_cbxrp_raw_from_single_indexer':str(seized),
               'historical_break_even_price_usdc_per_cbxrp_ex_costs':breakeven,
               'break_even_ratio_numerator_repaid_raw':str(debt),
               'break_even_ratio_denominator_seized_raw':str(seized),
               'providers':{},'real_historical_dex_exit_proven':False,'real_nqc_capture_proven':False}
        for provider in ('kyberswap','lifi'):
            if provider in blocked_providers:
                entry['providers'][provider]={'status':'NO_ADMITTED_QUOTE','cause':'PROVIDER_DENIED_EARLIER_IN_RUN','do_not_retry_for_this_run':True}
                continue
            count+=1
            need(count<=MAX_QUOTE_CALLS,'TOO_MANY_QUOTES')
            try:
                data,digest=fetch(provider,seized)
                p=parse(provider,data,seized)
                p['raw_public_quote_sha256']=digest
                p['quoted_spread_before_all_unmeasured_gas_mev_flash_costs_usdc_raw']=str(int(p['amount_out_usdc_raw'])-debt)
                entry['providers'][provider]={'status':'UNEXECUTED_FRESH_INDEXED_QUOTE_ONLY',**p}
            except (SourceUnavailable,Rejected) as e:
                msg=str(e) if isinstance(e,Rejected) else str(e)
                entry['providers'][provider]={'status':'NO_ADMITTED_QUOTE','cause':msg}
                errors.append({'size':name,'provider':provider,'error':msg})
                # Per-provider HTTP402/403/429 blocks remaining calls to that provider without trying again.
                if msg in ('HTTP_402','HTTP_403','HTTP_429'):
                    entry['providers'][provider]['do_not_retry_for_this_run']=True
                    blocked_providers.add(provider)
                    # Disable for all remaining samples; do not retry or switch endpoints/identities.
        rows.append(entry)
    # Purposefully any source failure remains explicit; never treat unknown = zero output.
    admitted=sum(sum(p.get('status')=='UNEXECUTED_FRESH_INDEXED_QUOTE_ONLY' for p in row['providers'].values()) for row in rows)
    status='FRESH_QUOTE_SNAPSHOT_SOURCE_ONLY' if admitted==6 else 'INCOMPLETE_PUBLIC_DEX_QUOTES'
    return {'status':status,'source':auth,'snapshot_started_utc':snap,'network_http_calls':count,
        'quotes_admitted':admitted,'quotes_possible':6,'selected_historical_cases':rows,'errors':errors,
        'quoted_output_is_not_historical_quote':True,'quote_is_not_signed_or_executable_proof':True,
        'guaranteed_nqc_profit_usdc':'0','realized_nqc_pnl_usd':'0',
        'native_gas_sponsor_proven':False,'builder_inclusion_proven':False,
        'competitive_winning_probability_proven':False,'historical_oracle_Dex_price_parity_proven':False,
        'historical_full_receipt_parity_proven':False}

def main():
    p=argparse.ArgumentParser();p.add_argument('--parent',required=True);p.add_argument('--out',required=True);a=p.parse_args()
    path=Path(a.out);path.parent.mkdir(parents=True,exist_ok=True)
    try:result=produce(a.parent)
    except Rejected as e:
        result={'status':'REJECTED_SOURCE_INVARIANT','cause':str(e),'realized_nqc_pnl_usd':'0','native_gas_sponsor_proven':False}
    path.write_text(json.dumps(result,sort_keys=True,indent=2)+'\n')
    print('NQC_SOURCE_QUOTE_STATUS',result['status'],'quotes_admitted',result.get('quotes_admitted',0))
    return 0
if __name__=='__main__':sys.exit(main())
