#!/usr/bin/env python3
"""Decode authentic Aave V3 LiquidationCall integer token quantities (not USD/P&L).

Requires every original Ethereum log and compares each exact event commitment to
immutable RMC-016 source-event artifact 11524139188. No network, float, prices,
private keys, route modelling, or assumed Nexus captures.
"""
from __future__ import annotations
import argparse,hashlib,json,re,zipfile
from collections import Counter
from pathlib import Path

SOURCE_SHA = '6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204'
POOL='0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
TOPIC='0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286'
START=25880316;END=26095351
HEX64=re.compile(r'0x[0-9a-f]{64}\Z')
HEXQ=re.compile(r'0x(?:0|[1-9a-f][0-9a-f]*)\Z')

def require(c,m):
    if not c:raise ValueError(m)
def canon(x):return (json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=True)+'\n').encode()
def sha(x):return hashlib.sha256(x).hexdigest()
def q(x,which):
    require(isinstance(x,str) and HEXQ.fullmatch(x) is not None,which+' invalid hex')
    return int(x,16)
def obj(b):
    def distinct(pairs):
        d={}
        for k,v in pairs:
            require(k not in d,'duplicate JSON key')
            d[k]=v
        return d
    r=json.loads(b,object_pairs_hook=distinct)
    require(type(r) is dict,'not a JSON mapping')
    return r

def authentic_source(path):
    require(sha(path.read_bytes())==SOURCE_SHA,'not the immutable source event archive')
    with zipfile.ZipFile(path) as z:
        names=z.namelist()
        required={'archive.sha256','discovery-report.json','liquidation-events.jsonl','winner-transactions.txt'}
        require(len(set(names))==len(names) and set(names)==required,'source archive members')
        raw={x:z.read(x) for x in names}
    checked=set()
    for line in raw['archive.sha256'].decode('ascii').splitlines():
        digest,name=line.split('  ')
        require(name in required-{'archive.sha256'} and name not in checked and
                sha(raw[name])==digest,'source inner archive checksum')
        checked.add(name)
    require(checked==required-{'archive.sha256'},'source archive manifest incomplete')
    cert=obj(raw['discovery-report.json'])
    require(cert['coverage_complete'] is True and cert['liquidation_event_count']==139
            and cert['unique_winner_transaction_count']==127 and
            cert['independent_provider_consensus'] is False,'source incorrect authority')
    rows=[obj(line) for line in raw['liquidation-events.jsonl'].splitlines()]
    ids=[s.decode('ascii') for s in raw['winner-transactions.txt'].splitlines()]
    require(len(rows)==139 and len(ids)==127 and set(s['transaction_hash'] for s in rows)==set(ids),
            'source universe mismatch')
    return rows,ids

def decode(log):
    require(type(log) is dict,'log record is not a mapping')
    l={k:(v.lower() if type(v) is str else v) for k,v in log.items()}
    if type(l.get('topics')) is list:
        l['topics']=[t.lower() if type(t) is str else t for t in l['topics']]
    require(l.get('address')==POOL,'wrong Aave pool')
    t=l.get('topics')
    require(type(t) is list and len(t)==4 and t[0]==TOPIC and
            all(type(x) is str and HEX64.fullmatch(x) is not None for x in t),'LiquidationCall topics')
    require(all(int(s[2:26],16)==0 for s in t[1:]),'indexed address not ABI padded')
    data=l.get('data')
    require(type(data) is str and re.fullmatch(r'0x[0-9a-f]{256}',data) is not None,'LiquidationCall ABI data length')
    words=[data[2+i*64:2+(i+1)*64] for i in range(4)]
    amount_debt=int(words[0],16);amount_collateral=int(words[1],16)
    require(amount_debt>0 and amount_collateral>0,'zero liquidation amounts')
    require(int(words[2][:24],16)==0,'liquidator address not right aligned')
    require(int(words[3],16) in (0,1),'receiveAToken not ABI boolean')
    block=q(l.get('blockNumber'),'blockNumber'); idx=q(l.get('transactionIndex'),'txIndex');li=q(l.get('logIndex'),'logIndex')
    require(START<=block<=END,'block out of window')
    bh=l.get('blockHash');tid=l.get('transactionHash')
    require(type(bh) is str and HEX64.fullmatch(bh) is not None and
            type(tid) is str and HEX64.fullmatch(tid) is not None,'block or transaction hash')
    require(l.get('removed') is False,'reorg removed log')
    proof={'pool':l['address'],'topics':t,'data':data,'block_hash':bh,
           'block_number':block,'tx_hash':tid,'tx_index':idx,'log_index':li}
    out={'transaction_hash':tid,'block_hash':bh,'block_number':block,
         'transaction_index':idx,'log_index':li,
         'collateral_asset':'0x'+t[1][-40:],'debt_asset':'0x'+t[2][-40:],
         'debt_to_cover_raw':str(amount_debt),
         'collateral_liquidated_raw':str(amount_collateral),
         'receive_a_token':int(words[3],16)==1,
         'borrower_identity_sha256':sha(t[3].encode()),
         'liquidator_identity_sha256':sha(('0x'+words[2][-40:]).encode()),
         'original_event_commitment_sha256':sha(canon(proof))}
    return out

def bind_logs(source,raw_lines):
    records=[decode(obj(line)) for line in raw_lines.splitlines() if line]
    require(len(records)==139,'expected exactly 139 raw historical LiquidationCall logs')
    seen=set()
    by={(r['block_hash'],r['transaction_hash'],r['log_index']):r for r in source}
    require(len(by)==139,'duplicated original source event identities')
    for r in records:
        key=(r['block_hash'],r['transaction_hash'],r['log_index'])
        require(key not in seen and key in by,'extra or duplicate Aave event')
        seen.add(key)
        original=by[key]
        require(original['event_commitment_sha256']==r['original_event_commitment_sha256'] and
                original['block_number']==r['block_number'] and
                original['transaction_index']==r['transaction_index'],
                'new raw event data differs from immutable original event commitment')
    require(seen==set(by),'not all original events have raw ABI witnesses')
    return sorted(records,key=lambda r:(r['block_number'],r['transaction_index'],r['log_index']))

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--event-zip',required=True,type=Path)
    p.add_argument('--raw-logs',required=True,type=Path)
    p.add_argument('--out',required=True,type=Path)
    a=p.parse_args()
    require(not a.out.exists(),'append-only output required')
    source,ids=authentic_source(a.event_zip)
    rec=bind_logs(source,a.raw_logs.read_bytes())
    raw=b''.join(canon(r) for r in rec)
    a.out.write_bytes(raw)
    print('AAVE_LIQUIDATION_INTEGER_LEGS_MATCH_ORIGINAL_SOURCE events',len(rec),
          'unique_tx',len(set(r['transaction_hash'] for r in rec)),
          'raw_amounts_in_token_base_units_NOT_USD_AND_NOT_PNL',
          'sha256',sha(raw))
if __name__=='__main__':main()
