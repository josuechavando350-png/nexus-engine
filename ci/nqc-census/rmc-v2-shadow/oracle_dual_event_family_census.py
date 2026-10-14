#!/usr/bin/env python3
"""Source-bound two-event-family ETH/USD DualAggregator truth (NO TRADE).

Corrects the historically wrong NewTransmission topic used in earlier probes.
Separately enumerates primary NewTransmission price reports and secondary-round
synchronization notifications. A secondary event has no price answer itself.
Scans a preselected 720-block recent window, with historical positive controls
from PR705, block-hash-pinned log validation, a mismatch ledger and no profit claims.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import statistics
import zipfile

import oracle_newtransmission_cadence as old
from oracle_ws_inclusion_audit import AGGREGATOR, NEW_TRANSMISSION_TOPIC, SECONDARY_ROUND_TOPIC

PR705_ZIP_SHA = '4f817f9b9c889ffb983c395d2f6e2d9bc3aed387ec34bfc70dafdb60bfd53121'
PR705_HEAD = '7a0f089c69a288f81089df7d7c51809d99f24b2e'
SUPERSEDED_TOPIC = '0xf6a97944f31ea060dfde0566e4167c1a1082551e64b60ecb14d599a9d023d451'
FAMILIES = {'PRIMARY_NEW_TRANSMISSION': NEW_TRANSMISSION_TOPIC,
            'SECONDARY_ROUND_ID_UPDATED': SECONDARY_ROUND_TOPIC}
EXPECTED_HISTORICAL_TX = {
    '0x20dd5bccadb185dbac34c94c8d00bf363a4a0b779fe1fddcdcfd8a3066d96c8b':
        {'block': 26142067, 'topics': {SECONDARY_ROUND_TOPIC}},
    '0x8195ce367cbf91e713b487af24dcb004def69e1c7ac9f62ce2aaedba04c4566b':
        {'block': 26149038, 'topics': {SECONDARY_ROUND_TOPIC,
                                        NEW_TRANSMISSION_TOPIC}},
}
MAX_PER_SHARD_PER_FAMILY = 80
MAX_EVENTS = 250
MAX_EVENT_BLOCKS = 68
HEX = re.compile(r'0x(?:[0-9a-fA-F]{2})*\Z')
DIGEST = re.compile(r'[0-9a-f]{64}\Z')


def need(value, why):
    if not value:
        raise ValueError(why)


def stamp():
    return datetime.now(timezone.utc).isoformat()


def canonical_json(data):
    return old.canon(data)


def authenticate_historical(body):
    need(type(body) is bytes and len(body) <= 15_000_000, 'invalid PR705 ZIP size/type')
    need(sha256(body).hexdigest() == PR705_ZIP_SHA, 'PR705 artifact digest mismatch')
    with zipfile.ZipFile(BytesIO(body)) as z:
        entries=z.infolist()
        names=[i.filename for i in entries if not i.is_dir()]
        need(len(names)==len(set(names)) and len(names)<=40,'duplicate or oversized member set')
        need(sum(i.file_size for i in entries)<=20_000_000,'archive decompression budget exceeded')
        need('manifest.sha256' in names,'missing source artifact manifest')
        manifest={}
        for line in z.read('manifest.sha256').decode().splitlines():
            digest,sep,name=line.partition('  ')
            need(sep=='  ' and DIGEST.fullmatch(digest), 'bad source manifest line')
            need(name.startswith('./') and '..' not in Path(name).parts,
                 'source archive path unsafe')
            key=name[2:]
            need(key not in manifest and key!='manifest.sha256','manifest duplicate')
            manifest[key]=digest
        need(set(manifest)==set(names)-{'manifest.sha256'},'archive members mismatch')
        for name,digest in manifest.items():
            need(sha256(z.read(name)).hexdigest()==digest,'archive tamper: '+name)
        need(z.read('code-commit.txt').decode().strip()==PR705_HEAD,
             'producer source head changed')
        source=old.strict_json(z.read('weth-oracle-dynamic-topology.json'))
    need(source.get('status')=='TWO_ENDPOINT_CURRENT_AAVE_ORACLE_TOPOLOGY_PARITY_ONLY'
         and source.get('cross_source_parity') is True,'PR705 two-RPC proof not certified')
    need(source.get('nqc_realized_pnl_usd')=='0' and
         source.get('net_capture_proven') is False and
         source.get('RMC_closed') is False and
         source.get('P2_shadow_certified') is False, 'source no-claims drift')
    providers=source.get('sources')
    need(type(providers) is dict and set(providers)=={'drpc','blast'},
         'PR705 source set drift')
    witnessed=[]
    for provider in ('drpc','blast'):
        data=providers[provider]
        need(data['status']=='SOURCE_VERIFIED_HISTORIC_TOPICS_AND_CURRENT_TOPOLOGY'
             and data['errors']==[],'PR705 provider not authenticated')
        t=data['topology']
        need(t['static_target_matches'] is True and
             t['source_underlying_aggregator']==AGGREGATOR,
             'historical positive target no longer resolved at producer pin')
        txs=data['historical_receipts']
        need(type(txs) is list and len(txs)==2,'historical receipt cardinality')
        for row in txs:
            key=row['tx_hash']
            need(key in EXPECTED_HISTORICAL_TX,'unexpected historical positive')
            expected=EXPECTED_HISTORICAL_TX[key]
            actual={x['topic0'] for x in row['logs']}
            need(row['block']==expected['block'] and
                 expected['topics'].issubset(actual),
                 'historical emitted topics disagree with the claimed event families')
            if key=='0x20dd5bccadb185dbac34c94c8d00bf363a4a0b779fe1fddcdcfd8a3066d96c8b':
                need(NEW_TRANSMISSION_TOPIC not in actual,
                     'USDC secondary-only historical path unexpectedly changed')
            need(row['contains_expected_new_transmission_topic'] is False,
                 'PR705 original wrong-topic conclusion unexpectedly changed')
            witnessed.append((provider,key,tuple(sorted(actual))))
    need(len(witnessed)==4,'missing source-bound positive controls')
    need(NEW_TRANSMISSION_TOPIC != SUPERSEDED_TOPIC and
         NEW_TRANSMISSION_TOPIC in EXPECTED_HISTORICAL_TX[
             '0x8195ce367cbf91e713b487af24dcb004def69e1c7ac9f62ce2aaedba04c4566b'
         ]['topics'],'corrected topic not authenticated by actual historic tx')
    return {'pr705_zip_sha256':PR705_ZIP_SHA,
            'pr705_commit':PR705_HEAD,
            'pr705_anchor':source['anchor'],
            'historical_two_endpoint_positive_controls':witnessed,
            'old_newtransmission_topic_disproven':SUPERSEDED_TOPIC,
            'newtransmission_topic_verified':NEW_TRANSMISSION_TOPIC,
            'secondary_round_topic_verified':SECONDARY_ROUND_TOPIC,
            'source_snapshot_not_current_for_new_window':True,
            'manifest_members_verified':len(manifest)}


def parse_event(log,lo,hi):
    need(type(log) is dict and str(log.get('address','')).lower()==AGGREGATOR,
         'oracle address mismatch')
    topics=log.get('topics')
    need(type(topics) is list and len(topics)==2,'unexpected event indexed topic count')
    topic=old.hash32(topics[0])
    need(topic in set(FAMILIES.values()),'not authenticated oracle event family')
    round_id=int(old.hash32(topics[1]),16)
    need(0<=round_id<2**32,'round ID outside uint32')
    block=old.num(log.get('blockNumber'))
    need(lo<=block<=hi,'event outside requested shard')
    need(log.get('removed') in (False,None),'removed/reorg event')
    data=log.get('data')
    need(type(data) is str and HEX.fullmatch(data),
         'unparseable event data')
    price=None
    if topic==NEW_TRANSMISSION_TOPIC:
        # Actual NewTransmission ABI: indexed uint32 aggregatorRoundId,
        # followed by int192 answer as first nonindexed data word.
        need(len(data)>=2+8*64,'primary report ABI too short')
        price=int(data[2:66],16)
        need(0<price<2**191,'nonpositive/out-of-range signed int192 price')
        family='PRIMARY_NEW_TRANSMISSION'
    else:
        # SecondaryRoundIdUpdated(uint32 indexed secondaryRoundId) has
        # NO answer, and cannot be used as a price-change measurement.
        need(data=='0x','secondary-round event unexpectedly carries data')
        family='SECONDARY_ROUND_ID_UPDATED'
    return {'block_number':block,'block_hash':old.hash32(log.get('blockHash')),
            'transaction_hash':old.hash32(log.get('transactionHash')),
            'log_index':old.num(log.get('logIndex')),
            'event_family':family,'topic0':topic,'round_id':round_id,
            'price_answer_raw':price,
            'event_data_sha256':sha256(bytes.fromhex(data[2:])).hexdigest()}


def identity(row):
    return (row['block_number'],row['log_index'],row['block_hash'],
            row['transaction_hash'],row['topic0'],row['event_data_sha256'])


def source_census(provider,anchor,transport=None):
    rpc=old.RPC(provider,transport)
    result={'provider':provider,'status':'INCOMPLETE_DUAL_FAMILY_SOURCE',
            'events':[],'shards_complete_by_family':{k:0 for k in FAMILIES},
            'errors':[],'rpc_operator_independence_proven':False}
    try:
        rpc.chain()
        start=rpc.at(anchor['first']['number'])
        end=rpc.at(anchor['last']['number'])
        need(start==anchor['first'] and end==anchor['last'],
             'different canonical pinned window')
        events=[]
        for lo,hi in old.shard_ranges(start['number'],end['number']):
            for family,topic in FAMILIES.items():
                rows=rpc.call('eth_getLogs',[{
                    'address':AGGREGATOR,'topics':[topic],
                    'fromBlock':hex(lo),'toBlock':hex(hi)}])
                need(type(rows) is list and len(rows)<=MAX_PER_SHARD_PER_FAMILY,
                     'missing or oversized source result')
                parsed=[parse_event(v,lo,hi) for v in rows]
                need(all(e['event_family']==family for e in parsed),
                     'source returned wrong event topic')
                events.extend(parsed)
                need(len(events)<=MAX_EVENTS,'too many oracle reports for bounded audit')
                result['shards_complete_by_family'][family]+=1
        need(len(events)==len({identity(e) for e in events}),
             'duplicate immutable on-chain event identity')
        blocks=sorted({e['block_number'] for e in events})
        need(len(blocks)<=MAX_EVENT_BLOCKS,'event headers exceeded gas-free research quota')
        verified={n:rpc.at(n) for n in blocks}
        for event in events:
            head=verified[event['block_number']]
            need(head['hash']==event['block_hash'],
                 'oracle event disagrees with canonical block hash')
            event['block_timestamp']=head['timestamp']
        need(rpc.at(start['number'])==start and
             rpc.at(end['number'])==end,'reorg during audit')
        result['events']=sorted(events,key=identity)
        result['status']='COMPLETE_DUAL_FAMILY_PINNED_CENSUS'
    except Exception as exc:
        result['errors'].append({'type':type(exc).__name__,
                    'detail':str(exc).split('https://')[0][:180]})
    finally:
        result['rpc_calls_used']=rpc.calls
        result['rpc_transcript']=rpc.transcript
    return result


def descriptive_summary(events,first_timestamp,last_timestamp):
    need(last_timestamp>first_timestamp,'invalid pinned time range')
    primary=[e for e in events if e['event_family']=='PRIMARY_NEW_TRANSMISSION']
    secondary=[e for e in events if e['event_family']=='SECONDARY_ROUND_ID_UPDATED']
    def intervals(v):
        dedup={}
        for event in v:
            dedup[event['block_number']]=event['block_timestamp']
        timestamps=sorted(dedup.items())
        return [nxt[1]-prev[1] for prev,nxt in zip(timestamps,timestamps[1:])]
    primary_by_block={}
    for e in primary:
        primary_by_block.setdefault(e['block_number'],[]).append(e)
    price_series=[max(vals,key=lambda x:x['log_index']) for _,vals in
                  sorted(primary_by_block.items())]
    bps=[(b['price_answer_raw']-a['price_answer_raw'])*10_000 //
         a['price_answer_raw'] for a,b in zip(price_series,price_series[1:])]
    ptx={e['transaction_hash'] for e in primary}
    stx={e['transaction_hash'] for e in secondary}
    pints,sints=intervals(primary),intervals(secondary)
    return {
        'scope_elapsed_seconds':last_timestamp-first_timestamp,
        'primary_newtransmission_events':len(primary),
        'secondary_round_update_events':len(secondary),
        'total_dual_family_events':len(events),
        'primary_unique_transactions':len(ptx),
        'secondary_unique_transactions':len(stx),
        'unique_transactions_union':len(ptx|stx),
        'dual_family_same_transaction_count':len(ptx&stx),
        'secondary_only_transactions':len(stx-ptx),
        'primary_only_transactions':len(ptx-stx),
        'primary_interarrival_seconds_by_event_block':pints,
        'secondary_interarrival_seconds_by_event_block':sints,
        'primary_median_interarrival_seconds':
            statistics.median(pints) if pints else None,
        'secondary_median_interarrival_seconds':
            statistics.median(sints) if sints else None,
        'primary_price_delta_bps_between_event_blocks':bps,
        'primary_price_declines_at_least_50bps':sum(x<=-50 for x in bps),
        'secondary_event_has_no_price_answer':True,
        'observed_events_are_not_actionable_aave_liquidations':True,
        'future_frequency_or_capture_probability_calibrated':False,
    }


def run(historical_body,transport_factory=None):
    report={'schema_version':1,
            'status':'INCOMPLETE_DUAL_FAMILY_ORACLE_SOURCE_CENSUS',
            'started_at_utc':stamp(),
            'positive_control':None,'anchor':None,
            'sources':{},'cross_endpoint_event_parity':False,'mismatch_ledger':[],
            'one_source_descriptive_summary':None,
            'two_source_descriptive_summary':None,
            'window_selection_precedes_event_query':True,
            'does_not_use_winning_transaction_to_select_window':True,
            'historical_wrong_topic_zero_findings_invalidated':True,
            'oracle_source_active_at_current_tip_verified':False,
            'future_signal_public_mempool_visibility_proven':False,
            'prospective_aave_hf_trigger_proven':False,
            'competing_builder_inclusion_proven':False,
            'full_transaction_gas_authenticated':False,
            'external_nonrecourse_gas_sponsorship_proven':False,
            'net_capture_pnl_proven':False,
            'RMC_closed':False,'P2_shadow_certified':False,
            'canary_live_authorized':False,'commercial_score_upgrade':False,
            'nqc_realized_pnl_usd':'0'}
    try:
        report['positive_control']=authenticate_historical(historical_body)
        primary=old.RPC('drpc',transport_factory('drpc') if transport_factory else None)
        primary.chain()
        tip=primary.call('eth_getBlockByNumber',['latest',False])
        stable_end=old.num(tip['number'])-old.CONFIRM_DEPTH
        first=stable_end-old.WINDOW_BLOCKS+1
        need(first>0,'invalid stable anchor')
        anchor={'first':primary.at(first),'last':primary.at(stable_end)}
        need(anchor['last']['timestamp']>anchor['first']['timestamp'],
             'invalid time span')
        report['anchor']=anchor
        for provider in ('drpc','blast'):
            report['sources'][provider]=source_census(provider,anchor,
                    transport_factory(provider) if transport_factory else None)
        a,b=report['sources']['drpc'],report['sources']['blast']
        if a['status']=='COMPLETE_DUAL_FAMILY_PINNED_CENSUS':
            report['one_source_descriptive_summary']=descriptive_summary(
                a['events'],anchor['first']['timestamp'],anchor['last']['timestamp'])
        if (a['status']=='COMPLETE_DUAL_FAMILY_PINNED_CENSUS' and
            b['status']=='COMPLETE_DUAL_FAMILY_PINNED_CENSUS'):
            if a['events']==b['events']:
                report['cross_endpoint_event_parity']=True
                report['two_source_descriptive_summary']=report['one_source_descriptive_summary']
                report['status']='TWO_ENDPOINT_DUAL_FAMILY_PINNED_CENSUS_NO_CAPTURE'
            else:
                report['mismatch_ledger'].append('PRIMARY_SECONDARY_EVENT_SET_DIFFERENCE')
                report['status']='MISMATCH_DUAL_FAMILY_NO_SOURCE_AUTHORITY'
        elif a['status']=='COMPLETE_DUAL_FAMILY_PINNED_CENSUS':
            report['status']='SINGLE_SOURCE_DUAL_FAMILY_DESCRIPTIVE_ONLY'
        else:
            report['status']='INCOMPLETE_DUAL_FAMILY_ORACLE_SOURCE_CENSUS'
        report['anchor_rpc_calls']=primary.calls
        report['anchor_rpc_transcript']=primary.transcript
    except Exception as exc:
        report['mismatch_ledger'].append('AUTH_OR_PIN_FAILURE_'+type(exc).__name__+':'+str(exc)[:200])
    report['finished_at_utc']=stamp()
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--historical-artifact',type=Path,required=True)
    p.add_argument('--out',type=Path,required=True)
    args=p.parse_args()
    need(args.out.is_absolute() and args.out.parent.is_dir() and not args.out.exists(),
         'append-only absolute output path required')
    result=run(args.historical_artifact.read_bytes())
    with args.out.open('xb') as f:
        f.write(canonical_json(result))
    counts=result['one_source_descriptive_summary']
    print(result['status'], 'dual_events', counts['total_dual_family_events'] if counts else 'UNKNOWN',
          'primary', counts['primary_newtransmission_events'] if counts else 'UNKNOWN',
          'secondary', counts['secondary_round_update_events'] if counts else 'UNKNOWN',
          'source_parity',result['cross_endpoint_event_parity'])
    return 0  # research completion is NOT a market/capture authority


if __name__=='__main__':
    raise SystemExit(main())
