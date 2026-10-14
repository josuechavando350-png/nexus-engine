#!/usr/bin/env python3
"""Pinned, bounded Ethereum ETH/USD NewTransmission frequency research.

This counts canonical-looking historical on-chain oracle logs over a fixed
range, independently requested via two documented public RPC endpoints. No
market census, live capture, latency forecast, trades or capital funding.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import statistics
import time
from urllib.request import Request, urlopen

from oracle_pending_visibility_probe import canon, strict_json
from oracle_ws_inclusion_audit import AGGREGATOR

# Exact emitter/topic pairs authenticated against both historical tx0 receipts.
NEW_TRANSMISSION_TOPIC = '0xc797025feeeaf2cd924c99e9205ac8ec04d5cad21c41ce637a38fb6dee6016a'
SECONDARY_ROUND_TOPIC = '0x8d530b9ddc4b318d28fdd4c3a21fcfecece54c1a72a824f262985b99afef009b'
EVENT_TOPICS = [SECONDARY_ROUND_TOPIC, NEW_TRANSMISSION_TOPIC]

PROVIDERS = {'drpc': 'https://eth.drpc.org',
             'blast': 'https://eth-mainnet.public.blastapi.io'}
WINDOW_BLOCKS = 720
SHARD_BLOCKS = 32
CONFIRM_DEPTH = 16
MAX_EVENTS = 150
MAX_UNIQUE_EVENT_BLOCKS = 75
MAX_RPC_CALLS_PER_SOURCE = 125
MAX_RPC_BYTES = 2_000_000
QTY = re.compile(r'0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z')
HEX32 = re.compile(r'0x[0-9a-fA-F]{64}\Z')
HEX = re.compile(r'0x(?:[0-9a-fA-F]{2})*\Z')


def need(value, why):
    if not value:
        raise ValueError(why)


def stamp():
    return datetime.now(timezone.utc).isoformat()


def num(value):
    need(type(value) is str and QTY.fullmatch(value), 'invalid RPC integer quantity')
    return int(value, 16)


def hash32(value):
    need(type(value) is str and HEX32.fullmatch(value), 'invalid canonical hash')
    return value.lower()


def canonical_header(raw, expected):
    need(type(raw) is dict and num(raw.get('number')) == expected,
         'canonical header number mismatch')
    h = hash32(raw.get('hash'))
    parent = hash32(raw.get('parentHash'))
    t = num(raw.get('timestamp'))
    need(t > 0 and h != parent, 'invalid canonical header')
    return {'number':expected,'hash':h,'parent':parent,'timestamp':t}


def canonical_event(raw, lo, hi):
    need(type(raw) is dict, 'malformed Ethereum log')
    need(type(raw.get('address')) is str and
         raw['address'].lower() == AGGREGATOR, 'wrong emitter')
    topics=raw.get('topics')
    need(type(topics) is list and len(topics)>=1 and
         type(topics[0]) is str and topics[0].lower()==NEW_TRANSMISSION_TOPIC,
         'not a NewTransmission topic')
    need(raw.get('removed') in (False,None), 'removed/reorg event')
    block=num(raw.get('blockNumber'))
    need(lo <= block <= hi, 'event outside bounded shard')
    data=raw.get('data')
    need(type(data) is str and HEX.fullmatch(data) and len(data)>=66,
         'unparseable NewTransmission data')
    # NewTransmission indexed aggregatorRoundId, first data word = int192 answer.
    # Reject nonpositive prices: the contract's expected ETH/USD domain.
    first=int(data[2:66],16)
    need(0<first<2**191, 'nonpositive/out-of-range oracle price answer')
    return {'block_number':block,'block_hash':hash32(raw.get('blockHash')),
            'tx_hash':hash32(raw.get('transactionHash')),
            'log_index':num(raw.get('logIndex')),
            'topic0':NEW_TRANSMISSION_TOPIC,
            'answer_raw':first,
            'event_data_sha256':sha256(bytes.fromhex(data[2:])).hexdigest()}


def ordered_event_identity(v):
    return (v['block_number'],v['log_index'],v['block_hash'],v['tx_hash'],
            v['event_data_sha256'],v['answer_raw'])


class RPC:
    def __init__(self, provider, transport=None):
        need(provider in PROVIDERS,'unknown provider')
        self.provider=provider
        self.url=PROVIDERS[provider]
        self.transport=transport or self.network
        self.calls=0
        self.transcript=[]

    def network(self, method, params):
        need(self.url in set(PROVIDERS.values()),'provider not allowlisted')
        need(method in ('eth_chainId','eth_getBlockByNumber','eth_getLogs'),
             'write/non-research method prohibited')
        request=Request(self.url, method='POST',
            data=json.dumps({'jsonrpc':'2.0','id':76,
                             'method':method,'params':params}).encode(),
            headers={'Content-Type':'application/json',
                     'User-Agent':'NQC-V2-Oracle-Cadence-Research-ReadOnly/1'})
        with urlopen(request,timeout=24) as response:
            body=response.read(MAX_RPC_BYTES+1)
        need(len(body)<=MAX_RPC_BYTES,'oversized RPC response')
        parsed=strict_json(body)
        need(type(parsed) is dict and parsed.get('jsonrpc')=='2.0' and
             parsed.get('id')==76 and 'error' not in parsed and
             'result' in parsed,'RPC source error')
        return parsed['result']

    def call(self,method,params):
        need(self.calls < MAX_RPC_CALLS_PER_SOURCE,'RPC call budget exhausted')
        if method=='eth_chainId':
            need(params==[],'chain parameter mismatch')
        elif method=='eth_getBlockByNumber':
            need(type(params) is list and len(params)==2 and params[1] is False
                 and type(params[0]) is str and
                 (params[0]=='latest' or QTY.fullmatch(params[0])),
                 'unbounded block read')
        elif method=='eth_getLogs':
            need(type(params) is list and len(params)==1 and
                 type(params[0]) is dict,'invalid logs args')
            q=params[0]
            need(set(q)=={'address','topics','fromBlock','toBlock'} and
                 q['address']==AGGREGATOR and q['topics']==[NEW_TRANSMISSION_TOPIC]
                 and 0<=num(q['toBlock'])-num(q['fromBlock'])<SHARD_BLOCKS,
                 'unexpected logs range or target')
        else:
            raise ValueError('non-read-only method')
        self.calls+=1
        row={'source':self.provider,'method':method,'params':params,
             'started_at_utc':stamp()}
        try:
            if self.transport==self.network:
                time.sleep(0.7)  # respect public RPC throughput, no bypass
            result=self.transport(method,params)
            row['result_sha256']=sha256(canon(result)).hexdigest()
            return result
        except Exception as exc:
            row['error_type']=type(exc).__name__
            row['error_excerpt']=str(exc).split('https://')[0][:150]
            raise
        finally:
            row['completed_at_utc']=stamp()
            self.transcript.append(row)

    def chain(self):
        need(num(self.call('eth_chainId',[]))==1,'not Ethereum mainnet')

    def at(self,height):
        return canonical_header(
            self.call('eth_getBlockByNumber',[hex(height),False]),height)


def shard_ranges(first,last):
    need(type(first) is int and type(last) is int and
         1<=first<=last and last-first+1<=WINDOW_BLOCKS,
         'outside 720-block capped research window')
    return [(lo,min(last,lo+SHARD_BLOCKS-1))
            for lo in range(first,last+1,SHARD_BLOCKS)]


def measure_source(provider,anchor,transport=None):
    rpc=RPC(provider,transport)
    result={'provider':provider,'status':'INCOMPLETE_SOURCE',
            'events':[], 'errors':[], 'shards_complete':0,
            'operator_independence_verified':False}
    try:
        rpc.chain()
        first,last=anchor['first']['number'],anchor['last']['number']
        begin=rpc.at(first);end=rpc.at(last)
        need(begin==anchor['first'] and end==anchor['last'],
             'different canonical endpoint hashes')
        logs=[]
        for lo,hi in shard_ranges(first,last):
            reply=rpc.call('eth_getLogs',[{
                'address':AGGREGATOR, 'topics':[NEW_TRANSMISSION_TOPIC],
                'fromBlock':hex(lo),'toBlock':hex(hi)}])
            need(type(reply) is list and len(reply)<=MAX_EVENTS,
                 'oversized shard response')
            logs.extend(canonical_event(v,lo,hi) for v in reply)
            need(len(logs)<=MAX_EVENTS,'event cap exceeded')
            result['shards_complete']+=1
        need(len(logs)==len({ordered_event_identity(e) for e in logs}),
             'duplicate canonical log identity')
        logs.sort(key=ordered_event_identity)
        blocks=sorted({e['block_number'] for e in logs})
        need(len(blocks)<=MAX_UNIQUE_EVENT_BLOCKS,
             'too many event-block headers for bounded latency analysis')
        headers={n:rpc.at(n) for n in blocks}
        for e in logs:
            need(e['block_hash']==headers[e['block_number']]['hash'],
                 'event block hash not canonical at pinned number')
            e['block_timestamp']=headers[e['block_number']]['timestamp']
        need(rpc.at(first)==begin and rpc.at(last)==end,
             'reorg or provider inconsistency during census')
        result['events']=logs
        result['status']='COMPLETE_SOURCE_BOUNDED_SHARD_CENSUS'
    except Exception as exc:
        result['errors'].append({'type':type(exc).__name__,
            'detail':str(exc).split('https://')[0][:220]})
    result['rpc_calls_used']=rpc.calls
    result['transcript']=rpc.transcript
    return result


def cadence(events, first_timestamp, last_timestamp):
    need(type(events) is list and last_timestamp>first_timestamp,'invalid cadence scope')
    raw=sorted(events,key=ordered_event_identity)
    unique_blocks=[]
    for event in raw:
        if not unique_blocks or unique_blocks[-1]['number']!=event['block_number']:
            unique_blocks.append({'number':event['block_number'],
                                  'timestamp':event['block_timestamp'],
                                  'answer_raw':event['answer_raw']})
    intervals=[b['timestamp']-a['timestamp']
               for a,b in zip(unique_blocks,unique_blocks[1:])]
    need(all(v>=0 for v in intervals),'nonmonotonic historical timestamps')
    changes=[]
    for a,b in zip(unique_blocks,unique_blocks[1:]):
        changes.append((b['answer_raw']-a['answer_raw'])*10_000//a['answer_raw'])
    interval_seconds=last_timestamp-first_timestamp
    return {
      'window_elapsed_seconds':interval_seconds,
      'canonical_new_transmission_events':len(raw),
      'unique_event_blocks':len(unique_blocks),
      'events_per_observed_hour_descriptive_only':
            len(raw)*3600/interval_seconds,
      'unique_block_interarrival_seconds':intervals,
      'median_interarrival_seconds':statistics.median(intervals) if intervals else None,
      'min_interarrival_seconds':min(intervals) if intervals else None,
      'max_interarrival_seconds':max(intervals) if intervals else None,
      'price_direction_event_changes_bps':changes,
      'downward_changes_of_at_least_50bps':sum(x<=-50 for x in changes),
      'downward_changes_of_at_least_100bps':sum(x<=-100 for x in changes),
      'future_arrival_rate_calibrated':False,
      'price_updates_are_not_liquidations':True,
    }


def run(transport_factory=None):
    result={'schema_version':1,'status':'INCOMPLETE_ORACLE_CADENCE_CENSUS',
            'started_at_utc':stamp(),'first':None,'last':None,
            'sources':{},'cross_endpoint_event_parity':False,
            'source_mismatch_ledger':[],
            'single_source_descriptive_cadence':None,
            'two_endpoint_descriptive_cadence':None,
            'window_fixed_before_observing_events':True,
            'lookahead_selection_of_winner':False,
            'rpc_operator_independence_certified':False,
            'prospective_oracle_detection_proven':False,
            'prospective_liquidation_capture_proven':False,
            'native_gas_external_nonrecourse_certified':False,
            'net_pnl_certified':False,'RMC_closed':False,
            'P2_shadow_certified':False,'canary_live_authorized':False,
            'commercial_score_upgrade':False,'nqc_realized_pnl_usd':'0'}
    leader=RPC('drpc',transport_factory('drpc') if transport_factory else None)
    try:
        leader.chain()
        tip=leader.call('eth_getBlockByNumber',['latest',False])
        need(type(tip) is dict and type(tip.get('number')) is str,
             'tip unavailable')
        stable_end=num(tip['number'])-CONFIRM_DEPTH
        first=stable_end-WINDOW_BLOCKS+1
        need(first>0,'insufficient history')
        anchor={'first':leader.at(first),'last':leader.at(stable_end)}
        result['first']=anchor['first'];result['last']=anchor['last']
        need(anchor['last']['timestamp']>anchor['first']['timestamp'],
             'bad temporal span')
        for provider in ('drpc','blast'):
            value=measure_source(provider,anchor,
                transport_factory(provider) if transport_factory else None)
            result['sources'][provider]=value
        a,b=result['sources']['drpc'],result['sources']['blast']
        if a['status']=='COMPLETE_SOURCE_BOUNDED_SHARD_CENSUS':
            result['single_source_descriptive_cadence']=cadence(
                a['events'],anchor['first']['timestamp'],anchor['last']['timestamp'])
        if (a['status']=='COMPLETE_SOURCE_BOUNDED_SHARD_CENSUS' and
                b['status']=='COMPLETE_SOURCE_BOUNDED_SHARD_CENSUS'):
            i=[ordered_event_identity(e) for e in a['events']]
            j=[ordered_event_identity(e) for e in b['events']]
            if i==j and a['events']==b['events']:
                result['cross_endpoint_event_parity']=True
                result['two_endpoint_descriptive_cadence']=result['single_source_descriptive_cadence']
                result['status']='TWO_ENDPOINT_PINNED_ORACLE_EVENT_PARITY_DESCRIPTIVE_ONLY'
            else:
                result['source_mismatch_ledger'].append({
                    'kind':'EVENT_SET_DIFFERENCE','drpc_count':len(i),'blast_count':len(j)})
                result['status']='MISMATCH_NO_EVENT_AUTHORITY'
    except Exception as exc:
        result['source_mismatch_ledger'].append({
            'kind':'ANCHOR_OR_QUERY_FAILURE','type':type(exc).__name__,
            'detail':str(exc).split('https://')[0][:180]})
    result['anchor_rpc_calls']=leader.calls
    result['anchor_rpc_transcript']=leader.transcript
    result['finished_at_utc']=stamp()
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out',type=Path,required=True)
    args=p.parse_args()
    need(args.out.is_absolute() and args.out.parent.is_dir() and not args.out.exists(),
         'output requires fresh absolute path')
    result=run()
    with args.out.open('xb') as f:
        f.write(canon(result))
    print(result['status'],
          'blocks',result['first']['number'] if result['first'] else None,
          result['last']['number'] if result['last'] else None,
          'event_counts',[(p,len(v['events']),v['status'])
                          for p,v in result['sources'].items()],
          'parity',result['cross_endpoint_event_parity'])
    return 0  # negative or incomplete is a valid audited measurement, not a market PASS


if __name__=='__main__':
    raise SystemExit(main())
