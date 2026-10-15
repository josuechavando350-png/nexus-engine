#!/usr/bin/env python3
"""Exactly one readonly Morpho public RPC authority for Base three frozen borrowers.

We do NOT assume oracle+STALE debt HF is a canonical liquidatable HF. The market
requires IRM accrual after lastUpdate. Never broadcast/sign, or retry denied RPC.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import time
import urllib.request,urllib.error
from decimal import Decimal
from morpho_base_cbXRP_economics import keccak,params as parse_original_morpho_params

MARKET='0xd4a903dc6d949519060c7707f9604fdc9772c046e05c2e3a8fce0bd7196e4109'
MORPHO='0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb'
LOAN='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
COLLATERAL='0xcb585250f852c6c6bf90434ab21a00f02833a4af'
URL='https://rpc.morpho.dev/realtime'
FROZEN_DIGEST='896c7fe20be3ba03d4a150d3784382c3678550d57d2ee00339c827da9ceae198'
FROZEN_FILE_SHA256='a739994c1d6e7bfa4e22c06a114b0a632928962af9a0d59616667503b18980c3'
CANDIDATE_NO=3
WAD=10**18
SCALE=10**36
MAX_CALLS=12
ALLOWED=('eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call')

class Missing(ValueError): pass
def require(ok,name):
    if not ok:raise Missing(name)
def timestamp():return datetime.now(timezone.utc).isoformat()
def stable(x):return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def hashobj(x):return sha256(stable(x).encode()).hexdigest()
def write(p,x):p.write_text(json.dumps(x,sort_keys=True,indent=2)+'\n')
def unsignedhex(x,label):
    require(type(x) is str and bool(re.fullmatch(r'0x[0-9a-fA-F]+',x)),label+'_HEX')
    return int(x,16)
def byteswords(ret,count,label):
    require(type(ret) is str and bool(re.fullmatch(r'0x[0-9a-fA-F]{'+str(count*64)+'}',ret)),label+'_ABI_SHAPE')
    return [int(ret[2+i*64:2+(i+1)*64],16) for i in range(count)]
def selector(fn):return '0x'+keccak(fn.encode()).hex()[:8]
def word(v):
    require(type(v) is int and 0<=v<2**256,'INVALID_WORD')
    return format(v,'064x')

def contract_data(method,id=MARKET,user=None):
    data=selector(method)+id[2:]
    if user is not None:
        require(type(user) is str and bool(re.fullmatch(r'0x[0-9a-f]{40}',user)),'INVALID_BORROWER')
        data+=word(int(user[2:],16))
    return data

def select_original(b):
    require(sha256(b).hexdigest()==FROZEN_FILE_SHA256,'SOURCE_FROZEN_RAW_HASH_MISMATCH')
    try:d=json.loads(b)
    except ValueError as e:raise Missing('SOURCE_FROZEN_JSON') from e
    require(hashobj(d)==FROZEN_DIGEST,'SOURCE_FROZEN_CANONICAL_HASH_MISMATCH')
    require(d['market_id']==MARKET and d['chain_id']==8453 and d['cohort_size']==60 and len(d['cohort'])==60,'WRONG_SOURCE_COHORT')
    need=[]
    for row in d['cohort']:
        require(type(row.get('borrower')) is str and bool(re.fullmatch(r'0x[0-9a-f]{40}',row['borrower'])),'INVALID_ORIGINAL_ADDRESS')
        if 'near_hf_indexer' in row['cohort_sources']:
            amount=row.get('borrow_usd_api')
            require(type(amount) is str,'MISSING_PRICE_SOURCE')
            num=Decimal(amount)
            require(num.is_finite() and num>0,'INVALID_PRICE_SOURCE')
            need.append(row)
    require(len(need)>=CANDIDATE_NO,'INSUFFICIENT_PRECOMMITTED_SOURCE_CANDIDATES')
    return sorted(need,key=lambda x:(-Decimal(x['borrow_usd_api']),x['borrower']))[:CANDIDATE_NO]

def stale_abi(debt_shares, col, total_debt_assets,total_debt_shares,price,lltv):
    for x in (debt_shares,col,total_debt_assets,total_debt_shares,price,lltv):
        require(type(x) is int and 0<=x<2**256,'INVALID_AMOUNT')
    require(debt_shares>0 and col>0 and total_debt_shares>0 and price>0 and 0<lltv<WAD,'ZERO_OR_BAD_MARKET_AMOUNT')
    # Official Morpho Blue SharesMathLib: VIRTUAL_SHARES=1e6,
    # VIRTUAL_ASSETS=1, and toAssetsUp rounds up.
    current_stale=(debt_shares*(total_debt_assets+1)+(total_debt_shares+10**6-1))//(total_debt_shares+10**6)
    max_borrow_stale=(col*price//SCALE)*lltv//WAD
    hf_wad=max_borrow_stale*WAD//current_stale
    return {'stale_debt_asset_units':str(current_stale),'raw_oracle_max_borrow_asset_units':str(max_borrow_stale),
            'hf_wad_NO_IRM_ACCRUAL':str(hf_wad),
            'not_live_morpho_eligible':True}

class Rpc:
    def __init__(self,transport=None,out=None):self.transport=transport or self.http;self.out=out;self.calls=0
    @staticmethod
    def http(request):
        req=urllib.request.Request(URL,data=stable(request).encode(),method='POST',headers={'Content-Type':'application/json','User-Agent':'NQC-v2-morpho-readonly-source/1'})
        try:
            with urllib.request.urlopen(req,timeout=12) as response:
                require(response.status==200,'RPC_HTTP_STATUS_DENIED')
                b=response.read(400000)
                require(len(b)<400000,'RPC_RESPONSE_TOO_LARGE')
                return json.loads(b)
        except urllib.error.HTTPError as e:
            raise Missing('RPC_HTTP_'+str(e.code)) from e
        except (urllib.error.URLError,OSError,TimeoutError,ValueError) as e:
            raise Missing('RPC_TRANSPORT_'+type(e).__name__) from e
    def call(self,method,args):
        require(method in ALLOWED,'WRITE_METHOD_FORBIDDEN')
        self.calls+=1
        require(self.calls<=MAX_CALLS,'RPC_READ_BUDGET_EXHAUSTED')
        obj={'jsonrpc':'2.0','id':self.calls,'method':method,'params':args}
        res=self.transport(obj)
        if self.out is not None:
            write(self.out/('raw-rpc-%02d.json'%self.calls),{'query':obj,'response':res})
        require(type(res) is dict and res.get('id')==self.calls and res.get('jsonrpc')=='2.0' and not res.get('error') and res.get('result') is not None,'RPC_ERROR_OR_NULL_'+method)
        return res['result']

def execute(out,source,transport=None):
    out.mkdir(parents=True,exist_ok=True)
    report={'source':'ONE_EXTERNAL_PUBLIC_MORPHO_RPC_NOT_QUORUM','status':'INCOMPLETE_NO_ONCHAIN_RISK_AUTHORITY',
            'market_id':MARKET,'chain_id_target':8453,'started_utc':timestamp(),
            'realized_nqc_pnl_usd':'0','gas_sponsor_proven':False,'transactions_broadcast':0,
            'oracle_IRM_accrued_HF_proven':False,'block_pinned_success':False,
            'competitive_capture_proven':False,'authorizes_trade':False}
    rpc=Rpc(transport,out)
    write(out/'source-certification.json',{'original_artifact_outer_sha256':'37699eb2e3055cf1bf990d61937601691c16348fb947d6c57153062982d8b09f',
                                           'original_frozen_sha256':FROZEN_DIGEST,'frozen_source_file_sha256':FROZEN_FILE_SHA256})
    try:
        candidates=select_original(source)
        report['frozen_borrowers']=[{'borrower':x['borrower'],'indexer_source_usd_debt':x['borrow_usd_api']} for x in candidates]
        chain=unsignedhex(rpc.call('eth_chainId',[]),'CHAIN_ID')
        require(chain==8453,'MORPHO_RPC_NOT_BASE_8453')
        b=rpc.call('eth_getBlockByNumber',['latest',False]);require(type(b) is dict,'NO_BASE_BLOCK_HEADER')
        keys=('hash','parentHash','stateRoot','receiptsRoot','number','timestamp')
        require(all(isinstance(b.get(k),str) for k in keys),'BLOCK_HEADER_SHAPE')
        for k in ('hash','parentHash','stateRoot','receiptsRoot'):require(bool(re.fullmatch(r'0x[0-9a-fA-F]{64}',b[k])),'BLOCK_DIGEST_FORMAT')
        h=b['number'];height=unsignedhex(h,'BLOCK_NUMBER');block_timestamp=unsignedhex(b['timestamp'],'BLOCK_TIME')
        require(height>0,'NO_BLOCK_HEIGHT')
        source_code=rpc.call('eth_getCode',[MORPHO,h]);require(type(source_code) is str and len(source_code)>100,'MORPHO_RUNTIME_CODE_ABSENT')
        morpho_code_sha=sha256(bytes.fromhex(source_code[2:])).hexdigest()
        mp=rpc.call('eth_call',[{'to':MORPHO,'data':contract_data('idToMarketParams(bytes32)')},h]);info=parse_original_morpho_params(mp)
        require(info['loan']==LOAN and info['collateral']==COLLATERAL,'DEPLOYED_MARKET_TOKEN_MISMATCH')
        vals=byteswords(rpc.call('eth_call',[{'to':MORPHO,'data':contract_data('market(bytes32)')},h]),6,'MARKET')
        require(all(x < 2**128 for x in vals) and 0<vals[2] and 0<vals[3] and 0<=vals[4]<=block_timestamp,'MARKET_STATE_BAD')
        price=byteswords(rpc.call('eth_call',[{'to':info['oracle'],'data':selector('price()')},h]),1,'ORACLE_PRICE')[0]
        require(price>0,'ORACLE_PRICE_ZERO')
        rows=[]
        for x in candidates:
            res=rpc.call('eth_call',[{'to':MORPHO,'data':contract_data('position(bytes32,address)',user=x['borrower'])},h])
            state=byteswords(res,3,'POSITION')
            require(state[1]<2**128 and state[2]<2**128,'POSITION_UINT128_OVERFLOW')
            r=stale_abi(state[1],state[2],vals[2],vals[3],price,info['lltv'])
            rows.append({'borrower':x['borrower'],'source_indexer_debt_raw':x['debt_raw'],
                         'source_indexer_collateral_raw':x['collateral_raw'],
                         'onchain_borrowShares':str(state[1]),'onchain_collateral_raw':str(state[2]),**r})
        book=rpc.call('eth_getBlockByNumber',[h,False]);require(type(book) is dict,'NO_FINAL_HEADER')
        require(all(book[k]==b[k] for k in keys),'BLOCK_REORG_OR_HEADER_DIVERGENCE')
        report.update({'status':'SINGLE_PROVIDER_PINNED_BASE_MORPHO_STALE_RISK_ONLY',
                       'block_pinned_success':True,'block_number':height,
                       'block_hash':b['hash'],'block_timestamp':block_timestamp,
                       'original_frozen_count':len(candidates),
                       'morpho_contract_runtime_sha256':morpho_code_sha,
                       'morpho_current_market_lltv_wad':str(info['lltv']),
                       'market_last_accrual_timestamp':vals[4],
                       'seconds_since_last_morpho_accrual_at_snapshot':block_timestamp-vals[4],
                       'oracle_price_raw':str(price),'rows':rows,
                       'oracle_IRM_accrued_HF_proven':False,'block_pinned_success':True})
    except Missing as e:
        report['failure_reason']=str(e)
    report['source_rpc_calls']=rpc.calls
    write(out/'decision.json',report)
    return report

def main():
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);p.add_argument('--source',required=True)
    args=p.parse_args();out=Path(args.out)
    report=execute(out,Path(args.source).read_bytes())
    print(json.dumps({'status':report['status'],'calls':report['source_rpc_calls'],'failure':report.get('failure_reason'),
                      'block':report.get('block_number'),'borrowers':len(report.get('rows',[]))}))
    return 0
if __name__=='__main__':raise SystemExit(main())
