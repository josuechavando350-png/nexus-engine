#!/usr/bin/env python3
"""Exact-block read-only Aave WETH/USD oracle topology & tx0 log topic witnesses.

Falsifies stale static oracle routing: identify current Aave WETH source/proxy/
aggregator and compare to two historical index-zero transactions that crossed
Aave HF under pinned forks. Never broadcasts, modifies chain state, or proves
prospective inclusion, profit, or trading authority.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import time
from urllib.request import Request,urlopen

from oracle_pending_visibility_probe import canon,strict_json
from oracle_ws_inclusion_audit import NEW_TRANSMISSION_TOPIC,AGGREGATOR

POOL='0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
WETH='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
PROVIDERS={'drpc':'https://eth.drpc.org',
           'blast':'https://eth-mainnet.public.blastapi.io'}
HISTORICAL=(
    {'block':26142067,'tx':'0x20dd5bccadb185dbac34c94c8d00bf363a4a0b779fe1fddcdcfd8a3066d96c8b'},
    {'block':26149038,'tx':'0x8195ce367cbf91e713b487af24dcb004def69e1c7ac9f62ce2aaedba04c4566b'},
)
SELECTORS={'addresses_provider':'0x0542975c',
           'get_price_oracle':'0xfca513a8',
           'get_source_of_asset':'0x92bf2be0',
           'aggregator':'0x245a7bfc',
           'round':'0xfeaf968c',
           'decimals':'0x313ce567',
           'asset_price':'0xb3596f07'}
HEX32=re.compile(r'0x[0-9a-fA-F]{64}\Z')
HEX40=re.compile(r'0x[0-9a-fA-F]{40}\Z')
HEX=re.compile(r'0x(?:[0-9a-fA-F]{2})*\Z')
QTY=re.compile(r'0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z')
MAX_RPC_CALLS=50
MAX_BYTES=4_000_000


def need(yes,reason):
    if not yes:raise ValueError(reason)


def utc():
    return datetime.now(timezone.utc).isoformat()


def quantity(v):
    need(type(v) is str and QTY.fullmatch(v),'bad RPC quantity')
    return int(v,16)


def hash32(v):
    need(type(v) is str and HEX32.fullmatch(v),'bad block/hash')
    return v.lower()


def address_word(v):
    need(type(v) is str and HEX32.fullmatch(v),'bad ABI address word')
    need(v[2:26].lower()=='0'*24,'noncanonical ABI address padding')
    addr='0x'+v[-40:].lower()
    need(int(addr,16)!=0,'zero oracle address')
    return addr


def read_word(v):
    need(type(v) is str and HEX32.fullmatch(v),'bad ABI word')
    return int(v,16)


def chain_header(v,n):
    need(type(v) is dict and quantity(v.get('number'))==n,'wrong pinned height')
    h=hash32(v.get('hash'));p=hash32(v.get('parentHash'))
    t=quantity(v.get('timestamp'))
    need(h!=p and t>0,'noncanonical ancestry/time')
    return {'block':n,'hash':h,'parent_hash':p,'timestamp':t}


def parse_round(v):
    need(type(v) is str and HEX.fullmatch(v) and len(v)==2+5*64,
         'wrong Chainlink round ABI size')
    vals=[int(v[2+i*64:2+(i+1)*64],16) for i in range(5)]
    answer=vals[1] if vals[1]<2**255 else vals[1]-2**256
    need(vals[0]>0 and answer>0 and vals[3]>0 and vals[4]>0,
         'unusable round/price/time')
    return {'round_id':str(vals[0]),'answer_raw':str(answer),
            'started_at':vals[2],'updated_at':vals[3],
            'answered_in_round':str(vals[4])}


def historical_receipt(receipt,pin,head):
    need(type(receipt) is dict and
         str(receipt.get('transactionHash','')).lower()==pin['tx'] and
         quantity(receipt.get('blockNumber'))==pin['block'] and
         hash32(receipt.get('blockHash'))==head['hash'] and
         quantity(receipt.get('status'))==1 and
         quantity(receipt.get('transactionIndex'))==0,
         'historical first tx receipt mismatch')
    logs=receipt.get('logs')
    need(type(logs) is list and len(logs)<2000,'unverifiable tx receipt logs')
    matching=[]
    for log in logs:
        if type(log) is dict and str(log.get('address','')).lower()==AGGREGATOR:
            topics=log.get('topics')
            need(type(topics) is list and len(topics)>=1,'emitter without log topics')
            topic=hash32(topics[0])
            matching.append({'log_index':quantity(log.get('logIndex')),
               'topic0':topic,'is_new_transmission':topic==NEW_TRANSMISSION_TOPIC,
               'data_sha256':sha256(bytes.fromhex(log['data'][2:])).hexdigest()})
    need(len(matching)>0,'source tx0 had no DualAggregator events')
    return {'block':pin['block'],'tx_hash':pin['tx'],
            'block_hash':head['hash'],'oracle_emitted_log_count':len(matching),
            'logs':matching,
            'contains_expected_new_transmission_topic':any(
                 x['is_new_transmission'] for x in matching)}


class RPC:
    def __init__(self,provider,transport=None):
        need(provider in PROVIDERS,'unapproved provider')
        self.provider=provider
        self.url=PROVIDERS[provider]
        self.transport=transport or self.network
        self.calls=0
        self.transcript=[]

    def network(self,method,params):
        need(self.url in set(PROVIDERS.values()),'RPC provider URL drift')
        request=Request(self.url,method='POST',
                        data=json.dumps({'jsonrpc':'2.0','id':39,
                          'method':method,'params':params}).encode(),
                        headers={'Content-Type':'application/json',
                          'User-Agent':'NQC-Aave-WETH-Oracle-Topology-ReadOnly/1'})
        with urlopen(request,timeout=24) as response:
            raw=response.read(MAX_BYTES+1)
        need(len(raw)<=MAX_BYTES,'oversized RPC reply')
        result=strict_json(raw)
        need(type(result) is dict and result.get('jsonrpc')=='2.0' and
             result.get('id')==39 and 'error' not in result and
             'result' in result,'RPC source failure')
        return result['result']

    def call(self,method,params):
        need(self.calls<MAX_RPC_CALLS,'RPC quota exceeded')
        if method=='eth_chainId':
            need(params==[],'wrong chain parameters')
        elif method=='eth_getBlockByNumber':
            need(type(params) is list and len(params)==2 and
                 (params[0]=='latest' or
                  (type(params[0]) is str and QTY.fullmatch(params[0]))) and
                 params[1] is False,'unbounded block header')
        elif method=='eth_getTransactionReceipt':
            need(type(params) is list and len(params)==1 and
                 type(params[0]) is str and HEX32.fullmatch(params[0]) and
                 params[0].lower() in {p['tx'] for p in HISTORICAL},
                 'unapproved historical receipt')
        elif method=='eth_call':
            need(type(params) is list and len(params)==2 and
                 type(params[0]) is dict and
                 set(params[0])=={'to','data'} and
                 type(params[0]['to']) is str and HEX40.fullmatch(params[0]['to']) and
                 type(params[0]['data']) is str and
                 (params[0]['data'][:10] in set(SELECTORS.values())) and
                 type(params[1]) is dict and
                 set(params[1])=={'blockHash','requireCanonical'} and
                 HEX32.fullmatch(params[1]['blockHash']) and
                 params[1]['requireCanonical'] is True,
                 'noncanonical or forbidden view')
        else:
            raise ValueError('read only method allowlist')
        self.calls+=1
        record={'provider':self.provider,'method':method,'parameters':params,
                'requested_at':utc()}
        try:
            if self.transport==self.network:
                time.sleep(.55)
            data=self.transport(method,params)
            record['result_sha256']=sha256(canon(data)).hexdigest()
            return data
        except Exception as exc:
            record['error_type']=type(exc).__name__
            record['error_excerpt']=str(exc).split('https://')[0][:180]
            raise
        finally:
            record['completed_at']=utc()
            self.transcript.append(record)

    def header(self,n):
        return chain_header(self.call('eth_getBlockByNumber',[hex(n),False]),n)

    def call_at(self,to,selector,header,asset=None):
        need(selector in SELECTORS.values(),'unknown Solidity selector')
        data=selector+(WETH[2:].rjust(64,'0') if asset else '')
        need(type(to) is str and HEX40.fullmatch(to),'invalid source destination')
        return self.call('eth_call',[
            {'to':to,'data':data},
            {'blockHash':header['hash'],'requireCanonical':True}])


def topology_at(rpc,head):
    provider=address_word(rpc.call_at(POOL,SELECTORS['addresses_provider'],head))
    oracle=address_word(rpc.call_at(provider,SELECTORS['get_price_oracle'],head))
    source=address_word(rpc.call_at(oracle,SELECTORS['get_source_of_asset'],head,asset=WETH))
    price=read_word(rpc.call_at(oracle,SELECTORS['asset_price'],head,asset=WETH))
    aggregator=address_word(rpc.call_at(source,SELECTORS['aggregator'],head))
    decimals=read_word(rpc.call_at(source,SELECTORS['decimals'],head))
    round_obj=parse_round(rpc.call_at(source,SELECTORS['round'],head))
    need(0<price and 0<decimals<=36,'unusable Aave price/decimals')
    return {'block_number':head['block'],'block_hash':head['hash'],
            'addresses_provider':provider,'aave_price_oracle':oracle,
            'weth_oracle_source':source,'source_underlying_aggregator':aggregator,
            'historical_target_aggregator':AGGREGATOR,
            'static_target_matches':aggregator==AGGREGATOR,
            'aave_asset_price_raw':str(price),'source_decimals':decimals,
            'latest_round':round_obj,
            'seconds_since_last_feed_update_at_block':
               head['timestamp']-round_obj['updated_at']}


def survey(provider,anchor,transport=None):
    rpc=RPC(provider,transport)
    report={'provider':provider,'status':'INCOMPLETE_SOURCE',
            'historical_receipts':[],'topology':None,'errors':[]}
    try:
        need(quantity(rpc.call('eth_chainId',[]))==1,'wrong chain ID')
        head=rpc.header(anchor['block'])
        need(head==anchor,'current pinned header drift')
        for pin in HISTORICAL:
            h=rpc.header(pin['block'])
            receipt=rpc.call('eth_getTransactionReceipt',[pin['tx']])
            report['historical_receipts'].append(historical_receipt(receipt,pin,h))
        report['topology']=topology_at(rpc,head)
        need(rpc.header(anchor['block'])==head,'reorg after source data')
        report['status']='SOURCE_VERIFIED_HISTORIC_TOPICS_AND_CURRENT_TOPOLOGY'
    except Exception as exc:
        report['errors'].append({'type':type(exc).__name__,
           'detail':str(exc).split('https://')[0][:250]})
    report['rpc_calls']=rpc.calls
    report['transcript']=rpc.transcript
    return report


def run(transport_factory=None):
    report={'schema_version':1,'status':'INCOMPLETE_ORACLE_TOPOLOGY_AND_TOPIC_AUDIT',
            'started_at_utc':utc(),'anchor':None,
            'sources':{},'cross_source_parity':False,'mismatch':[],
            'static_oracle_target_currently_active_proven':False,
            'price_feed_report_visible_in_public_mempool_proven':False,
            'historical_fork_causality_recertified':False,
            'prospective_hf_trigger_proven':False,'net_capture_proven':False,
            'external_nonrecourse_native_gas_proven':False,
            'RMC_closed':False,'P2_shadow_certified':False,
            'canary_live_authorized':False,'commercial_score_upgrade':False,
            'nqc_realized_pnl_usd':'0'}
    first=RPC('drpc',transport_factory('drpc') if transport_factory else None)
    try:
        need(quantity(first.call('eth_chainId',[]))==1,'not Ethereum')
        latest=first.call('eth_getBlockByNumber',['latest',False])
        need(type(latest) is dict,'no latest header')
        target=quantity(latest['number'])-16
        need(target>max(pin['block'] for pin in HISTORICAL),
             'current anchor older than historical witnesses')
        report['anchor']=first.header(target)
        for provider in ('drpc','blast'):
            report['sources'][provider]=survey(provider,report['anchor'],
                transport_factory(provider) if transport_factory else None)
        a,b=report['sources']['drpc'],report['sources']['blast']
        if a['status']=='SOURCE_VERIFIED_HISTORIC_TOPICS_AND_CURRENT_TOPOLOGY' and \
           b['status']=='SOURCE_VERIFIED_HISTORIC_TOPICS_AND_CURRENT_TOPOLOGY':
            if a['historical_receipts']==b['historical_receipts'] and \
               a['topology']==b['topology']:
                report['status']='TWO_ENDPOINT_CURRENT_AAVE_ORACLE_TOPOLOGY_PARITY_ONLY'
                report['cross_source_parity']=True
            else:
                report['status']='MISMATCH_NO_ORACLE_IDENTITY_AUTHORITY'
                report['mismatch'].append('PROVIDER_TOPIC_OR_TOPOLOGY_MISMATCH')
    except Exception as exc:
        report['mismatch'].append('ANCHOR_FAILURE_'+type(exc).__name__+':'+str(exc)[:150])
    report['anchor_rpc_calls']=first.calls
    report['anchor_rpc_transcript']=first.transcript
    report['finished_at_utc']=utc()
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out',type=Path,required=True)
    args=p.parse_args()
    need(args.out.is_absolute() and args.out.parent.is_dir() and not args.out.exists(),
         'fresh absolute output required')
    report=run()
    with args.out.open('xb') as out:out.write(canon(report))
    print(report['status'],
          [(p,s['status'],
            s['topology']['source_underlying_aggregator'] if s['topology'] else None,
            [v['contains_expected_new_transmission_topic'] for v in s['historical_receipts']])
           for p,s in report['sources'].items()])
    return 0


if __name__=='__main__':
    raise SystemExit(main())
