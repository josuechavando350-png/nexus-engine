#!/usr/bin/env python3
"""Source-bound dual-channel ETH/USD oracle event ordering and receipt proof.

Read-only historical confirmation of the recent, time-pinned PR707 oracle
primary/secondary event families. Even a one-block gap is not a guaranteed
tradable head start or access to a builder/private oracle orderflow.
"""
from __future__ import annotations

import argparse
from hashlib import sha256
from io import BytesIO
from pathlib import Path
import json
import re
import time
from urllib.request import Request,urlopen
import zipfile

from oracle_dual_event_family_census import (
    AGGREGATOR, NEW_TRANSMISSION_TOPIC, SECONDARY_ROUND_TOPIC,
    identity, parse_event,
)
from oracle_pending_visibility_probe import strict_json,canon
import oracle_newtransmission_cadence as cadence

SOURCE_SHA = 'd3d43c38a0e54f6659957da4159daf0625a05dd934b2c3bd357f10d46456058b'
SOURCE_HEAD = 'b4c553e244eb3ac0401e2db96959938502a6935b'
MAX_EVENTS = 12
MAX_RPC = 20
PROVIDERS = {'drpc':'https://eth.drpc.org',
             'blast':'https://eth-mainnet.public.blastapi.io'}
QTY = re.compile(r'0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z')
HEX32 = re.compile(r'0x[0-9a-fA-F]{64}\Z')


def need(ok, why):
    if not ok:raise ValueError(why)


def quantity(v):
    need(type(v) is str and QTY.fullmatch(v),'bad hex quantity')
    return int(v,16)


def hash32(v):
    need(type(v) is str and HEX32.fullmatch(v),'bad bytes32 hash')
    return v.lower()


def auth_zip(body):
    need(type(body) is bytes and len(body)<15_000_000,'invalid ZIP input size/type')
    need(sha256(body).hexdigest()==SOURCE_SHA,'PR707 source digest mismatch')
    with zipfile.ZipFile(BytesIO(body)) as z:
        names=[x.filename for x in z.infolist() if not x.is_dir()]
        need(len(names)==len(set(names)) and len(names)<=45,'duplicate/oversized ZIP')
        need(sum(x.file_size for x in z.infolist())<30_000_000,
             'source decompression budget exceeded')
        need('manifest.sha256' in names,'source manifest missing')
        signed={}
        for line in z.read('manifest.sha256').decode().splitlines():
            digest,sep,name=line.partition('  ')
            need(sep=='  ' and re.fullmatch('[0-9a-f]{64}',digest)
                 and name.startswith('./') and '..' not in Path(name).parts,
                 'malformed manifest')
            key=name[2:]
            need(key not in signed,'duplicate manifest item')
            signed[key]=digest
        need(set(names)-{'manifest.sha256'}==set(signed),
             'not all ZIP members authenticated')
        for name,digest in signed.items():
            need(sha256(z.read(name)).hexdigest()==digest,
                 'producer source evidence mutated '+name)
        need(z.read('code-commit.txt').decode().strip()==SOURCE_HEAD,
             'PR707 producer commit mismatch')
        report=strict_json(z.read('dual-event-census.json'))
    need(report['status']=='SINGLE_SOURCE_DUAL_FAMILY_DESCRIPTIVE_ONLY'
         and report['cross_endpoint_event_parity'] is False,
         'PR707 producer state drift or unauthorized parity promotion')
    need(report['sources']['drpc']['status']=='COMPLETE_DUAL_FAMILY_PINNED_CENSUS'
         and report['sources']['blast']['status']=='INCOMPLETE_DUAL_FAMILY_SOURCE',
         'producer source limits changed')
    need(report['positive_control']['pr705_zip_sha256']==
         '4f817f9b9c889ffb983c395d2f6e2d9bc3aed387ec34bfc70dafdb60bfd53121',
         'historical positive control not bound')
    need(report['net_capture_pnl_proven'] is False and
         report['RMC_closed'] is False and
         report['nqc_realized_pnl_usd']=='0',
         'producer commercialization authority drift')
    events=report['sources']['drpc']['events']
    need(type(events) is list and len(events)==4,
         'expected exact four recent dual-family events')
    need(len({identity(e) for e in events})==len(events),
         'duplicate source event')
    counts=report['one_source_descriptive_summary']
    need(counts['primary_newtransmission_events']==2 and
         counts['secondary_round_update_events']==2,
         'dual family counts changed')
    groups=group_rounds(events)
    need(len(groups)==2 and all(len(v['PRIMARY_NEW_TRANSMISSION'])==1 and
                                len(v['SECONDARY_ROUND_ID_UPDATED'])==1
                                for v in groups.values()),
         'cannot uniquely associate report and secondary round')
    return report,events,groups


def group_rounds(events):
    groups={}
    for item in events:
        need(type(item) is dict and item['event_family'] in
             ('PRIMARY_NEW_TRANSMISSION','SECONDARY_ROUND_ID_UPDATED'),
             'invalid event family')
        rid=item['round_id']
        need(type(rid) is int and 0<=rid<2**32,'round id invalid')
        g=groups.setdefault(rid,{'PRIMARY_NEW_TRANSMISSION':[],
                                 'SECONDARY_ROUND_ID_UPDATED':[]})
        g[item['event_family']].append(item)
    return groups


def verify_receipt(raw,item,canonical_block):
    need(type(raw) is dict and
         str(raw.get('transactionHash','')).lower()==item['transaction_hash'] and
         quantity(raw.get('blockNumber'))==item['block_number'] and
         hash32(raw.get('blockHash'))==item['block_hash']==
         canonical_block['hash'] and
         quantity(raw.get('status'))==1,'transaction receipt not canonical/successful')
    index=quantity(raw.get('transactionIndex'))
    gas=quantity(raw.get('gasUsed'))
    gas_price=quantity(raw.get('effectiveGasPrice'))
    need(index>=0 and gas>0 and gas_price>0,'missing transaction order/gas')
    logs=raw.get('logs')
    need(type(logs) is list and len(logs)<2000,'invalid receipt log array')
    matches=[v for v in logs if type(v) is dict and
             str(v.get('address','')).lower()==AGGREGATOR and
             quantity(v.get('logIndex'))==item['log_index']]
    need(len(matches)==1,'oracle event missing/duplicated in receipt')
    parsed=parse_event(matches[0],item['block_number'],item['block_number'])
    for name in ('block_number','block_hash','transaction_hash','log_index',
                 'event_family','topic0','round_id','price_answer_raw',
                 'event_data_sha256'):
        need(parsed[name]==item[name], 'receipt/producer mismatch '+name)
    return {'tx_hash':item['transaction_hash'],
            'block':item['block_number'],
            'block_hash':item['block_hash'],
            'timestamp':canonical_block['timestamp'],
            'transaction_index':index,'global_log_index':item['log_index'],
            'round_id':item['round_id'],'event_family':item['event_family'],
            'receipt_gas_used':gas,
            'receipt_effective_gas_price_wei':gas_price,
            'receipt_event_content_matches_source':True}


class RPC:
    def __init__(self,provider,transport=None):
        need(provider in PROVIDERS,'unapproved provider')
        self.provider=provider;self.url=PROVIDERS[provider]
        self.transport=transport or self.network
        self.calls=0;self.records=[]

    def network(self,method,params):
        need(method in ('eth_chainId','eth_getBlockByNumber','eth_getTransactionReceipt'),
             'non-read-only request')
        req=Request(self.url,method='POST',
                    data=json.dumps({'jsonrpc':'2.0','id':18,'method':method,'params':params}).encode(),
                    headers={'Content-Type':'application/json',
                             'User-Agent':'NQC-Oracle-Round-Ordering-ReadOnly/1'})
        with urlopen(req,timeout=24) as response:
            body=response.read(3_000_001)
        need(len(body)<=3_000_000,'oversized receipt/header')
        obj=strict_json(body)
        need(type(obj) is dict and obj.get('jsonrpc')=='2.0' and
             obj.get('id')==18 and 'result' in obj and 'error' not in obj,
             'RPC source failed or malformed')
        return obj['result']

    def call(self,method,params,allowed_hashes=None,allowed_blocks=None):
        need(self.calls<MAX_RPC,'read-only request quota exhausted')
        if method=='eth_chainId':
            need(params==[],'invalid chain request')
        elif method=='eth_getTransactionReceipt':
            need(type(params) is list and len(params)==1 and
                 type(params[0]) is str and HEX32.fullmatch(params[0]) and
                 allowed_hashes is not None and params[0].lower() in allowed_hashes,
                 'unbounded receipt query')
        elif method=='eth_getBlockByNumber':
            need(type(params) is list and len(params)==2 and
                 type(params[0]) is str and QTY.fullmatch(params[0])
                 and params[1] is False and
                 allowed_blocks is not None and quantity(params[0]) in allowed_blocks,
                 'unbounded historical header query')
        else:raise ValueError('non-read-only or unknown method')
        self.calls+=1
        rec={'method':method,'params':params}
        try:
            if self.transport==self.network:
                time.sleep(0.6)
            obj=self.transport(method,params)
            rec['result_sha256']=sha256(canon(obj)).hexdigest()
            return obj
        except Exception as exc:
            rec['error_type']=type(exc).__name__
            rec['detail']=str(exc).split('https://')[0][:180]
            raise
        finally:
            self.records.append(rec)


def survey(provider,items,transport=None):
    rpc=RPC(provider,transport)
    out={'provider':provider,'status':'INCOMPLETE_RECEIPT_SOURCE','results':[],
         'errors':[],'independent_rpc_operator_proven':False}
    heights={e['block_number'] for e in items}
    hashes={e['transaction_hash'] for e in items}
    try:
        need(quantity(rpc.call('eth_chainId',[]))==1,'wrong chain ID')
        headers={}
        for n in sorted(heights):
            h=cadence.canonical_header(
                rpc.call('eth_getBlockByNumber',[hex(n),False],
                         allowed_blocks=heights),n)
            headers[n]=h
        for e in items:
            head=headers[e['block_number']]
            need(head['hash']==e['block_hash'] and
                 head['timestamp']==e['block_timestamp'],
                 'block source identity changed')
            row=rpc.call('eth_getTransactionReceipt',[e['transaction_hash']],
                         allowed_hashes=hashes)
            out['results'].append(verify_receipt(row,e,head))
        for n in sorted(heights):
            new=cadence.canonical_header(
                rpc.call('eth_getBlockByNumber',[hex(n),False],
                         allowed_blocks=heights),n)
            need(new==headers[n],'reorg during receipt verification')
        out['results'].sort(key=lambda x:(x['block'],x['transaction_index'],
                                          x['global_log_index']))
        out['status']='ALL_FOUR_RECEIPTS_CANONICAL_ORDER_VERIFIED'
    except Exception as exc:
        out['errors'].append({'type':type(exc).__name__,
            'detail':str(exc).split('https://')[0][:200]})
    out['rpc_calls_used']=rpc.calls
    out['rpc_transcript']=rpc.records
    return out


def round_pairs(receipts):
    groups={}
    for e in receipts:
        groups.setdefault(e['round_id'],{}).setdefault(e['event_family'],[]).append(e)
    result=[]
    for rid,g in sorted(groups.items()):
        need(len(g.get('PRIMARY_NEW_TRANSMISSION',[]))==1 and
             len(g.get('SECONDARY_ROUND_ID_UPDATED',[]))==1,
             'unmatched round report+secondary synchronization')
        p=g['PRIMARY_NEW_TRANSMISSION'][0]
        s=g['SECONDARY_ROUND_ID_UPDATED'][0]
        block_gap=s['block']-p['block']
        ordering=('SECONDARY_AFTER_PRIMARY_SAME_BLOCK'
                  if block_gap==0 and s['transaction_index']>p['transaction_index'] else
                  'SECONDARY_AFTER_PRIMARY_FUTURE_BLOCK'
                  if block_gap>0 else
                  'SECONDARY_BEFORE_OR_SAME_TRANSACTION_UNKNOWN')
        result.append({'round_id':rid,
            'primary':{'tx_hash':p['tx_hash'],'block':p['block'],
                       'transaction_index':p['transaction_index']},
            'secondary':{'tx_hash':s['tx_hash'],'block':s['block'],
                         'transaction_index':s['transaction_index']},
            'block_height_difference_secondary_minus_primary':block_gap,
            'block_timestamp_difference_seconds':s['timestamp']-p['timestamp'],
            'ordering':ordering,
            'wall_clock_builder_available_lead_proven':False,
            'aave_hf_crossing_proven':False})
    return result


def run(raw_source,transport_factory=None):
    out={'schema_version':1,
         'status':'INCOMPLETE_ORACLE_ROUND_TRANSACTION_ORDER',
         'producer_pr707_zip_sha256':SOURCE_SHA,
         'sources':{},'cross_endpoint_receipt_parity':False,
         'source_lookahead_selection_of_winners':False,
         'rounds':[],'errors':[],
         'pending_first_seen_by_any_operator_proven':False,
         'available_same_block_ordering_proven':False,
         'profitable_aave_liquidation_capture_proven':False,
         'native_gas_external_nonrecourse_proven':False,
         'RMC_closed':False,'P2_shadow_certified':False,
         'canary_live_authorized':False,'commercial_score_upgrade':False,
         'nqc_realized_pnl_usd':'0'}
    try:
        producer,events,groups=auth_zip(raw_source)
        for name in ('drpc','blast'):
            out['sources'][name]=survey(name,events,
                transport_factory(name) if transport_factory else None)
        a,b=out['sources']['drpc'],out['sources']['blast']
        if a['status']=='ALL_FOUR_RECEIPTS_CANONICAL_ORDER_VERIFIED':
            out['rounds']=round_pairs(a['results'])
        if a['status']=='ALL_FOUR_RECEIPTS_CANONICAL_ORDER_VERIFIED' and \
           b['status']=='ALL_FOUR_RECEIPTS_CANONICAL_ORDER_VERIFIED':
            if a['results']==b['results']:
                out['cross_endpoint_receipt_parity']=True
                out['status']='TWO_ENDPOINT_ORACLE_ROUND_ORDER_RECONCILED_NO_CAPTURE'
            else:
                out['status']='MISMATCH_ORACLE_RECEIPT_ORDER_NO_AUTHORITY'
                out['errors'].append('TWO_RPC_RECEIPT_STATE_MISMATCH')
        elif a['status']=='ALL_FOUR_RECEIPTS_CANONICAL_ORDER_VERIFIED':
            out['status']='SINGLE_ENDPOINT_ROUND_ORDER_DESCRIPTIVE_ONLY'
    except Exception as exc:
        out['errors'].append(type(exc).__name__+':'+str(exc)[:200])
    return out


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--producer-artifact',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args()
    need(args.out.is_absolute() and args.out.parent.is_dir() and not args.out.exists(),
         'fresh absolute output required')
    report=run(args.producer_artifact.read_bytes())
    with args.out.open('xb') as f:f.write(canon(report))
    print(report['status'],'pairs',len(report['rounds']),
          'sources',[(k,v['status']) for k,v in report['sources'].items()])
    return 0


if __name__=='__main__':
    raise SystemExit(main())
