#!/usr/bin/env python3
"""Single bounded Blockscout indexer preflight, NEVER on-chain census authority.

Official Aave Pool liquidation topic fixed. Compare a MAXIMUM 250-block
historical window against separately authenticated dRPC proof; no wallet or
RPC broadcasting. A REST indexer's zero response alone is NOT a proof of
completeness, canonical operator independence or executable profitability.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlencode
from urllib.request import Request,urlopen
from urllib.error import HTTPError,URLError

POOL='0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
TOPIC='0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286'
SUSDE='0x9d39a5de30e57443bff2a8307a4256c8797a3497'
USDTB='0xc139190f447e929f090edeb554d95abb8b18ac1c'
START=26095352
END=26095601
SOURCE='https://eth.blockscout.com/api'
MAX_BYTES=2_000_000
MAX_ROWS=950
HEX32=re.compile(r'0x[0-9a-f]{64}\Z')
DOC_SCOPE='UNTRUSTED_INDEXER_250_BLOCK_DISCOVERY_CROSSCHECK_ONLY'
PIN_DRPC_SHARD_SHA='2026af447b87012693d07e86880dd5bf1006e7b1aee982d00d1d0704dbf23301'
ORIGINAL_GH_DRPC_RUN=38485623561

class SourceRejected(ValueError):
    pass

def need(ok,msg):
    if not ok:raise SourceRejected(msg)

def canonical(v):
    return (json.dumps(v,sort_keys=True,separators=(',',':'))+'\n').encode()

def json_strict(data):
    def no_dups(items):
        d={}
        for k,v in items:
            need(k not in d,'duplicate JSON key')
            d[k]=v
        return d
    try:return json.loads(data,object_pairs_hook=no_dups)
    except (UnicodeError,TypeError,ValueError) as e:
        raise SourceRejected('indexer returned invalid JSON') from e

def topic_addr(v):
    need(type(v) is str and HEX32.fullmatch(v.lower()) is not None and
         v.lower()[2:26]=='0'*24,'malformed indexed address')
    return '0x'+v.lower()[-40:]

def validate_response(d):
    need(type(d) is dict and set(d)>= {'status','message','result'},
         'incomplete Blockscout API envelope')
    status=d['status'];message=d['message'];result=d['result']
    need(type(status) is str and type(message) is str,
         'provider returned inconsistent result status')
    if status=='0':
        need(type(result) is list and result==[] and
             message.strip().lower() in ('no logs found','no records found',
                                         'no records','no logs'),
             'provider error cannot certify absence')
    else:
        need(status=='1' and type(result) is list,
             'indexer did not return successful log array')
    need(len(result)<MAX_ROWS,
         'indexer result potentially truncated by hidden pagination/caps')
    seen=set();events=[]
    for row in result:
        need(type(row) is dict and
             str(row.get('address','')).lower()==POOL,
             'not the Aave Pool deployment')
        topics=row.get('topics')
        need(type(topics) is list and len(topics)==4 and
             str(topics[0]).lower()==TOPIC,'non-LiquidationCall log returned')
        collateral=topic_addr(topics[1])
        debt=topic_addr(topics[2])
        borrower=topic_addr(topics[3])
        block_raw=row.get('blockNumber')
        need(type(block_raw) is str and
             re.fullmatch(r'0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)',block_raw),
             'missing blockNumber quantity')
        block=int(block_raw,16)
        need(START<=block<=END,'log outside fixed indexer window')
        transaction=row.get('transactionHash')
        block_hash=row.get('blockHash')
        log_index=row.get('logIndex')
        need(type(transaction) is str and HEX32.fullmatch(transaction.lower()) is not None
             and type(block_hash) is str and HEX32.fullmatch(block_hash.lower()) is not None
             and type(log_index) is str and
             re.fullmatch(r'0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)',log_index),
             'log/transaction immutable identity missing')
        need(type(row.get('data')) is str and
             re.fullmatch(r'0x[0-9a-fA-F]{256}',row['data']),
             'LiquidationCall data must be four 32-byte ABI words')
        key=(block_hash.lower(),transaction.lower(),int(log_index,16))
        need(key not in seen,'duplicate indexed log')
        seen.add(key)
        events.append({
            'block_number':block,'block_hash':block_hash.lower(),
            'transaction_hash':transaction.lower(),'log_index':int(log_index,16),
            'collateral_asset':collateral,'debt_asset':debt,
            'borrower_identity_hash_sha256':hashlib.sha256(borrower.encode()).hexdigest(),
            'target_asset_in_event':(collateral in (SUSDE,USDTB) or
                                    debt in (SUSDE,USDTB)),
            'original_data_sha256':hashlib.sha256(row['data'].lower().encode()).hexdigest()
        })
    targets=[x for x in events if x['target_asset_in_event']]
    # The original dRPC 250-block source evidence had zero targeted events.
    # An indexer discrepancy is a MISMATCH, never silently truncated to zero.
    need(len(targets)==0,'INDEXER_AND_CANONICAL_250_BLOCK_TARGETED_EVENT_MISMATCH')
    return {
        'schema_version':1,'contract':'NQC_V2_BLOCKSCOUT_INDEXER_DISCOVERY_250_BLOCK_NEGATIVE',
        'status':'INDEXER_250_BLOCK_CROSSCHECK_NOT_SOURCE_AUTHORITY',
        'scope':DOC_SCOPE,'chain_id_assumed_not_verified_by_this_api':1,
        'from_block':START,'to_block':END,
        'indexer_url':SOURCE,
        'indexer_unfiltered_aave_liquidation_events':len(events),
        'indexer_targeted_susde_or_usdtb_events':len(targets),
        'original_drpc_evidence_run':ORIGINAL_GH_DRPC_RUN,
        'original_drpc_zip_sha256':PIN_DRPC_SHARD_SHA,
        'indexer_completeness_or_finality_certified':False,
        'second_rpc_independent_operator_attestation':False,
        'nqc_captured_liquidation':False,'nqc_realized_pnl_usd':'0',
        'rmc_closed':False,'p2_shadow_certified':False,
        'commercial_score_upgrade':False,
        'no_claim_for_remaining_89140_blocks':True,
    }

def fetch():
    params=urlencode({
        'module':'logs','action':'getLogs','fromBlock':START,'toBlock':END,
        'address':POOL,'topic0':TOPIC
    })
    u=SOURCE+'?'+params
    need(u.startswith(SOURCE+'?'),'unapproved data source')
    req=Request(u,headers={'Accept':'application/json',
                           'User-Agent':'NQC-ReadOnly-Aave-Indexer-Preflight/1'},
                method='GET')
    try:
        with urlopen(req,timeout=35) as stream:
            raw=stream.read(MAX_BYTES+1)
    except (HTTPError,URLError,TimeoutError,OSError) as e:
        raise SourceRejected('INDEXER_REQUEST_FAILED:'+type(e).__name__+
                             ':'+str(e)[:180]) from e
    need(len(raw)<=MAX_BYTES,'unbounded indexer payload')
    return raw

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--output-dir',required=True,type=Path)
    a=p.parse_args()
    out=a.output_dir
    need(out.is_dir(),'output directory must be pre-created')
    raw=fetch()
    (out/'untrusted-blockscout-raw.json').write_bytes(raw)
    doc=validate_response(json_strict(raw))
    doc['raw_indexer_sha256']=hashlib.sha256(raw).hexdigest()
    (out/'indexer-crosscheck.json').write_bytes(canonical(doc))
    print(doc['status'],'source_events',doc['indexer_unfiltered_aave_liquidation_events'],
          'target_events',doc['indexer_targeted_susde_or_usdtb_events'])

if __name__=='__main__':main()
