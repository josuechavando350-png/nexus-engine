#!/usr/bin/env python3
"""Canonical Ethereum Aave V3 Withdraw-event owners -> live risk at fixed block.

Pure read-only; a Withdraw is not necessarily a collateral/risk reduction, and
post-inclusion HF is neither early notification nor executable liquidation.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
import re
import time

import prospective_recent_borrow_cohort as borrow

POOL=borrow.POOL
# IPool.sol Withdraw(address indexed reserve,address indexed user,
# address indexed to,uint256 amount). Topic from Ethereum Aave V3 receipts.
# The transaction recipient need not equal the collateral owner (topic[2]).
WITHDRAW_TOPIC='0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7'
WINDOW_BLOCKS=borrow.WINDOW_BLOCKS
MAX_EVENTS=borrow.MAX_LOG_EVENTS
# Completeness-preserving cap: one distinct event block must have >=1 event.
# Keep every event-bearing canonical header; earlier cap 105 censored source.
MAX_EVENT_BLOCKS=min(MAX_EVENTS, WINDOW_BLOCKS)
CANONICAL_HEADER_PARTITION=96
MAX_COHORT=borrow.MAX_RECENT_ACCOUNTS
MAX_CONTROLS=borrow.MAX_RECEIPT_CONTROLS
# Upper bound per source: initial + repinned chain/tips (4), source
# boundary headers (4), 16 log shards, <=320 event-bearing headers,
# <=2 receipt checks, state anchor+before+after headers (3), <=64 HF reads.
# Derived maximum = 4 + 4 + 16 + 320 + 2 + 3 + 64 = 413.
MAX_RPC_CALLS=4+4+16+MAX_EVENT_BLOCKS+MAX_CONTROLS+3+MAX_COHORT
DATA_WORD=re.compile(r'0x[0-9a-fA-F]{64}\Z')

class Rejected(ValueError):
    pass

def need(ok, reason):
    if not ok: raise Rejected(reason)

def now():
    return datetime.now(timezone.utc).isoformat()

def parse_withdraw(raw,first,last):
    need(type(raw) is dict and type(raw.get('address')) is str and
         raw['address'].lower()==POOL,'not Aave mainnet pool')
    topics=raw.get('topics')
    need(type(topics) is list and len(topics)==4 and
         borrow.b32(topics[0],'Withdraw topic')==WITHDRAW_TOPIC,
         'not authenticated Withdraw event')
    reserve=borrow.addr_topic(topics[1],'reserve')
    user=borrow.addr_topic(topics[2],'asset owner')
    to=borrow.addr_topic(topics[3],'asset recipient')
    data=raw.get('data')
    need(type(data) is str and DATA_WORD.fullmatch(data),
         'Withdraw requires one uint256 amount ABI word')
    amount=int(data,16)
    need(amount>0,'zero Withdraw event amount')
    number=borrow.qty(raw.get('blockNumber'),'Withdraw block')
    need(first<=number<=last and raw.get('removed') in (None,False),
         'removed or out-of-range Withdraw log')
    return {'block_number':number,
            'block_hash':borrow.b32(raw.get('blockHash'),'block hash'),
            'tx_hash':borrow.b32(raw.get('transactionHash'),'tx hash'),
            'tx_index':borrow.qty(raw.get('transactionIndex'),'tx index'),
            'log_index':borrow.qty(raw.get('logIndex'),'log index'),
            'reserve':reserve, 'owner':user,'recipient':to,
            'amount_raw':str(amount),
            'raw_event_sha256':sha256(borrow.canon({
                'topics':[x.lower() for x in topics],
                'data':data.lower(),'address':POOL})).hexdigest(),
            'source_event_is_not_automatically_effective_collateral':True}

def event_id(e):
    return (e['block_number'],e['tx_index'],e['log_index'],e['tx_hash'])

class RPC(borrow.RPC):
    def __init__(self,provider,transport=None):
        super().__init__(provider,transport,call_budget=MAX_RPC_CALLS)

    def call(self,method,params,allowed_borrowers=None):
        if method!='eth_getLogs':
            return super().call(method,params,allowed_borrowers)
        need(self.calls<MAX_RPC_CALLS,'source request quota exceeded')
        need(type(params) is list and len(params)==1 and
             type(params[0]) is dict and
             set(params[0])=={'address','topics','fromBlock','toBlock'},
             'Withdraw logs input shape invalid')
        f=params[0]
        lo=borrow.qty(f.get('fromBlock'),'from')
        hi=borrow.qty(f.get('toBlock'),'to')
        need(f['address']==POOL and f['topics']==[WITHDRAW_TOPIC] and
             0<=hi-lo<borrow.LOG_SHARD_BLOCKS,
             'unexpected topic/emitter or unbounded Withdraw logs scan')
        self.calls+=1
        began=time.monotonic_ns()
        record={'source_id':self.provider, 'method':'eth_getLogs',
                'params':params,'started_at_utc':now()}
        try:
            if self.transport==self.network:time.sleep(.30)
            response=self.transport(self.url,method,params)
            record['result_sha256']=sha256(borrow.canon(response)).hexdigest()
            return response
        except Exception as exc:
            record['error_type']=type(exc).__name__
            record['detail']=str(exc).split('https://')[0][:160]
            raise
        finally:
            record['elapsed_ns']=time.monotonic_ns()-began
            record['completed_at_utc']=now()
            self.transcript.append(record)

def verify_receipt(receipt,event):
    need(type(receipt) is dict and
         borrow.b32(receipt.get('transactionHash'),'receipt hash')==event['tx_hash'] and
         borrow.b32(receipt.get('blockHash'),'receipt blockhash')==event['block_hash'] and
         borrow.qty(receipt.get('blockNumber'),'receipt block')==event['block_number'] and
         borrow.qty(receipt.get('transactionIndex'),'receipt tx index')==event['tx_index'] and
         borrow.qty(receipt.get('status'),'receipt status')==1 and
         borrow.qty(receipt.get('gasUsed'),'receipt gas')>0 and
         borrow.qty(receipt.get('effectiveGasPrice'),'receipt paid fee')>0,
         'Withdraw receipt does not prove successful canonical tx')
    logs=receipt.get('logs')
    need(type(logs) is list and len(logs)<15000,'receipt logs absent/oversized')
    found=[parse_withdraw(x,event['block_number'],event['block_number'])
           for x in logs if type(x) is dict and
           type(x.get('address')) is str and x['address'].lower()==POOL and
           type(x.get('topics')) is list and x['topics'] and
           x['topics'][0].lower()==WITHDRAW_TOPIC and
           x.get('logIndex')==hex(event['log_index'])]
    need(len(found)==1 and found[0]==event,
         'canonical receipt lacks exact Withdraw event identity')
    return {'tx_hash':event['tx_hash'],'block_hash':event['block_hash'],
            'log_index':event['log_index'],'owner':event['owner'],
            'receipt_successful':True,'original_tx_paid_gas_not_nqc_gas':True}

def scan(rpc,first,last):
    out={'status':'INCOMPLETE_WITHDRAW_SOURCE','provider':rpc.provider,
         'events':[],'errors':[],'shards_complete':0,'positive_receipts':[]}
    try:
        first_header=rpc.get_header(first)
        last_header=rpc.get_header(last)
        out['first_header']=first_header
        out['last_header']=last_header
        events=[]
        for lo,hi in borrow.shards(first,last):
            raw=rpc.call('eth_getLogs',[{
                'address':POOL,'topics':[WITHDRAW_TOPIC],
                'fromBlock':hex(lo),'toBlock':hex(hi)}])
            need(type(raw) is list and len(raw)<=MAX_EVENTS,
                 'source Withdraw log shard invalid/over cap')
            events.extend(parse_withdraw(x,lo,hi) for x in raw)
            need(len(events)<=MAX_EVENTS,'too many Withdraw logs')
            out['shards_complete']+=1
        events.sort(key=event_id)
        need(len(events)==len(set(event_id(x) for x in events)),
             'duplicate same Withdraw log')
        blocks=sorted({x['block_number'] for x in events})
        need(len(blocks)<=MAX_EVENT_BLOCKS,'too many Withdraw event-bearing blocks')
        # Independent deterministic partitions. No header is sampled, skipped
        # or inferred from a provider's eth_getLogs response.
        heads={}
        out['canonical_header_partitions']=[]
        for offset in range(0,len(blocks),CANONICAL_HEADER_PARTITION):
            part=blocks[offset:offset+CANONICAL_HEADER_PARTITION]
            group={n:rpc.get_header(n) for n in part}
            need(len(group)==len(part) and not (set(group)&set(heads)),
                 'duplicated/missing event-bearing header identities')
            heads.update(group)
            out['canonical_header_partitions'].append({
                'number_of_distinct_event_blocks':len(part),
                'lowest_event_block':part[0],
                'highest_event_block':part[-1],
                'all_headers_authenticated':True})
        need(len(heads)==len(blocks),'not all event-bearing blocks were checked')
        for item in events:
            need(item['block_hash']==heads[item['block_number']]['hash'],
                 'Withdraw log block hash not canonical')
        out['event_blocks_verified']=len(blocks)
        for tx in dict.fromkeys(x['tx_hash'] for x in events):
            if len(out['positive_receipts'])>=MAX_CONTROLS:break
            match=next(x for x in events if x['tx_hash']==tx)
            proof=verify_receipt(rpc.call('eth_getTransactionReceipt',[tx]),match)
            out['positive_receipts'].append(proof)
        need(first_header==rpc.get_header(first) and
             last_header==rpc.get_header(last),'reorg during Withdraw source scan')
        out['events']=events
        out['status']='COMPLETE_CANONICAL_WITHDRAW_EVENTS'
    except Exception as exc:
        out['errors'].append({'kind':type(exc).__name__,
                              'detail':str(exc).split('https://')[0][:190]})
    return out

def select(events):
    need(type(events) is list and len(events)<=MAX_EVENTS,
         'unknown/over-cap Withdraw corpus')
    all_owners={e['owner'] for e in events}
    selection={}
    for e in sorted(events,key=event_id,reverse=True):
        if e['owner'] not in selection and len(selection)<MAX_COHORT:
            selection[e['owner']]={'borrower':e['owner'],
                'latest_withdraw_tx_hash':e['tx_hash'],
                'latest_withdraw_block':e['block_number'],
                'latest_withdraw_recipient':e['recipient'],
                'latest_withdraw_reserve':e['reserve'],
                'latest_withdraw_amount_raw':e['amount_raw'],
                'source_event_uses_indexed_user_owner_not_recipient':True,
                'no_future_HF_or_liquidation_selected':True}
    return list(selection.values()),{
        'source_withdraw_event_count':len(events),
        'distinct_withdrawing_owners':len(all_owners),
        'owners_selected_before_HF':len(selection),
        'owners_omitted_due_bounded_limit':len(all_owners)-len(selection),
        'selection_rule':'LATEST_64_DISTINCT_WITHDRAW_OWNER_BEFORE_HF',
        'withdraw_effect_on_hf_is_not_necessarily_negative':True}

def assess(rpc,pinned_head,cohort):
    need(type(cohort) is list and 0<len(cohort)<=MAX_COHORT,
         'empty/over-cap cohort')
    authorized={e['borrower'] for e in cohort}
    need(len(authorized)==len(cohort),'duplicate owner in selected Withdraw cohort')
    before=rpc.get_header(pinned_head['number'])
    need(before==pinned_head,'pinned source header mismatch')
    out=[]
    for e in cohort:
        address=e['borrower']
        raw=rpc.call('eth_call',[{
            'to':POOL,'data':borrow.call_data(address)},
            {'blockHash':before['hash'],'requireCanonical':True}],
            allowed_borrowers=authorized)
        out.append({'borrower':address,
                    'risk':borrow.decode_account(raw),
                    'source_account_sha256':sha256(raw.lower().encode()).hexdigest(),
                    'last_withdraw_event_block':e['latest_withdraw_block'],
                    'hf_drift_cause_unidentified':True,
                    'withdraw_not_proof_of_collateral_reduction':True})
    need(rpc.get_header(before['number'])==before,
         'risk source block changed during read')
    return out

def collect(transport_factory=None,unix_now=None):
    current=int(datetime.now(timezone.utc).timestamp()) if unix_now is None else unix_now
    need(type(current) is int and current>0,'current clock invalid')
    clients={k:RPC(k,transport_factory(k) if transport_factory else None)
             for k in ('drpc','publicnode')}
    report={'schema_version':1,
        'status':'INCOMPLETE_WITHDRAW_COHORT_NOT_MARKET_ABSENCE',
        'started_at_utc':now(),'chain_id':1,
        'source_event_topic0':WITHDRAW_TOPIC,
        'source_reports':{},'state_reports':{},'errors':[],
        'anchor':None,'source_cohort':[], 'selection':{},
        'hf_state_pinned_after_complete_event_discovery':True,
        'hf_state_block_may_differ_from_event_window_end':True,
        'hf_state_anchored_at':None,
        'verified_withdraw_event_count':None,
        'verified_distinct_owner_count':None,
        'verified_selected_owner_count':None,
        'verified_active_debt_accounts':None,
        'verified_no_debt_accounts':None,
        'verified_hf_lt_one_count':None,
        'verified_near_50bps_count':None,
        'verified_near_200bps_count':None,
        'verified_near_1000bps_count':None,
        'minimum_positive_debt_hf_wad':None,
        'not_all_Aave_borrowers_or_collateral_users':True,
        'only_post_inclusion_source_state_not_pending_detection':True,
        'withdraw_is_not_automatically_collateral_withdrawal':True,
        'operator_source_independence_not_established':True,
        'cold_gas_NQC_verified':False,
        'real_liquidation_route_proven':False,
        'competitive_capture_proven':False,
        'external_native_gas_sponsor_nonrecourse_proven':False,
        'net_pnl_proven':False,
        'RMC_closed':False,'P2_shadow_certified':False,
        'canary_live_authorized':False,
        'commercial_score_upgrade':False,'nqc_realized_pnl_usd':'0'}
    tips={}
    for key,rpc in clients.items():
        try:tips[key]=rpc.tip()
        except Exception as exc:
            report['errors'].append({'stage':'preflight','provider':key,
                'type':type(exc).__name__,'detail':str(exc)[:150]})
    if len(tips)==2 and max(tips.values())-min(tips.values())<=borrow.MAX_TIP_DRIFT:
        last=min(tips.values())-borrow.CONFIRMATION_DEPTH
        first=last-WINDOW_BLOCKS+1
        if first>0:
            report['anchor']={'first_block':first,'last_block':last,
                              'inclusive_blocks':WINDOW_BLOCKS,
                              'confirmation_delay_blocks':borrow.CONFIRMATION_DEPTH,
                              'source_tip_heights':tips}
            for key,rpc in clients.items():
                report['source_reports'][key]=scan(rpc,first,last)
            a,b=(report['source_reports'][key] for key in ('drpc','publicnode'))
            if a['status']==b['status']=='COMPLETE_CANONICAL_WITHDRAW_EVENTS' and\
               a['first_header']==b['first_header'] and\
               a['last_header']==b['last_header'] and a['events']==b['events']:
                selected,meta=select(a['events'])
                report['source_cohort']=selected
                report['selection']=meta
                report['anchor']['pinned_end_head']=a['last_header']
                if selected:
                    # A dense 384-block source scan can take minutes. Reading
                    # HF at that old end block would not be current risk state.
                    # Fix one NEW canonical state block after source selection,
                    # then require exact two-RPC parity at that new block.
                    new_tips={}
                    for key,rpc in clients.items():
                        try:new_tips[key]=rpc.tip()
                        except Exception as exc:
                            report['errors'].append({'stage':'state-anchor',
                                'provider':key,'why':type(exc).__name__+':'+str(exc)[:160]})
                    if len(new_tips)!=2 or max(new_tips.values())-min(new_tips.values())>borrow.MAX_TIP_DRIFT:
                        report['errors'].append({'stage':'state-anchor','why':'REPINS_DIVERGE_OR_UNAVAILABLE'})
                    else:
                        refreshed=min(new_tips.values())-borrow.CONFIRMATION_DEPTH
                        report['anchor']['fresh_state_source_tips']=new_tips
                        if refreshed<last:
                            report['errors'].append({'stage':'state-anchor','why':'STATE_PIN_PRECEDES_EVENT_WINDOW'})
                        else:
                            fresh_heads={}
                            for key,rpc in clients.items():
                                try:fresh_heads[key]=rpc.get_header(refreshed)
                                except Exception as exc:
                                    report['errors'].append({'stage':'state-anchor',
                                        'provider':key,'why':type(exc).__name__+':'+str(exc)[:160]})
                            if (len(fresh_heads)!=2 or fresh_heads['drpc']!=fresh_heads['publicnode']):
                                report['errors'].append({'stage':'state-anchor','why':'STATE_HEADERS_DIFFER'})
                            else:
                                state_head=fresh_heads['drpc']
                                report['hf_state_anchored_at']=state_head
                                report['anchor']['state_block_after_event_window_end']=refreshed-last
                                effective_now=(int(datetime.now(timezone.utc).timestamp())
                                               if unix_now is None else current)
                                diff=effective_now-state_head['timestamp']
                                if diff<0 or diff>borrow.MAX_HEADER_STALENESS:
                                    report['errors'].append({'stage':'state','why':'REFRESHED_STATE_ANCHOR_STALE_OR_FUTURE'})
                                else:
                                    for key,rpc in clients.items():
                                        try:report['state_reports'][key]={
                                            'status':'COMPLETE_STATE','accounts':assess(rpc,state_head,selected)}
                                        except Exception as exc:
                                            report['state_reports'][key]={
                                                'status':'INCOMPLETE_SOURCE','accounts':[],
                                                'error':type(exc).__name__+':'+str(exc)[:160]}
                                    final_now=(int(datetime.now(timezone.utc).timestamp())
                                               if unix_now is None else current)
                                    if final_now-state_head['timestamp']>borrow.MAX_HEADER_STALENESS:
                                        report['errors'].append({'stage':'state','why':'STATE_AGED_OUT_BEFORE_EVIDENCE_CLOSEOUT'})
                else:
                    report['state_reports']={key:{'status':'NO_WITHDRAW_EVENTS','accounts':[]}
                                             for key in clients}
            else:
                report['errors'].append({'stage':'events','why':'SOURCE_CENSORED_OR_DIFFERENT'})
        else:report['errors'].append({'stage':'anchor','why':'INVALID_TIP'})
    else:report['errors'].append({'stage':'anchor','why':'SOURCE_TIP_DIVERGENCE_OR_UNAVAILABLE'})
    for key,rpc in clients.items():
        report['source_reports'].setdefault(key,{'status':'NOT_RECONSTRUCTED','events':[],
            'positive_receipts':[],'shards_complete':0,'errors':[]})
        report['source_reports'][key]['rpc_calls_used']=rpc.calls
        report['source_reports'][key]['rpc_transcript']=rpc.transcript
    if not report['errors'] and all(
        report['source_reports'][key]['status']=='COMPLETE_CANONICAL_WITHDRAW_EVENTS'
        for key in clients):
        if not report['source_cohort']:
            report['status']='ZERO_WITHDRAW_EVENTS_ONLY_THIS_384_BLOCK_WINDOW'
            report['verified_withdraw_event_count']=0
            report['verified_distinct_owner_count']=0
            report['verified_selected_owner_count']=0
        elif all(report['state_reports'].get(k,{}).get('status')=='COMPLETE_STATE'
                 for k in clients):
            a,b=(report['state_reports'][k]['accounts'] for k in ('drpc','publicnode'))
            if a==b and len(a)==len(report['source_cohort']):
                report['status']='DUAL_RPC_RECENT_WITHDRAW_OWNERS_RISK_ONLY_NOT_P2'
                report['verified_withdraw_event_count']=report['selection']['source_withdraw_event_count']
                report['verified_distinct_owner_count']=report['selection']['distinct_withdrawing_owners']
                report['verified_selected_owner_count']=len(a)
                act=[x for x in a if int(x['risk']['total_debt_base_raw'])>0]
                report['verified_active_debt_accounts']=len(act)
                report['verified_no_debt_accounts']=sum(
                    x['risk']['status']=='NO_OUTSTANDING_DEBT_IN_PINNED_AAVE_SNAPSHOT' for x in a)
                report['verified_hf_lt_one_count']=sum(
                    x['risk']['status']=='HF_LT_ONE_BORROWER_STATE_ONLY_NEEDS_ROUTE' for x in a)
                report['verified_near_50bps_count']=sum(
                    x['risk']['status']=='HF_1_TO_1_005_PRIORITY_WATCH_ONLY' for x in a)
                report['verified_near_200bps_count']=sum(
                    x['risk']['status'] in ('HF_1_TO_1_005_PRIORITY_WATCH_ONLY',
                    'HF_1_005_TO_1_02_WATCH_ONLY') for x in a)
                report['verified_near_1000bps_count']=sum(
                    x['risk']['status'] in ('HF_1_TO_1_005_PRIORITY_WATCH_ONLY',
                    'HF_1_005_TO_1_02_WATCH_ONLY','HF_1_02_TO_1_10_WATCH_ONLY') for x in a)
                if act:
                    report['minimum_positive_debt_hf_wad']=min(
                        (int(x['risk']['health_factor_wad']) for x in act))
            else:
                report['errors'].append({'stage':'state','why':'OWNER_HF_SOURCE_MISMATCH'})
    report['finished_at_utc']=now()
    return report

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args()
    need(args.out.is_absolute() and args.out.parent.is_dir() and not args.out.exists(),
         'fresh absolute destination required')
    result=collect()
    with args.out.open('xb') as f:f.write(borrow.canon(result))
    print(result['status'],'Withdraw events',result['verified_withdraw_event_count'],
          'owners',result['verified_distinct_owner_count'],
          'selected',result['verified_selected_owner_count'],
          'active debt',result['verified_active_debt_accounts'],
          'HF<1',result['verified_hf_lt_one_count'])
    return 0

if __name__=='__main__':raise SystemExit(main())
