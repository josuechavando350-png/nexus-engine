#!/usr/bin/env python3
"""One-shot, no-trade Morpho Base cbXRP/USDC borrower-risk indexer snapshots.

Two read-only official Morpho API queries, a fixed borrower cohort, integer-only
oracle HF estimates, then one more query after a bounded interval.  NOT onchain
RPC consensus, a liquidatable tx, NQC execution, or prospective capture P&L.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
from decimal import Decimal
from hashlib import sha256
import json
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.request

CHAIN=8453
MARKET='0xd4a903dc6d949519060c7707f9604fdc9772c046e05c2e3a8fce0bd7196e4109'
MORPHO='0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb'
USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
CBXRP='0xcb585250f852c6c6bf90434ab21a00f02833a4af'
ORACLE='0x031b2efc8d70042ac8d9f5c793c4149ec4b60fde'
LLTV=625000000000000000
WAD=10**18
ORACLE_SCALE=10**36
DEBT_DECIMALS=6
C_TOKEN_DECIMALS=6
CAP=100
URL='https://api.morpho.org/graphql'
ORACLE_URL='https://api.morpho.org/v0/oracles/8453:'+ORACLE+'/state'
RPC_METHODS_ALLOWLIST=()  # Absolutely no Ethereum JSON-RPC transport in this experiment.
QUERY='''query NqcFrozenMorphoBorrowers {\n marketById(marketId: "'''+MARKET+'''", chainId: 8453) {\n  marketId lltv loanAsset {address symbol decimals} collateralAsset {address symbol decimals} oracle {address}\n }\n marketPositions(first: 100, orderBy: HealthFactor, orderDirection: Asc, where: {healthFactor_lte: 1.15, marketUniqueKey_in: ["'''+MARKET+'''"]}) {\n  items { user {address} market {marketId chain {id}} state {borrowShares borrowAssets collateral} }\n  pageInfo {count countTotal}\n }\n}'''
HEX40=re.compile(r'^0x[0-9a-fA-F]{40}$')
HEX64=re.compile(r'^0x[0-9a-fA-F]{64}$')
class Incomplete(ValueError):pass

def check(ok,why):
    if not ok: raise Incomplete(why)

def uint(x,label,bits=256):
    check(type(x) in (str,int) and not isinstance(x,bool),'INVALID_UINT_TYPE_'+label)
    if isinstance(x,str):check(bool(re.fullmatch(r'(0|[1-9][0-9]*)',x)),'INVALID_UINT_TEXT_'+label)
    y=int(x)
    check(0<=y<2**bits,'UINT_RANGE_'+label)
    return y

def address(s,label):
    check(isinstance(s,str) and bool(HEX40.fullmatch(s)), 'INVALID_ADDRESS_'+label)
    return s.lower()

def api_post_json(endpoint,method,payload=None):
    check((endpoint==URL and method=='POST') or (endpoint==ORACLE_URL and method=='GET'),'UNAUTHORIZED_ENDPOINT_OR_METHOD')
    data=json.dumps(payload,separators=(',',':')).encode() if method=='POST' else None
    headers={'Accept':'application/json','User-Agent':'NQC-Borrower-Risk-OneShot-ReadOnly/1.0'}
    if data is not None:headers['Content-Type']='application/json'
    req=urllib.request.Request(endpoint,data=data,headers=headers,method=method)
    try:
        with urllib.request.urlopen(req,timeout=18) as r:
            check(r.status==200,'SOURCE_HTTP_STATUS_'+str(r.status))
            buf=r.read(1_000_001)
            check(len(buf)<1_000_001,'SOURCE_RESPONSE_TOO_LARGE')
            doc=json.loads(buf)
    except urllib.error.HTTPError as e:
        raise Incomplete('SOURCE_HTTP_'+str(e.code)+'_'+('GRAPHQL' if method=='POST' else 'ORACLE')) from e
    except (urllib.error.URLError,TimeoutError,OSError,ValueError) as e:
        raise Incomplete('SOURCE_TRANSPORT_'+type(e).__name__+'_'+method) from e
    check(type(doc) is dict,'SOURCE_NONOBJECT')
    return doc,sha256(buf).hexdigest()

def market_snapshot(doc):
    check(type(doc) is dict and not doc.get('errors'),'GRAPHQL_ERRORS')
    d=doc.get('data');check(type(d) is dict,'GRAPHQL_DATA_MISSING')
    m=d.get('marketById');check(type(m) is dict,'MARKET_MISSING')
    check(m.get('marketId','').lower()==MARKET,'MARKET_ID_DRIFT')
    check(uint(m.get('lltv'),'LLTV')==LLTV,'MARKET_LLTV_DRIFT')
    for k,expect in [('loanAsset',USDC),('collateralAsset',CBXRP)]:
        obj=m.get(k);check(type(obj) is dict,'ASSET_MISSING_'+k)
        check(address(obj.get('address'),k)==expect,'MARKET_ASSET_DRIFT_'+k)
        check(uint(obj.get('decimals'),k,8)==6,'MARKET_DECIMALS_DRIFT_'+k)
        check(obj.get('symbol') in ('USDC','cbXRP'),'MARKET_SYMBOL_DRIFT_'+k)
    o=m.get('oracle');check(type(o) is dict and address(o.get('address'),'oracle')==ORACLE,'MARKET_ORACLE_DRIFT')
    pos=d.get('marketPositions');check(type(pos) is dict and isinstance(pos.get('items'),list),'POSITIONS_MISSING')
    items=pos['items'];check(len(items)<=CAP,'POSITIONS_CAP_EXCEEDED')
    page=pos.get('pageInfo');check(type(page) is dict,'PAGEINFO_REQUIRED')
    total=uint(page.get('countTotal'),'filtered_count_total',64)
    count=uint(page.get('count'),'page_count',64)
    check(count==len(items) and total>=count,'INDEXER_PAGE_TOTAL_MISMATCH')
    rows={}
    for item in items:
        check(type(item) is dict,'POSITION_NOT_OBJECT')
        user=item.get('user');market=item.get('market');state=item.get('state')
        check(type(user) is dict and type(market) is dict and type(state) is dict,'POSITION_SHAPE')
        user_address=address(user.get('address'),'user')
        check(user_address not in rows,'DUPLICATE_USER')
        check(market.get('marketId','').lower()==MARKET,'CROSS_MARKET_ITEM')
        check(type(market.get('chain')) is dict and uint(market['chain'].get('id'),'chain',64)==CHAIN,'CROSS_CHAIN_ITEM')
        debt=uint(state.get('borrowAssets'),'borrowAssets')
        shares=uint(state.get('borrowShares'),'borrowShares')
        collateral=uint(state.get('collateral'),'collateral')
        # BorrowShares is not the source sort key; indexed HealthFactor is.
        rows[user_address]={'borrow_assets_raw':str(debt),'collateral_assets_raw':str(collateral),'borrow_shares_raw':str(shares)}
    return rows

def oracle_snapshot(doc):
    check(type(doc) is dict,'ORACLE_DOC_SHAPE')
    d=doc.get('data',doc)
    check(type(d) is dict and not doc.get('errors'),'ORACLE_DATA_MISSING')
    price=uint(d.get('price'),'oracle_price',256)
    check(price>0,'ORACLE_ZERO_PRICE')
    # 6 decimal loan + collateral: price=USD per 1 cbXRP * 10**36.
    check(10**32<price<10**40,'ORACLE_OUT_OF_CONSERVATIVE_BOUND')
    block=None
    for key in ('last_indexed_block','lastIndexedBlock'):
        if d.get(key) is not None:block=uint(d[key],key,64)
    if block is None:raise Incomplete('ORACLE_INDEXED_BLOCK_MISSING')
    check(block>0,'ORACLE_BLOCK_ZERO')
    updated=d.get('last_updated_at',d.get('lastUpdatedAt'))
    return {'price_scaled_1e36':str(price),'last_indexed_block':block,'last_updated_at':updated}

def hf_wad(collateral,borrow,price):
    collateral=uint(collateral,'collateral');borrow=uint(borrow,'borrow');price=uint(price,'price')
    check(price>0,'ZERO_ORACLE_PRICE')
    if borrow==0:return None
    # Morpho: collateral * oracle_price / 1e36 scaled in raw loan units, then LLTV.
    capacity_raw=(collateral*price//ORACLE_SCALE)*LLTV//WAD
    return capacity_raw*WAD//borrow

def borrower_risk(rows,oracle):
    check(type(rows) is dict and type(oracle) is dict,'RISK_SOURCE_SHAPE')
    price=uint(oracle['price_scaled_1e36'],'price')
    ranked=[]
    for borrower,position in rows.items():
        address(borrower,'borrower')
        hf=hf_wad(position['collateral_assets_raw'],position['borrow_assets_raw'],price)
        if hf is None:continue
        debt=uint(position['borrow_assets_raw'],'debt')
        if debt==0:continue
        delta_bps=((hf-WAD)*10000//hf) if hf>=WAD else 0
        ranked.append({'user':borrower,'borrow_assets_raw':str(debt),'health_factor_wad_from_INDEXED_API':str(hf),
                       'oracle_price_drop_to_hf_lt_1_bps_model_only':delta_bps,
                       'under_hf_1_indexer_model':hf<WAD,'collateral_assets_raw':position['collateral_assets_raw']})
    ranked.sort(key=lambda x:(int(x['health_factor_wad_from_INDEXED_API']),-int(x['borrow_assets_raw']),x['user']))
    return ranked

def snapshot_from_documents(graph_doc,oracle_doc,ts):
    rows=market_snapshot(graph_doc);orec=oracle_snapshot(oracle_doc)
    risky=borrower_risk(rows,orec)
    return {'observed_utc':ts,'rows':rows,'oracle':orec,
            'risk_ranked':risky,'borrower_count_in_risk100':len(rows),
            'suspected_unhealthy_source_only':sum(x['under_hf_1_indexer_model'] for x in risky),
            'within_1pct_of_hf_threshold_source_only':sum(0<=x['oracle_price_drop_to_hf_lt_1_bps_model_only']<=100 for x in risky),
            'sample_may_exclude_other_market_positions':uint(graph_doc['data']['marketPositions']['pageInfo']['countTotal'],'filtered_total')>len(rows),
            'risk_ordered_indexer_total_under_1_15':uint(graph_doc['data']['marketPositions']['pageInfo']['countTotal'],'filtered_total')}

def comparative_report(first,second,elapsed):
    check(type(first) is dict and type(second) is dict,'SNAPSHOTS_REQUIRED')
    check(elapsed>=30,'SNAPSHOTS_TOO_CLOSE')
    check(second['oracle']['last_indexed_block']>=first['oracle']['last_indexed_block'],'ORACLE_HEIGHT_REGRESSION')
    # Strict no-lookahead cohort: only addresses originally frozen by first query.
    original=set(first['rows']); second_rows=second['rows']; shared=original.intersection(second_rows)
    initial={r['user']:r for r in first['risk_ranked']}; follow={r['user']:r for r in second['risk_ranked']}
    transitions=[]
    for addr in sorted(shared):
        f=initial.get(addr);s=follow.get(addr)
        if f and s:
            transitions.append({'user':addr,'hf_initial_wad':f['health_factor_wad_from_INDEXED_API'],
                                'hf_followup_wad':s['health_factor_wad_from_INDEXED_API'],
                                'initial_indexer_unhealthy':f['under_hf_1_indexer_model'],
                                'followup_indexer_unhealthy':s['under_hf_1_indexer_model'],
                                'followup_borrow_assets_raw':s['borrow_assets_raw']})
    crossings=[r for r in transitions if not r['initial_indexer_unhealthy'] and r['followup_indexer_unhealthy']]
    sorted_second=sorted((r for r in second['risk_ranked'] if r['user'] in shared),key=lambda r:int(r['health_factor_wad_from_INDEXED_API']))
    return {'status':'RISK_FIRST_TWO_SNAPSHOTS_INDEXER_ONLY',
            'source':'official Morpho public GraphQL + REST oracle, ONE source operator, not onchain RPC',
            'chain_id':CHAIN,'market_id':MARKET,'first_at_utc':first['observed_utc'],'second_at_utc':second['observed_utc'],
            'elapsed_seconds':round(elapsed,3),'first_cohort_size':len(original),
            'risk_first_filtered_total':first['risk_ordered_indexer_total_under_1_15'],
            'risk_first_filtered_exhaustive_source_only':not first['sample_may_exclude_other_market_positions'],'shared_followup_count':len(shared),
            'original_cohort_not_seen_in_followup':len(original-shared),
            'first_snapshot_indexer_suspected_unhealthy':first['suspected_unhealthy_source_only'],
            'followup_shared_indexer_suspected_unhealthy':sum(r['under_hf_1_indexer_model'] for r in sorted_second),
            'first_snapshot_at_1pct_source_only':first['within_1pct_of_hf_threshold_source_only'],
            'first_snapshot_at_3pct_source_only':sum(0<=x['oracle_price_drop_to_hf_lt_1_bps_model_only']<=300 for x in first['risk_ranked']),
            'new_hf_crossings_IN_INDEXER_MODEL_only':len(crossings),
            'top10_lowest_hf_original_cohort_at_second':sorted_second[:10],
            'crossings_source_only':crossings[:10],
            'frozen_cohort_hash_sha256':sha256(json.dumps(sorted(original),separators=(',',':')).encode()).hexdigest(),
            'unobserved_other_borrowers_possible':first['sample_may_exclude_other_market_positions'],
            'realized_nqc_pnl_usd':'0','nqc_capital_usd_spent':'0',
            'onchain_oracle_at_exact_same_block_verified':False,
            'can_execute_a_liquidation_now_proven':False,'competitor_clearing_or_ordering_proven':False,
            'dex_exit_at_future_liquidation_proven':False,'flash_execution_proven':False,
            'zero_recourse_native_gas_sponsor_proven':False,'capture_probability_proven':False,
            'global_morpho_market_completeness_proven':False,
            'commercial_promotion_allowed':False}

def utc():return datetime.now(timezone.utc).isoformat()

def main(argv=None):
    p=argparse.ArgumentParser()
    p.add_argument('--out',required=True)
    p.add_argument('--delay',type=int,default=45)
    a=p.parse_args(argv)
    check(30<=a.delay<=65,'DELAY_BOUND')
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
    calls=0; errors=[]; t0=time.monotonic()
    report={'status':'INCOMPLETE_PROSPECTIVE_MORPHO_INDEXER','realized_nqc_pnl_usd':'0',
            'onchain_oracle_at_exact_same_block_verified':False,'commercial_promotion_allowed':False,
            'own_capital_spent_usd':'0','call_count':0}
    try:
        samples=[]
        for i in range(2):
            if i:
                remaining=a.delay-(time.monotonic()-t0)
                if remaining>0:time.sleep(remaining)
            docs=[]
            for url,method,payload in ((URL,'POST',{'query':QUERY}), (ORACLE_URL,'GET',None)):
                d,digest=api_post_json(url,method,payload);calls+=1
                docs.append(d)
                (out/('snapshot'+str(i+1)+'-'+('graph' if method=='POST' else 'oracle')+'.json')).write_text(json.dumps(d,indent=2,sort_keys=True)+'\n')
                (out/('snapshot'+str(i+1)+'-'+('graph' if method=='POST' else 'oracle')+'.sha256')).write_text(digest+'\n')
            snap=snapshot_from_documents(docs[0],docs[1],utc());samples.append(snap)
            (out/('risk-snapshot'+str(i+1)+'.json')).write_text(json.dumps(snap,indent=2,sort_keys=True)+'\n')
        report=comparative_report(samples[0],samples[1],time.monotonic()-t0)
    except (Incomplete,ValueError) as e:
        errors.append(str(e))
        report['reason']=str(e)
    except Exception as e:
        errors.append('UNEXPECTED_'+type(e).__name__)
        report['reason']='UNEXPECTED_'+type(e).__name__
    report['call_count']=calls
    report['finish_utc']=utc()
    (out/'prospective-risk-report.json').write_text(json.dumps(report,indent=2,sort_keys=True)+'\n')
    (out/'error-log.txt').write_text('\n'.join(errors)+'\n')
    print(report['status'],'cohort',report.get('first_cohort_size'),'risky',report.get('followup_shared_indexer_suspected_unhealthy'), 'source_reason',report.get('reason'))
    return 0  # source fail-closed makes an incomplete CI source test a valid negative certificate
if __name__=='__main__':sys.exit(main())
