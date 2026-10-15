#!/usr/bin/env python3
"""PREINCLUSION-005B: immutable PR700 source truth vs public MEV-Share historical hints.

NO live Ethereum provider needed: authenticate the previously published original
PR700 source artifact, including exact ZIP/member digests, then compare two
historically selected HF-triggering TX0 event hashes against a bounded public
Flashbots history window. Retrospective only, not prospective trading access.
"""
from __future__ import annotations
import argparse
from io import BytesIO
from pathlib import Path
import hashlib
import json
import re
from zipfile import ZipFile

import svr_archive_positive_controls as original
import svr_hf_trigger_archive_audit as causal

SOURCE_ARTIFACT_ID=11871075488
SOURCE_RUN_ID=38512327192
SOURCE_COMMIT="9208aa3cb29325ecb3a90557d1c62114c697bf02"
SOURCE_TREE="cc19baf261e33fdcbd8ac765fcc5e446af322d86"
SOURCE_ZIP_SHA256="ca495ebdb9b8c7f8ed8438e5c3226b58b9c31c0d50e44ef35d6fce2cec232dde"
WAD=10**18
MAX_ARCHIVE_ZIP=2_000_000
MAX_UNPACKED=8_000_000


class Reject(ValueError):pass

def need(ok, why):
    if not ok:raise Reject(why)


def sha(raw):return hashlib.sha256(raw).hexdigest()


def authenticate_original(source_file:Path):
    need(source_file.is_file() and source_file.stat().st_size <= MAX_ARCHIVE_ZIP,
         "absent/oversized original producer ZIP")
    raw=source_file.read_bytes()
    need(sha(raw)==SOURCE_ZIP_SHA256,"original PR700 ZIP SHA256 mismatch")
    with ZipFile(BytesIO(raw)) as z:
        infos=z.infolist()
        need(len(infos)<=130 and sum(i.file_size for i in infos)<MAX_UNPACKED,
             "unbounded historical source ZIP")
        paths=[i.filename for i in infos]
        need(len(paths)==len(set(paths)) and all(not s.startswith('/') and
             '..' not in s.split('/') for s in paths),"unsafe ZIP member names")
        need('manifest.sha256' in paths,"original source member hashes absent")
        manifest=z.read('manifest.sha256').decode('utf-8').splitlines()
        included=set()
        for line in manifest:
            parts=line.split('  ',1)
            need(len(parts)==2 and re.fullmatch('[0-9a-f]{64}',parts[0]),
                 "invalid original source digest line")
            path=parts[1].removeprefix('./')
            need(path in paths and path not in included and
                 sha(z.read(path))==parts[0],"original source member digest mismatch")
            included.add(path)
        need(included==set(paths)-{'manifest.sha256'},
             "missing/extra source member digest")
        need(z.read('code-commit.txt').decode().strip()==SOURCE_COMMIT and
             z.read('code-tree.txt').decode().strip()==SOURCE_TREE,
             "original certified code commit/tree mismatch")
        summary=original.strict_json(z.read('attempt/oracle-causality.json'))
        need(type(summary) is dict and
             summary.get('status')=='HISTORICAL_ORACLE_PRICE_CAUSALITY_ONLY' and
             summary.get('errors')==[] and
             type(summary.get('cases')) is list and len(summary['cases'])==2,
             "PR700 source status/complete-case parity invalid")
        precommitted=[]
        for i,(case,frozen) in enumerate(zip(summary['cases'],causal.CAUSAL_CONTROLS)):
            need(case.get('first_tx')==frozen['tx_hash'] and
                 case.get('two_endpoint_parity') is True and
                 set(case.get('providers',{}))=={'drpc','blast'},
                 "historical TX0 / original source provider parity missing")
            left,right=case['providers']['drpc'],case['providers']['blast']
            need(left['metrics']==right['metrics'] and left['tx']==right['tx'],
                 "PR700 original per-provider historical data mismatch")
            tx=left['tx']
            need(tx.get('tx_hash')==frozen['tx_hash'] and
                 tx.get('block_number')==frozen['block'] and tx.get('index')==0 and
                 tx.get('target')==original.WETH_AGGREGATOR and
                 tx.get('outer_method_id')=='0x6fadcf72' and
                 tx.get('inner_method_id')=='0xba0cb29e',
                 "original forwarded oracle report identity differs")
            m=left['metrics']
            need(m['NQC_FEED_ANSWER_BEFORE']>m['NQC_FEED_ANSWER_AFTER']>0 and
                 m['NQC_FEED_ANSWER_BEFORE']==m['NQC_ORACLE_PRICE_BEFORE'] and
                 m['NQC_FEED_ANSWER_AFTER']==m['NQC_ORACLE_PRICE_AFTER'] and
                 m['NQC_HF_BEFORE_TX0']>=WAD>m['NQC_HF_AFTER_TX0'] and
                 m['NQC_PRICE_FREEZE_REVERTS_TRIGGER']==1,
                 "no strictly authentic falling WETH feed / borrower HF trigger")
            name='weth_collateral_usdc_debt' if i==0 else 'weth_collateral_usdt_debt'
            inputs=original.strict_json(z.read(
                'attempt/'+name+'-drpc/public-inputs.json'))
            need(inputs.get('NQC_FIRST_TX')==frozen['tx_hash'] and
                 inputs.get('NQC_WINNER_BLOCK')==str(frozen['block']) and
                 inputs.get('NQC_HF_BEFORE_TX0')==str(m['NQC_HF_BEFORE_TX0']) and
                 inputs.get('NQC_HF_AFTER_TX0')==str(m['NQC_HF_AFTER_TX0']) and
                 type(inputs.get('NQC_WINNER_TIMESTAMP')) is str and
                 inputs['NQC_WINNER_TIMESTAMP'].isdigit(),
                 "original canonical tx0 timestamp / risk metrics missing")
            precommitted.append({
                'label':frozen['label'],
                'block_number':frozen['block'],
                'tx_hash':frozen['tx_hash'],
                'canonical_tx_block_timestamp':int(inputs['NQC_WINNER_TIMESTAMP']),
                'report_median_raw':str(m['NQC_FEED_ANSWER_AFTER']),
                'price_before_raw':str(m['NQC_FEED_ANSWER_BEFORE']),
                'price_after_raw':str(m['NQC_FEED_ANSWER_AFTER']),
                'hf_before_wad':str(m['NQC_HF_BEFORE_TX0']),
                'hf_after_wad':str(m['NQC_HF_AFTER_TX0']),
                'original_two_provider_fork_parity':True,
                'archive_positive_eligible_for_historical_test':True,
                'historically_selected_winner_with_hindsight':True,
                'expected_event_double_keccak':'0x'+original.keccak256(
                    bytes.fromhex(frozen['tx_hash'][2:])).hex(),
            })
    return precommitted


def verdict(records):
    if len(records)!=2:
        return 'INCOMPLETE_PR700_CERTIFICATE_OR_ARCHIVE'
    if any(not x.get('archive_complete_in_bounded_range') for x in records):
        return 'INCOMPLETE_HISTORICAL_ARCHIVE_COVERAGE_NOT_ABSENCE'
    linked=[]
    for row in records:
        linked.append(row.get('exact_double_hash_matches',0)>0 and
           row.get('matching_double_hash_with_decodable_target',0)>0 and
           any(t.get('hint_price_matches_onchain_transmit_report') is True
               for t in row.get('matching_archive_source_timings',[])))
    if all(linked):return 'TWO_CERTIFIED_HF_TRIGGER_HINTS_FOUND_RETROSPECTIVE_ONLY'
    if any(linked):return 'ONE_CERTIFIED_HF_TRIGGER_HINT_FOUND_NOT_CAPTURE_RECALL'
    return 'ZERO_COMPLETE_MATCHES_IN_TWO_BOUNDED_ARCHIVE_WINDOWS_NOT_PRIVATE_DENIAL'


def run(out:Path,*,archive_file:Path,archive=None):
    need(isinstance(out,Path) and out.is_absolute() and not out.exists() and
         out.parent.is_dir(),'fresh absolute evidence destination needed')
    out.mkdir()
    source={'schema_version':1,
            'original_PR700_run':SOURCE_RUN_ID,
            'original_PR700_artifact':SOURCE_ARTIFACT_ID,
            'original_certified_source_sha256':SOURCE_ZIP_SHA256,
            'preselected_economic_oracle_Tx0':list(causal.CAUSAL_CONTROLS),
            'authorized_archive_endpoint':original.MEV_SHARE,
            'max_archive_calls':17,'new_chain_RPC_calls':0,
            'created_before_Flashbots_history_GET':original.clock()}
    frozen=original.canonical(source)
    (out/'certified-evidence-before-archive.json').write_bytes(frozen)
    report={
      'schema_version':1,'precommit_sha256':sha(frozen),
      'status':'INCOMPLETE_PR700_CERTIFICATE_OR_ARCHIVE',
      'pr700_original_artifact_sha256_authenticated':False,
      'historical_source_controls':[], 'history':[], 'errors':[],
      'archive_calls':[], 'new_ethereum_rpc_calls':0,
      'network_local_first_seen_before_inclusion_proven':False,
      'builder_deadline_proven':False,'NQC_execution_or_bid_submitted':False,
      'nonrecourse_native_gas_sponsor_proven':False,
      'realized_nqc_pnl_usd':'0',
      'PFT_closed':True,'RMC_closed':False,'Shadow_P2_certified':False,
      'Canary_or_LIVE_authorized':False,
      'monthly_profit_predictability_proven':False,
      'operator_capital_usd':'0', 'user_MXN2000_spent':False,
    }
    client=archive or original.Archive(controls=causal.CAUSAL_CONTROLS,max_pages=8)
    try:
        certified=authenticate_original(archive_file)
        report['historical_source_controls']=certified
        report['pr700_original_artifact_sha256_authenticated']=True
        info=client.info()
        report['history_metadata']=info
        for control in certified:
            report['history'].append(client.inspect(control,info))
        report['status']=verdict(report['history'])
    except Exception as exc:
        report['errors'].append({'type':type(exc).__name__,
                                 'phase':'original_certificate_or_bounded_archive'})
    report['archive_calls']=client.log
    report['completed_at']=original.clock()
    (out/'certified-hf-trigger-hint-archive.json').write_bytes(original.canonical(report))
    return report

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--pr700-zip',required=True,type=Path)
    p.add_argument('--out',required=True,type=Path)
    args=p.parse_args()
    r=run(args.out,archive_file=args.pr700_zip)
    print('PREINCLUSION-005-CERTIFIED',r['status'],
          'verified_source_controls',len(r['historical_source_controls']),
          'history_windows',len(r['history']),
          'archive_gets',len(r['archive_calls']),
          'errors',len(r['errors']))
