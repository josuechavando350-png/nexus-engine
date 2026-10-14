#!/usr/bin/env python3
"""Live but bounded Aave HF triage of 50 source-authenticated historical borrowers.

This cohort is seeded from PRIOR liquidations (hindsight sampling bias).
It is NOT broad market discovery or a prospective opportunity/capture certificate.
Read only: chainId, blockNumber, exact canonical block header and Aave eth_call.
No signing, transactions, native gas, contracts, token transfers or secrets.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen

import postwindow_competition_capacity_hurdle as source
from postwindow_economic_envelope import strict_json

PROVIDERS = {
    'drpc': 'https://eth.drpc.org',
    'publicnode': 'https://ethereum-rpc.publicnode.com',
}
POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
CALL_SELECTOR = '0xbf92857c'
WAD = 10**18
MIN_CONFIRMATIONS = 3
MAX_TIP_DIVERGENCE = 12
MAX_HEADER_STALENESS = 180
MAX_CALLS_PER_SOURCE = 65
MAX_RPC_REPLY_BYTES = 1_048_576
MAX_COHORT_SIZE = 50
NEAR_50BPS = WAD * 10050 // 10000
NEAR_200BPS = WAD * 10200 // 10000
NEAR_1000BPS = WAD * 11000 // 10000
HEX32 = re.compile(r'0x[0-9a-fA-F]{64}\Z')
HEXNUM = re.compile(r'0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z')
HEX6 = re.compile(r'0x[0-9a-fA-F]{384}\Z')


class Rejected(ValueError):
    pass


def need(ok, why):
    if not ok:
        raise Rejected(why)


def now():
    return datetime.now(timezone.utc).isoformat()


def canon(obj):
    return (json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=True)+'\n').encode()


def quantity(value, why):
    need(type(value) is str and HEXNUM.fullmatch(value), 'invalid '+why)
    return int(value, 16)


def digest32(value, why):
    need(type(value) is str and HEX32.fullmatch(value), 'invalid '+why)
    return value.lower()


def build_cohort(indexed_report, source_rows):
    # Reuse PR712 source-authenticated index ranking / overlap contract.
    source.build_market_slots(indexed_report, source_rows)
    seen = {}
    for e in source_rows:
        topics = e.get('raw_topics')
        need(type(topics) is list and len(topics) == 4 and
             all(type(t) is str and HEX32.fullmatch(t) for t in topics),
             'exact four LiquidationCall event topics required')
        borrower = '0x'+topics[3][-40:].lower()
        need(borrower != '0x'+'0'*40 and
             sha256(borrower.encode()).hexdigest() == e['borrower_sha256'],
             'indexer borrower identity commitment changed')
        pair = (e['collateral_asset'], e['debt_asset'])
        historical_weth_stable = (pair[0] == source.WETH and
                                  pair[1] in (source.USDC, source.USDT))
        row=seen.setdefault(borrower,{
            'borrower':borrower, 'borrower_sha256':e['borrower_sha256'],
            'indexed_historical_liquidation_logs':0,
            'last_historical_liquidation_block':0,
            'in_historical_weth_stable_group':False,
            'historical_pairs':set(),
        })
        row['indexed_historical_liquidation_logs'] += 1
        row['last_historical_liquidation_block'] = max(
            row['last_historical_liquidation_block'], e['block'])
        row['in_historical_weth_stable_group'] |= historical_weth_stable
        row['historical_pairs'].add(pair)
    need(len(seen)==MAX_COHORT_SIZE, 'authenticated 50-address borrower seed drift')
    need(sum(v['in_historical_weth_stable_group'] for v in seen.values())==18,
         'authenticated 18-address WETH stable seed drift')
    rows = []
    for value in seen.values():
        r=dict(value)
        r['historical_pairs'] = [{'collateral':x[0],'debt':x[1]}
                                 for x in sorted(value['historical_pairs'])]
        rows.append(r)
    # Priority is defined before live state is queried. The full cohort remains
    # in scope; ordering only optimizes a bounded public RPC scan.
    rows.sort(key=lambda x:(not x['in_historical_weth_stable_group'],
                            -x['last_historical_liquidation_block'],
                            x['borrower']))
    return rows


def decode_account(raw):
    need(type(raw) is str and HEX6.fullmatch(raw),
         'Aave getUserAccountData requires six exact ABI words')
    vals=[int(raw[2+i*64:2+(i+1)*64],16) for i in range(6)]
    collateral,debt,available,lt,ltv,hf=vals
    need(lt<=10000 and ltv<=10000,
         'invalid canonical liquidation threshold/LTV BPS')
    if debt==0:
        kind='NO_OUTSTANDING_DEBT_IN_PINNED_AAVE_SNAPSHOT'
    elif hf==0:
        kind='ZERO_HF_WITH_DEBT_NEEDS_RISK_RECONSTRUCTION'
    elif hf<WAD:
        kind='HF_LT_ONE_BORROWER_STATE_ONLY_NEEDS_ROUTE'
    elif hf<=NEAR_50BPS:
        kind='HF_1_TO_1_005_PRIORITY_WATCH_ONLY'
    elif hf<=NEAR_200BPS:
        kind='HF_1_005_TO_1_02_WATCH_ONLY'
    elif hf<=NEAR_1000BPS:
        kind='HF_1_02_TO_1_10_WATCH_ONLY'
    else:
        kind='HF_ABOVE_1_10_NO_NEAR_TRIGGER'
    return {'total_collateral_base_raw':str(collateral),
            'total_debt_base_raw':str(debt),
            'available_borrows_base_raw':str(available),
            'liquidation_threshold_bps':lt, 'ltv_bps':ltv,
            'health_factor_wad':str(hf),
            'status':kind,
            'state_potential_liquidation_only_not_route_authority':
                debt>0 and 0<hf<WAD}


def header(raw, expected):
    need(type(raw) is dict and quantity(raw.get('number'),'block number')==expected,
         'wrong canonical block')
    h=digest32(raw.get('hash'),'block hash')
    p=digest32(raw.get('parentHash'),'parent hash')
    state=digest32(raw.get('stateRoot'),'state root')
    timestamp=quantity(raw.get('timestamp'),'timestamp')
    need(timestamp>0 and h != p,'invalid canonical header ancestry')
    return {'number':expected, 'hash':h,'parent_hash':p,
            'state_root':state,'timestamp':timestamp}


def call_data(borrower):
    need(type(borrower) is str and re.fullmatch(r'0x[0-9a-f]{40}',borrower),
         'unauthenticated borrower address')
    return CALL_SELECTOR + '0'*24 + borrower[2:]


class RPC:
    def __init__(self, provider, authorized_borrowers, transport=None):
        need(provider in PROVIDERS, 'unapproved provider')
        need(type(authorized_borrowers) is set and
             1<=len(authorized_borrowers)<=MAX_COHORT_SIZE,
             'unbounded or unauthenticated borrower cohort')
        self.provider=provider
        self.url=PROVIDERS[provider]
        self.cohort=authorized_borrowers
        self.transport=transport or self.network
        self.calls=0
        self.transcript=[]

    @staticmethod
    def network(url, method, params):
        need(url in set(PROVIDERS.values()),'unapproved RPC endpoint')
        need(method in {'eth_chainId','eth_blockNumber','eth_getBlockByNumber',
                        'eth_call'},'non read-only method')
        req=Request(url,method='POST',
            data=json.dumps({'jsonrpc':'2.0','id':71,'method':method,
                             'params':params}).encode(),
            headers={'Content-Type':'application/json',
                     'User-Agent':'NQC-V2-Prospective-Cohort-ReadOnly/1'})
        with urlopen(req,timeout=24) as response:
            body=response.read(MAX_RPC_REPLY_BYTES+1)
        need(len(body)<=MAX_RPC_REPLY_BYTES,'RPC response oversized')
        parsed=strict_json(body)
        need(type(parsed) is dict and parsed.get('jsonrpc')=='2.0'
             and parsed.get('id')==71 and 'error' not in parsed
             and 'result' in parsed, 'RPC returned malformed/error payload')
        return parsed['result']

    def call(self, method, params):
        need(self.calls < MAX_CALLS_PER_SOURCE,'RPC call budget exceeded')
        if method in {'eth_chainId','eth_blockNumber'}:
            need(params==[], 'unexpected chain/tip parameters')
        elif method=='eth_getBlockByNumber':
            need(type(params) is list and len(params)==2
                 and type(params[0]) is str and HEXNUM.fullmatch(params[0])
                 and params[1] is False,'unbounded canonical header')
        elif method=='eth_call':
            need(type(params) is list and len(params)==2 and
                 type(params[0]) is dict and set(params[0])=={'to','data'}
                 and params[0]['to']==POOL and type(params[0]['data']) is str
                 and params[0]['data'].startswith(CALL_SELECTOR)
                 and len(params[0]['data'])==74 and
                 '0x'+params[0]['data'][-40:] in self.cohort and
                 params[0]['data'][10:34]=='0'*24 and
                 type(params[1]) is dict and
                 set(params[1])=={'blockHash','requireCanonical'} and
                 params[1]['requireCanonical'] is True and
                 HEX32.fullmatch(params[1]['blockHash']),
                 'noncanonical or out-of-cohort account eth_call')
        else:
            raise Rejected('write/unknown RPC method')
        self.calls+=1
        t0=time.monotonic_ns()
        record={'provider':self.provider,'method':method,
                'params':params,'started_at_utc':now()}
        try:
            if self.transport==self.network:
                time.sleep(.45)
            data=self.transport(self.url,method,params)
            record['result_sha256']=sha256(canon(data)).hexdigest()
            return data
        except Exception as exc:
            record['error_type']=type(exc).__name__
            record['error_detail']=str(exc).split('https://')[0][:160]
            raise
        finally:
            record['elapsed_ns']=time.monotonic_ns()-t0
            record['completed_at_utc']=now()
            self.transcript.append(record)

    def preflight(self):
        need(quantity(self.call('eth_chainId',[]),'chain id')==1,
             'RPC not Ethereum mainnet')
        return quantity(self.call('eth_blockNumber',[]),'tip')

    def read_all(self, block, cohort, timestamp):
        h=self.call('eth_getBlockByNumber',[hex(block),False])
        fixed=header(h,block)
        need(timestamp>=fixed['timestamp'] and
             timestamp-fixed['timestamp']<=MAX_HEADER_STALENESS,
             'block stale or future timestamp')
        rows=[]
        for entry in cohort:
            address=entry['borrower']
            raw=self.call('eth_call',[
                {'to':POOL,'data':call_data(address)},
                {'blockHash':fixed['hash'],'requireCanonical':True}])
            decoded=decode_account(raw)
            rows.append({'borrower':address,
                'borrower_sha256':entry['borrower_sha256'],
                'in_historical_weth_stable_group':
                    entry['in_historical_weth_stable_group'],
                'historical_liquidation_logs':
                    entry['indexed_historical_liquidation_logs'],
                'account':decoded,
                'source_abi_sha256':sha256(raw.lower().encode()).hexdigest()})
        end=self.call('eth_getBlockByNumber',[hex(block),False])
        need(fixed==header(end,block),'canonical block/header changed during read')
        return {'header':fixed,'rows':rows}


def collect(index_zip, transport_factory=None, now_unix=None):
    index, rawrows, provenance=source.authenticate_index_archive(index_zip)
    cohort=build_cohort(index,rawrows)
    current=int(datetime.now(timezone.utc).timestamp()) if now_unix is None else now_unix
    need(type(current) is int and current>0,'invalid current timestamp')
    report={'schema_version':1,
        'status':'INCOMPLETE_DUAL_RPC_COHORT',
        'started_at_utc':now(),'index_source':provenance,
        'chain_id':1, 'seed_is_prior_liquidation_survivors_with_hindsight_selection':True,
        'cohort_seed_count':len(cohort),
        'weth_stable_history_borrower_count':
            sum(x['in_historical_weth_stable_group'] for x in cohort),
        'pinned_block':None,'providers':{},'errors':[],
        'verified_dual_rpc_account_count':0,
        'source_verified_hf_candidate_count':None,
        'source_verified_near_50bps_count':None,
        'source_verified_near_200bps_count':None,
        'source_verified_debt_active_count':None,
        'source_verified_no_debt_count':None,
        'weth_stable_history_hf_lt_one_count':None,
        'no_live_borrower_discovery_census':True,
        'indexed_liquidation_history_not_full_market_position_set':True,
        'state_snapshot_not_transaction_prestate':True,
        'block_confirmation_delay_not_early_competitive_signal':True,
        'actual_trade_route_proven':False,
        'realized_net_pnl_certified':False,
        'competitive_inclusion_proven':False,
        'sponsor_nonrecourse_native_gas_proven':False,
        'shadow_P2_certified':False,
        'RMC_closed':False,'canary_live_authorized':False,
        'commercial_score_upgrade':False,
        'nqc_realized_pnl_usd':'0'}
    providers={}
    authorized={c['borrower'] for c in cohort}
    tips={}
    for name in ('drpc','publicnode'):
        r=RPC(name, authorized,
              transport_factory(name) if transport_factory else None)
        providers[name]=r
        report['providers'][name]={'status':'NOT_CHECKED','errors':[],
                                   'calls_used':0,'rows':[]}
        try:
            tips[name]=r.preflight()
            report['providers'][name]['status']='CHAIN_VERIFIED'
        except Exception as exc:
            report['providers'][name]['status']='PREFLIGHT_FAILED'
            report['providers'][name]['errors'].append(
                {'kind':type(exc).__name__, 'detail':str(exc)[:160]})
    if len(tips)==2 and max(tips.values())-min(tips.values())<=MAX_TIP_DIVERGENCE:
        pinned=min(tips.values())-MIN_CONFIRMATIONS
        report['pinned_height_attempted']=pinned
        if pinned>0:
            for name,r in providers.items():
                try:
                    state=r.read_all(pinned,cohort,current)
                    report['providers'][name]['status']='COMPLETE_50_BORROWER_ACCOUNTS'
                    report['providers'][name].update(state)
                except Exception as exc:
                    report['providers'][name]['status']='INCOMPLETE_SOURCE'
                    report['providers'][name]['errors'].append(
                        {'kind':type(exc).__name__,'detail':str(exc)[:180]})
    else:
        report['errors'].append(
            {'kind':'PROVIDER_TIP_DIVERGENCE_OR_SOURCE_UNAVAILABLE',
             'source_tips':tips})
    for name, r in providers.items():
        report['providers'][name]['calls_used']=r.calls
        report['providers'][name]['transcript']=r.transcript
    a,b=(report['providers'][x] for x in ('drpc','publicnode'))
    if a['status']==b['status']=='COMPLETE_50_BORROWER_ACCOUNTS':
        if a['header']==b['header'] and a['rows']==b['rows']:
            report['status']='TWO_PUBLIC_RPC_SAME_BLOCK_50_HF_PARITY_NOT_P2'
            report['pinned_block']=a['header']
            report['verified_dual_rpc_account_count']=len(a['rows'])
            counts=[r['account']['status'] for r in a['rows']]
            report['source_verified_hf_candidate_count']=sum(
                x=='HF_LT_ONE_BORROWER_STATE_ONLY_NEEDS_ROUTE' for x in counts)
            report['source_verified_near_50bps_count']=sum(
                x=='HF_1_TO_1_005_PRIORITY_WATCH_ONLY' for x in counts)
            report['source_verified_near_200bps_count']=sum(
                x in ('HF_1_TO_1_005_PRIORITY_WATCH_ONLY',
                      'HF_1_005_TO_1_02_WATCH_ONLY') for x in counts)
            report['source_verified_debt_active_count']=sum(
                int(r['account']['total_debt_base_raw'])>0 for r in a['rows'])
            report['source_verified_no_debt_count']=sum(
                x=='NO_OUTSTANDING_DEBT_IN_PINNED_AAVE_SNAPSHOT' for x in counts)
            report['weth_stable_history_hf_lt_one_count']=sum(
                r['in_historical_weth_stable_group'] and
                r['account']['status']=='HF_LT_ONE_BORROWER_STATE_ONLY_NEEDS_ROUTE'
                for r in a['rows'])
        else:
            report['errors'].append({'kind':'RPC_ACCOUNT_OR_BLOCK_HASH_MISMATCH'})
    report['finished_at_utc']=now()
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--indexed-artifact',type=Path,required=True)
    p.add_argument('--out',type=Path,required=True)
    args=p.parse_args()
    need(args.out.is_absolute() and args.out.parent.is_dir() and not args.out.exists(),
         'output must be fresh absolute file')
    report=collect(args.indexed_artifact.read_bytes())
    with args.out.open('xb') as fd:fd.write(canon(report))
    print(report['status'],'cohort',report['cohort_seed_count'],
          'dual_rpc',report['verified_dual_rpc_account_count'],
          'state_only_hf_below_one',report['source_verified_hf_candidate_count'],
          'near_50bps',report['source_verified_near_50bps_count'])
    return 0  # an incomplete audited result cannot promote a market/execute gate


if __name__=='__main__':
    raise SystemExit(main())
