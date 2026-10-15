#!/usr/bin/env python3
"""One bounded public Morpho GraphQL read; market *indexed* competition, not P&L.
No wallet, onchain tx, trading RPC or authorization request. Exact win dedup across markets.
"""
from __future__ import annotations
import argparse, collections, datetime as dt, hashlib, json, os, pathlib, re, sys, time, urllib.request, urllib.error

API='https://api.morpho.org/graphql'
PAGE_SIZE=100
MAX_QUERIES=650
DAYS=30
QUERY='''query RecentBlueLiquidations($skip:Int!,$since:Int!,$until:Int!){
  marketTransactions(first:100,skip:$skip,orderBy:Timestamp,orderDirection:Asc,
    where:{type_in:[Liquidation],timestamp_gte:$since,timestamp_lte:$until}){
    items { chain{id} txHash logIndex timestamp blockNumber market{marketId loanAsset{symbol decimals} collateralAsset{symbol decimals}}
      data{... on MarketTransactionLiquidationData{liquidator repaidAssets seizedAssets badDebtAssets}} }
    pageInfo{count countTotal}
  }
}'''
TX=re.compile(r'^0x[0-9a-fA-F]{64}$')
MARKET=re.compile(r'^0x[0-9a-fA-F]{64}$')
ADDR=re.compile(r'^0x[0-9a-fA-F]{40}$')
class BadEvidence(ValueError): pass

def require(condition,reason):
    if not condition:raise BadEvidence(reason)

def req_int(value,field,allowzero=True):
    require((type(value) is int or type(value) is str and bool(re.fullmatch(r'(?:0|[1-9][0-9]*)',value))),f'invalid uint: {field}')
    n=int(value);require(0<=n<2**256 and (allowzero or n>0),f'out of range {field}');return n

def validate_event(e,since,until):
    require(type(e) is dict,'event not object')
    chain=req_int((e.get('chain') or {}).get('id'),'chain',False)
    require(chain in (1,8453,42161,56,10,130,137,143,999,747474,480,988,4217,5042,4663),'unexpected supported chain')
    h=e.get('txHash');require(type(h) is str and TX.fullmatch(h),'invalid txhash')
    log=req_int(e.get('logIndex'),'logIndex')
    timestamp=req_int(e.get('timestamp'),'timestamp',False)
    require(since<=timestamp<=until,'event out of frozen window')
    block=req_int(e.get('blockNumber'),'blockNumber',False)
    market=e.get('market') or {};market_id=market.get('marketId')
    require(type(market_id) is str and MARKET.fullmatch(market_id),'missing market identity')
    data=e.get('data') or {};liq=data.get('liquidator');require(type(liq) is str and ADDR.fullmatch(liq),'missing liquidator')
    for k in ('repaidAssets','seizedAssets','badDebtAssets'):req_int(data.get(k),k)
    for asset in ('loanAsset','collateralAsset'):
        x=market.get(asset);require(type(x) is dict and type(x.get('symbol')) is str and len(x['symbol'])<80,'missing asset symbol')
        require(req_int(x.get('decimals'),asset+'decimals')<=36,'invalid asset decimal')
    return {'id':f'{chain}:{h.lower()}:{log}', 'win_id':f'{chain}:{h.lower()}', 'chain_id':chain,'tx':h.lower(),'log_index':log,
            'timestamp':timestamp,'block_number':block,'market_id':market_id.lower(),'liquidator':liq.lower(),
            'loan':market['loanAsset']['symbol'],'collateral':market['collateralAsset']['symbol'],
            'repaid_raw':str(req_int(data['repaidAssets'],'repaidAssets')),
            'seized_raw':str(req_int(data['seizedAssets'],'seizedAssets')),
            'bad_debt_raw':str(req_int(data['badDebtAssets'],'badDebtAssets'))}

def consume(pages,since,until):
    require(len(pages)>0,'no pages')
    events=[];ids=set();total=None;complete=False
    for k,page in enumerate(pages):
        require(type(page) is dict,'page not object')
        items=page.get('items');info=page.get('pageInfo')
        require(type(items) is list and type(info) is dict,'page data missing')
        count=req_int(info.get('count'),'page count')
        count_total=req_int(info.get('countTotal'),'page total')
        require(count==len(items),'page count mismatch')
        if total is None:total=count_total
        require(total==count_total,'index count shifted during scan')
        for e in items:
            rec=validate_event(e,since,until)
            require(rec['id'] not in ids,'duplicate event identity')
            ids.add(rec['id']);events.append(rec)
        if len(events)==total:
            complete=True
            require(len(items)<PAGE_SIZE or len(events)==total,'pagination incomplete')
            break
        require(len(items)==PAGE_SIZE,'short page with remaining events')
    if complete:
        require(len(events)==total,'count mismatch')
    report=aggregate_records(events)
    return {'status':'COMPLETE_MORPHO_API_WINDOW_INDEX_ONLY' if complete else 'INCOMPLETE_MORPHO_API_WINDOW',
       'window_start_unix':since,'window_end_unix':until,'event_count':len(events),'claimed_indexer_count':total,
       **report,'events':events,'nqc_pnl_usd':'0','gas_sponsor_proven':False,'market_canonical_completeness_proven':False,'competitive_capture_proven':False,
       'source':'public_morpho_single_api_indexer_no_independent_rpc_quorum',
       'notes':'Indexed observation, never a complete executable opportunity universe; events != unique winning transactions; no USD profit inferred from raw tokens.'}

def aggregate_records(events):
    counts=collections.Counter((e['chain_id'],e['market_id'],e['loan'],e['collateral']) for e in events)
    by_market={}
    for key,n in counts.items():
        subset=[e for e in events if (e['chain_id'],e['market_id'],e['loan'],e['collateral'])==key]
        wins={e['win_id'] for e in subset};liqs={e['liquidator'] for e in subset}
        top=collections.Counter(e['liquidator'] for e in subset).most_common(1)[0][1]
        by_market[str(key[0])+':'+key[1]]={'chain_id':key[0],'market_id':key[1],'loan_symbol':key[2],'collateral_symbol':key[3],
                     'liquidation_event_count':n,'distinct_tx_count':len(wins),'distinct_liquidator_count':len(liqs),
                     'leading_liquidator_event_share_bps':10000*top//n}
    return {'unique_winning_transactions':len(set(x['win_id'] for x in events)),
       'unique_liquidator_addresses':len(set(x['liquidator'] for x in events)),
       'markets': sorted(by_market.values(),key=lambda x:(-x['distinct_tx_count'],-x['liquidation_event_count'],x['chain_id'],x['market_id']))}


def request_page(skip,since,until):
    body=json.dumps({'query':QUERY,'variables':{'skip':skip,'since':since,'until':until}},separators=(',',':')).encode()
    req=urllib.request.Request(API,data=body,headers={'Content-Type':'application/json','Accept':'application/json','User-Agent':'NQC-evidence-one-shot-read-only/1.0'},method='POST')
    with urllib.request.urlopen(req,timeout=20) as resp:
        require(resp.status==200,'non-200 Morpho API')
        raw=resp.read(1_200_000);require(len(raw)<1_200_000,'oversize response')
    doc=json.loads(raw)
    require(type(doc) is dict and not doc.get('errors'),'GraphQL errors: '+repr(doc.get('errors'))[:850])
    return doc['data']['marketTransactions']

def source_bisect(ds,de,fetch,trace,budget):
    """Never use indexer skip. Recursively partition time until returned count is complete.
    Children must add exactly to parent indexed count; single-second congestion rejects.
    """
    require(type(ds) is int and type(de) is int and ds<=de,'invalid shard')
    require(budget[0]>0,'finite source call budget exhausted')
    budget[0]-=1
    raw=fetch(0,ds,de)
    require(type(raw) is dict and type(raw.get('items')) is list and type(raw.get('pageInfo')) is dict,
            'malformed indexer response')
    items=raw['items']; meta=raw['pageInfo']; total=req_int(meta.get('countTotal'),'countTotal')
    require(req_int(meta.get('count'),'count')==len(items),'page count mismatch')
    require(len(items)<=PAGE_SIZE,'provider exceeded page limit')
    entry={'from':ds,'through':de,'count_total':total,'returned':len(items),'complete':len(items)==total}
    trace.append(entry)
    if total==len(items):
        return [validate_event(e,ds,de) for e in items],total
    require(ds<de,'multiple events in an undrainable single-second indexer interval')
    mid=ds+(de-ds)//2
    left,ln=source_bisect(ds,mid,fetch,trace,budget)
    right,rn=source_bisect(mid+1,de,fetch,trace,budget)
    require(total==ln+rn,'indexer totals diverged between disjoint temporal shards')
    return left+right,total

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--out',required=True);args=ap.parse_args()
    out=pathlib.Path(args.out);out.mkdir(parents=True,exist_ok=True)
    now=int(dt.datetime.now(dt.timezone.utc).timestamp());since=now-30*24*3600
    result=None;day_reports=[];records=[];ids=set();source_trace=[];budget=[MAX_QUERIES];all_days_complete=True
    for day_idx in range(DAYS):
        ds=since+day_idx*86400;de=min(now,ds+86399)
        day_status={'day_index':day_idx,'start':ds,'end':de,'status':'INCOMPLETE'}
        try:
            day_events,day_total=source_bisect(ds,de,request_page,source_trace,budget)
            day_status['status']='COMPLETE_MORPHO_API_DAY_INDEX_ONLY'
            day_status['claimed_indexer_count']=day_total
            day_status['event_count']=len(day_events)
            require(day_total==len(day_events),'day total mismatch')
            for e in day_events:
                require(e['id'] not in ids,'duplicate event across disjoint time windows')
                ids.add(e['id']);records.append(e)
        except (BadEvidence,urllib.error.URLError,OSError,KeyError,TypeError,ValueError) as exc:
            day_status['status']='INCOMPLETE';day_status['error']=type(exc).__name__+': '+str(exc)[:850]
            all_days_complete=False
            # No network retry, evasion or alternate provider on denial: preserve diagnostics and stop.
            day_reports.append(day_status)
            break
        day_reports.append(day_status)
        time.sleep(.15)
    result={'status':'COMPLETE_MORPHO_API_WINDOW_INDEX_ONLY' if all_days_complete and len(day_reports)==DAYS else 'INCOMPLETE_MORPHO_API_WINDOW',
            'window_start_unix':since,'window_end_unix':now,'days_scoped':DAYS,'days_attempted':len(day_reports),
            'daily_source_provenance':day_reports,'event_count':len(records),**aggregate_records(records),
            'source_query_trace':source_trace,'source':'public_morpho_single_api_indexer_no_independent_rpc_quorum',
            'nqc_pnl_usd':'0','gas_sponsor_proven':False,'market_canonical_completeness_proven':False,'competitive_capture_proven':False,
            'events':records}
    if result is not None and 'events' in result:
        events=result.pop('events')
        (out/'liquidations.jsonl').write_text(''.join(json.dumps(e,sort_keys=True,separators=(',',':'))+'\n' for e in events))
        result['events_sha256']=hashlib.sha256((out/'liquidations.jsonl').read_bytes()).hexdigest()
    result['queries_used']=MAX_QUERIES-budget[0];result['max_queries']=MAX_QUERIES
    (out/'census.json').write_text(json.dumps(result,sort_keys=True,indent=2)+'\n')
    (out/'result-status.txt').write_text(result['status']+'\n')
    print(result['status'],'events=',result.get('event_count',0),'unique_winners=',result.get('unique_winning_transactions',0),'markets=',len(result.get('markets',[])),'pages=',len(pages))
    # No source-only failure can assert a zero market count, nor that a complete canonical onchain census was proved.
    return 0
if __name__=='__main__':sys.exit(main())
