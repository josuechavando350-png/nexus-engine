#!/usr/bin/env python3
"""Read-only falsification of Ethereum oracle eth_getLogs source capabilities.

Do not infer that RPC query failures mean no update, and do not silently use
an OR-topic response as the sole source. Positive controls are two exact
historical tx0 receipts that actually emitted authenticated DualAggregator
events. This is not an opportunity or profit detector.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from oracle_pending_visibility_probe import canon, strict_json
from oracle_ws_inclusion_audit import (
    AGGREGATOR, NEW_TRANSMISSION_TOPIC, SECONDARY_ROUND_TOPIC,
    EVENT_TOPICS, parse_log,
)
from oracle_dynamic_topology_truth import HISTORICAL

PROVIDERS = {'drpc':'https://eth.drpc.org',
             'blast':'https://eth-mainnet.public.blastapi.io'}
TYPES = {'secondary':SECONDARY_ROUND_TOPIC, 'primary':NEW_TRANSMISSION_TOPIC}
RECENT_SPAN = 64
SHARD = 32
STABLE_CONFIRMATIONS = 16
MAX_CALLS_PER_SOURCE = 30
MAX_BLOCK_EVENTS = 32
MAX_RPC_BYTES = 2_000_000


def need(ok, message):
    if not ok:
        raise ValueError(message)


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def hex_quantity(value):
    need(type(value) is str and value.startswith('0x') and
         len(value)>2 and all(x in '0123456789abcdefABCDEF' for x in value[2:]),
         'invalid Ethereum quantity')
    return int(value,16)


def block_identity(raw, number):
    need(type(raw) is dict and hex_quantity(raw.get('number')) == number,
         'block height disagreement')
    h,p=raw.get('hash'),raw.get('parentHash')
    need(type(h) is str and type(p) is str and len(h)==len(p)==66 and
         h!=p and hex_quantity(raw.get('timestamp'))>0,
         'invalid block identity')
    return {'block':number,'hash':h.lower(),'parent':p.lower(),
            'timestamp':hex_quantity(raw['timestamp'])}


def filter_logs(raw, lo, hi):
    need(type(raw) is list and len(raw)<=MAX_BLOCK_EVENTS,
         'oversized or malformed log source')
    observed=[]
    for row in raw:
        p=parse_log(row)
        need(lo<=p['block_number']<=hi,
             'log height outside declared range')
        observed.append(p)
    keys=[(x['tx_hash'],x['block_hash'],x['log_index']) for x in observed]
    need(len(keys)==len(set(keys)), 'duplicate log identity')
    return sorted(observed,key=lambda x:(x['block_number'],x['log_index'],x['tx_hash']))


def projected_identity(events):
    return [(e['tx_hash'],e['block_hash'],e['log_index'],
             e['event_type'],e['indexed_round_id'],e['event_data_sha256'])
            for e in events]


class RPC:
    def __init__(self, provider, transport=None):
        need(provider in PROVIDERS,'unknown provider')
        self.name=provider
        self.url=PROVIDERS[provider]
        self.transport=transport or self.network
        self.calls=0
        self.transcript=[]

    def network(self, method, params):
        req=Request(self.url,
            data=json.dumps({'jsonrpc':'2.0','id':22,'method':method,
                             'params':params}).encode(),
            headers={'Content-Type':'application/json',
                     'User-Agent':'NQC-Oracle-Source-Capability-ReadOnly/1'},
            method='POST')
        try:
            with urlopen(req,timeout=20) as response:
                raw=response.read(MAX_RPC_BYTES+1)
        except HTTPError as exc:
            # Preserve error category, not secrets or an unbounded provider body.
            raw=exc.read(1500)
            raise ValueError('HTTP_'+str(exc.code)+'_'+sha256(raw).hexdigest()[:12]) from exc
        need(len(raw)<=MAX_RPC_BYTES,'oversized RPC JSON')
        decoded=strict_json(raw)
        need(type(decoded) is dict and
             decoded.get('id')==22 and decoded.get('jsonrpc')=='2.0',
             'invalid RPC envelope')
        if 'error' in decoded:
            error=decoded['error']
            code=error.get('code','UNKNOWN') if type(error) is dict else 'MALFORMED'
            raise ValueError('JSON_RPC_ERROR_'+str(code))
        need('result' in decoded,'missing RPC result')
        return decoded['result']

    def call(self, method, params):
        need(self.calls < MAX_CALLS_PER_SOURCE,'source call quota exceeded')
        if method=='eth_chainId':
            need(params==[], 'unapproved chain parameters')
        elif method=='eth_getBlockByNumber':
            need(type(params) is list and len(params)==2 and params[1] is False and
                 type(params[0]) is str and (params[0]=='latest'
                  or params[0].startswith('0x')),
                 'unapproved block read')
        elif method=='eth_getTransactionReceipt':
            need(type(params) is list and len(params)==1 and
                 params[0] in {a['tx'] for a in HISTORICAL},
                 'unapproved receipt read')
        elif method=='eth_getLogs':
            need(type(params) is list and len(params)==1 and type(params[0]) is dict,
                 'unapproved log arguments')
            q=params[0]
            need(set(q)=={'address','topics','fromBlock','toBlock'} and
                 q['address']==AGGREGATOR and
                 q['topics'] in ([SECONDARY_ROUND_TOPIC],
                                 [NEW_TRANSMISSION_TOPIC],
                                 [EVENT_TOPICS]) and
                 0 <= hex_quantity(q['toBlock'])-hex_quantity(q['fromBlock'])<SHARD,
                 'unapproved log selector/span')
        else:
            raise ValueError('read-only allowlist prohibits method')
        self.calls+=1
        record={'method':method,'params':params,'started_at':timestamp()}
        try:
            if self.transport==self.network:
                time.sleep(0.65)
            result=self.transport(method,params)
            record['response_sha256']=sha256(canon(result)).hexdigest()
            return result
        except Exception as exc:
            record['error_type']=type(exc).__name__
            record['error_code']=str(exc).split('https://')[0][:110]
            raise
        finally:
            record['completed_at']=timestamp()
            self.transcript.append(record)

    def header(self, height):
        return block_identity(self.call('eth_getBlockByNumber',[hex(height),False]),height)

    def logs(self, lo,hi,topics):
        return filter_logs(self.call('eth_getLogs',[{
            'address':AGGREGATOR,'topics':[topics] if isinstance(topics,list) else [topics],
            'fromBlock':hex(lo),'toBlock':hex(hi)}]),lo,hi)


def control_receipt(receipt, tx, block):
    need(type(receipt) is dict and
         str(receipt.get('transactionHash','')).lower()==tx and
         str(receipt.get('blockHash','')).lower()==block['hash'] and
         hex_quantity(receipt.get('blockNumber'))==block['block'] and
         hex_quantity(receipt.get('transactionIndex'))==0 and
         hex_quantity(receipt.get('status'))==1,
         'positive control receipt not canonical')
    logs=receipt.get('logs')
    need(type(logs) is list and len(logs)<2000,'unbounded receipt')
    matching=[parse_log(v) for v in logs if
              isinstance(v,dict) and str(v.get('address','')).lower()==AGGREGATOR and
              v.get('topics') and str(v['topics'][0]).lower() in EVENT_TOPICS]
    need(len(matching)>0,'known oracle tx0 lacked authenticated price-update log')
    need(all(v['block_hash']==block['hash'] for v in matching),
         'receipt oracle events differ from canonical block')
    return sorted(matching,key=lambda v:(v['block_number'],v['log_index']))


def examine_source(name, anchor, transport=None):
    rpc=RPC(name,transport)
    row={'provider':name,'chain_verified':False,'anchor_verified':False,
         'positive_controls':[],'recent_single_topic_shards':[],
         'historical_or_topic_probe':[],
         'recent_events':None,'recent_complete':False,
         'failures':[],'calls_used':0,'rpc_transcript':[]}
    try:
        need(hex_quantity(rpc.call('eth_chainId',[]))==1,'not Ethereum')
        row['chain_verified']=True
        need(rpc.header(anchor['first']['block'])==anchor['first'] and
             rpc.header(anchor['last']['block'])==anchor['last'],
             'canonical range header mismatch')
        row['anchor_verified']=True
        for pin in HISTORICAL:
            header=rpc.header(pin['block'])
            receipt=rpc.call('eth_getTransactionReceipt',[pin['tx']])
            events=control_receipt(receipt,pin['tx'],header)
            control={'tx':pin['tx'],'block':pin['block'],'expected_events':events,
                     'individual_queries':[],'or_query':None}
            row['positive_controls'].append(control)
            for key,topic in TYPES.items():
                try:
                    found=rpc.logs(pin['block'],pin['block'],topic)
                    subset=[x for x in events if x['event_topic0']==topic]
                    subset=[e for e in subset if e['tx_hash']==pin['tx']]
                    found_tx=[x for x in found if x['tx_hash']==pin['tx']]
                    control['individual_queries'].append({'kind':key,'status':
                        'PARITY' if projected_identity(found_tx)==projected_identity(subset)
                        else 'MISMATCH','events_for_known_tx':len(found_tx),
                        'source_total_events':len(found)})
                except Exception as exc:
                    control['individual_queries'].append({'kind':key,'status':'ERROR',
                        'error':type(exc).__name__+':'+str(exc)[:140]})
            try:
                found=rpc.logs(pin['block'],pin['block'],EVENT_TOPICS)
                observed=[v for v in found if v['tx_hash']==pin['tx']]
                control['or_query']={'status':'PARITY' if
                     projected_identity(observed)==projected_identity(events)
                     else 'MISMATCH','events_for_known_tx':len(observed)}
            except Exception as exc:
                control['or_query']={'status':'ERROR',
                                    'error':type(exc).__name__+':'+str(exc)[:140]}
        all_events=[]
        # Fixed, non-adaptive, 64-block recent census. Incomplete shards never
        # promote a partial list to a complete dataset.
        for lo in range(anchor['first']['block'],anchor['last']['block']+1,SHARD):
            hi=min(lo+SHARD-1,anchor['last']['block'])
            for key,topic in TYPES.items():
                try:
                    events=rpc.logs(lo,hi,topic)
                    all_events.extend(events)
                    row['recent_single_topic_shards'].append({
                        'lo':lo,'hi':hi,'kind':key,'status':'PASS','events':len(events)})
                except Exception as exc:
                    row['recent_single_topic_shards'].append({
                        'lo':lo,'hi':hi,'kind':key,'status':'ERROR',
                        'error':type(exc).__name__+':'+str(exc)[:140]})
        if all(v['status']=='PASS' for v in row['recent_single_topic_shards']) and \
                len(row['recent_single_topic_shards'])==4:
            need(len(all_events)==len({(e['tx_hash'],e['block_hash'],e['log_index'])
                    for e in all_events}),'duplicate overlap in source')
            # Each observed log gets a canonical block-hash witness.
            heights={e['block_number'] for e in all_events}
            need(len(heights)<=12,'too many event block headers for bounded test')
            heads={n:rpc.header(n) for n in heights}
            need(all(e['block_hash']==heads[e['block_number']]['hash'] for e in all_events),
                 'inconsistent recent event block hash')
            need(rpc.header(anchor['first']['block'])==anchor['first'] and
                 rpc.header(anchor['last']['block'])==anchor['last'],
                 'range reorg during observation')
            row['recent_events']=sorted(all_events,key=lambda x:(x['block_number'],x['log_index']))
            row['recent_complete']=True
    except Exception as exc:
        row['failures'].append({'type':type(exc).__name__,'detail':str(exc)[:160]})
    row['calls_used']=rpc.calls
    row['rpc_transcript']=rpc.transcript
    return row


def run(transport_factory=None):
    out={'schema_version':1,'status':'INCOMPLETE_ORACLE_RPC_SOURCE_CAPABILITY',
         'started_at_utc':timestamp(),'recent_anchor':None,'providers':{},
         'two_source_recent_parity':False,'two_source_positive_control_parity':False,
         'confirmed_recent_oracle_update_events':None,
         'confirmed_recent_oracle_update_transactions':None,
         'net_pnl_certified':False,'prospective_detection_proven':False,
         'RMC_closed':False,'P2_shadow_certified':False,
         'canary_live_authorized':False,'external_nonrecourse_gas_proven':False,
         'commercial_score_upgrade':False,'nqc_realized_pnl_usd':'0'}
    root=RPC('drpc',transport_factory('drpc') if transport_factory else None)
    try:
        need(hex_quantity(root.call('eth_chainId',[]))==1,'wrong chain')
        tip=root.call('eth_getBlockByNumber',['latest',False])
        stable=hex_quantity(tip['number'])-STABLE_CONFIRMATIONS
        first=stable-RECENT_SPAN+1
        need(first>max(item['block'] for item in HISTORICAL),'recent anchor not after controls')
        anchor={'first':root.header(first),'last':root.header(stable)}
        out['recent_anchor']=anchor
        for name in PROVIDERS:
            out['providers'][name]=examine_source(name,anchor,
                 transport_factory(name) if transport_factory else None)
        a,b=out['providers']['drpc'],out['providers']['blast']
        out['two_source_positive_control_parity']=all(
            len(p['positive_controls'])==2 and
            all(all(q['status']=='PARITY' for q in c['individual_queries']) for c in p['positive_controls'])
            for p in (a,b))
        if a['recent_complete'] and b['recent_complete']:
            out['two_source_recent_parity']=(
                a['recent_events']==b['recent_events'])
            if out['two_source_recent_parity']:
                events=a['recent_events']
                out['confirmed_recent_oracle_update_events']=len(events)
                out['confirmed_recent_oracle_update_transactions']=len({e['tx_hash'] for e in events})
        if out['two_source_recent_parity'] and out['two_source_positive_control_parity']:
            out['status']='TWO_SOURCE_ORACLE_LOG_CAPABILITY_AND_RECENT_PARITY'
    except Exception as exc:
        out['anchor_failure']=type(exc).__name__+':'+str(exc)[:160]
    out['anchor_rpc_calls']=root.calls
    out['finished_at_utc']=timestamp()
    return out


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--out',type=Path,required=True)
    a=p.parse_args()
    need(a.out.is_absolute() and a.out.parent.is_dir() and not a.out.exists(),
         'fresh absolute output file required')
    result=run()
    with a.out.open('xb') as f:
        f.write(canon(result))
    print(result['status'],'recent_events',result['confirmed_recent_oracle_update_events'],
          'recent_txs',result['confirmed_recent_oracle_update_transactions'],
          'provider_status',[(p,r['recent_complete'],r['calls_used'],r['failures'])
                             for p,r in result['providers'].items()])
    return 0  # failure/censoring is useful diagnostics, not market zero.


if __name__=='__main__':
    raise SystemExit(main())
