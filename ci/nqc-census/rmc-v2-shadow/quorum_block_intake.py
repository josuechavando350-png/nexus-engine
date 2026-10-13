#!/usr/bin/env python3
"""NQC V2: strict, READ-ONLY, EIP-1898 hash-pinned per-block intake.

The resulting ledger is ALWAYS retrospective evidence, never a live trade,
commercial capture, terminal RMC authority or a certified P2/Shadow decision.
No passwords, private keys or provider URLs are emitted to the report.
A different provider URL is not proof of a different operator: supply distinct
operator IDs that correspond to genuinely independent RPC organizations.
"""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.parse
import urllib.request

WAD = 10**18
EXPECTED_CHAIN = 1
BORROWER = '0x08c14b32c8a48894e4b933090ebcc9ce33b21135'
POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
SELECTOR = 'bf92857c'
CALLDATA = '0x' + SELECTOR + ('0'*24) + BORROWER[2:]
HEX32 = re.compile(r'^0x[0-9a-fA-F]{64}$')
HEX_WORDS = re.compile(r'^0x(?:[0-9a-fA-F]{64}){6}$')
HEX_INT = re.compile(r'^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$')
PRIOR_SHA = '19ebd13298b0948996202acf0d8f7bb80a310cc598ac2f3999197eb615c3f304'

class Rejected(ValueError):
    pass

def need(cond: bool, why: str) -> None:
    if not cond:
        raise Rejected(why)

def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()

def canonical(raw) -> bytes:
    return json.dumps(raw, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()

def pos_hex(x, label: str) -> int:
    need(isinstance(x, str) and HEX_INT.fullmatch(x) is not None, label + ': invalid hex integer')
    return int(x, 16)

def word(x, label: str) -> str:
    need(isinstance(x, str) and HEX32.fullmatch(x) is not None, label + ': invalid bytes32')
    return x.lower()

def iso_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')

def verify_iso(x, label: str) -> str:
    need(isinstance(x,str) and x.endswith('Z'), label + ': require UTC ISO string')
    try:
        t=dt.datetime.fromisoformat(x.replace('Z','+00:00'))
    except ValueError as ex:
        raise Rejected(label + ': invalid ISO') from ex
    need(t.utcoffset()==dt.timedelta(0), label+': not UTC')
    return x

def network_rpc(endpoint: str, method: str, params: list, *, timeout=12) -> dict:
    request=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode()
    req=urllib.request.Request(endpoint,data=request,headers={'Content-Type':'application/json'},method='POST')
    with urllib.request.urlopen(req,timeout=timeout) as resp:
        data=resp.read(1024*1024 + 1)
    need(len(data)<=1024*1024, 'rpc response too large')
    return json.loads(data)

def safe_rpc(provider, method, params, transport) -> object:
    response=transport(provider['url'],method,params)
    need(isinstance(response,dict) and response.get('jsonrpc')=='2.0' and type(response.get('id')) is int and response.get('id')==1,'invalid JSON-RPC envelope')
    need('error' not in response, 'RPC_REJECTED_'+method)
    need('result' in response, 'missing RPC result')
    return response['result']

def parse_header(payload, expected_height) -> dict:
    need(isinstance(payload,dict),'missing block/header')
    number=pos_hex(payload.get('number'),'block.number')
    need(number==expected_height,'unexpected block height')
    h=word(payload.get('hash'),'block.hash')
    parent=word(payload.get('parentHash'),'block.parentHash')
    need(h!=parent,'invalid parent equals block hash')
    stamp=pos_hex(payload.get('timestamp'),'block.timestamp')
    need(stamp>0,'invalid timestamp')
    fee=pos_hex(payload.get('baseFeePerGas'),'baseFeePerGas')
    return {'number':number,'hash':h,'parent_hash':parent,'block_timestamp':stamp,'base_fee_wei':fee}

def parse_abi(result):
    # CRITICAL: only raw hex exactly 192 bytes; never numeric JSON / float.
    need(isinstance(result,str) and HEX_WORDS.fullmatch(result) is not None,'ABI must be EXACT 6xuint256 raw hex, not rounded JSON')
    result=result.lower()
    decoded=[int(result[2+i*64:2+(i+1)*64],16) for i in range(6)]
    need(decoded[0]>0 and decoded[1]>0,'borrower collateral/debt missing')
    need(decoded[3]<=10000 and decoded[4]<=10000,'invalid liquidation or LTV basis points')
    return result,decoded

def check_providers(providers, allow_http_local=False):
    need(isinstance(providers,list) and len(providers)>=2,'at least two RPC providers required')
    ids=set();urls=set()
    for p in providers:
        need(isinstance(p,dict) and isinstance(p.get('operator_id'),str) and re.fullmatch(r'[a-zA-Z0-9_-]{2,40}',p['operator_id']) is not None, 'operator_id required')
        u=p.get('url');need(isinstance(u,str),'provider URL missing')
        parsed=urllib.parse.urlparse(u)
        valid=parsed.scheme=='https' and bool(parsed.hostname) and not parsed.username and not parsed.password
        if allow_http_local and parsed.scheme=='http' and parsed.hostname in ('127.0.0.1','localhost','::1'):
            valid=True
        need(valid,'provider must be HTTPS, without embedded credentials')
        need(p['operator_id'] not in ids,'duplicate operator_id: not independent quorum')
        need(u not in urls,'duplicate provider URL')
        ids.add(p['operator_id']);urls.add(u)

def fetch_one(provider, height, transport):
    chain=pos_hex(safe_rpc(provider,'eth_chainId',[],transport),'eth_chainId')
    need(chain==EXPECTED_CHAIN,'wrong chain id')
    hdr=parse_header(safe_rpc(provider,'eth_getBlockByNumber',[hex(height),False],transport),height)
    # Prevent reading state at a different canonical block with the same height.
    response=safe_rpc(provider,'eth_call',[{'to':POOL,'data':CALLDATA},{'blockHash':hdr['hash'],'requireCanonical':True}],transport)
    raw,vals=parse_abi(response)
    return hdr,raw,vals

def provider_tip(provider, transport):
    chain=pos_hex(safe_rpc(provider,'eth_chainId',[],transport),'chainId')
    need(chain==EXPECTED_CHAIN,'provider wrong chain')
    return pos_hex(safe_rpc(provider,'eth_blockNumber',[],transport),'eth_blockNumber')

def trusted_pair(providers,height,transport):
    evidence=[]
    for p in providers:
        hdr,raw,vals=fetch_one(p,height,transport)
        evidence.append((p['operator_id'],hdr,raw,vals))
    first=evidence[0]
    for item in evidence[1:]:
        need(item[1]==first[1],f'RPC_HEADER_DIVERGENCE_AT_{height}')
        need(item[2]==first[2],f'RPC_STATE_DIVERGENCE_AT_{height}')
    return {'header':first[1],'raw':first[2],'vals':first[3],
        'operators':sorted(x[0] for x in evidence),
        'raw_result_sha256':sha(bytes.fromhex(first[2][2:]))}

def validate_seed(seed: bytes, *, required_sha=PRIOR_SHA):
    need(isinstance(required_sha, str) and re.fullmatch(r'[0-9a-f]{64}', required_sha) is not None,
         'invalid expected previous ledger hash')
    need(sha(seed)==required_sha,'previous ledger SHA-256 mismatch')
    need(seed.endswith(b'\n'),'seed not newline terminated')
    chunks=seed.splitlines(keepends=True)
    need(len(chunks)>=7,'immutable RUN07 prefix incomplete')
    need(sha(b''.join(chunks[:7]))==PRIOR_SHA,'immutable RUN07 root prefix SHA-256 mismatch')
    arr=[json.loads(x) for x in chunks]
    heights=[x['block_number'] for x in arr[:7]]
    need(heights==[26181888,26182686,26183000,26183390,26183600,26183878,26183879], 'unexpected immutable prefix heights')
    need(all(x.get('formal_shadow_admitted') is False and x.get('realized_nqc_pnl_usd')=='0' for x in arr),'unexpected prior authority')
    need(all(isinstance(x.get('health_factor_wad'),str) and x['health_factor_wad'].isdigit() for x in arr),'invalid prior HF')
    need(word(arr[6].get('block_hash'),'seed original head hash')== '0x37e62b4a4f40b25f00e7c52c9c62eb7fcd7af62e1a62aa8e79f5bb1d1fed4745','wrong immutable prefix head')
    prev=arr[6]
    for cur in arr[7:]:
        need(cur.get('schema_version')==1 and cur.get('contract')=='NQC_RMC_V2_UNATTESTED_QUORUM_BACKFILL_V1', 'unrecognized appended record')
        need(type(cur.get('block_number')) is int and cur['block_number']==prev['block_number']+1,'historical append height gap')
        need(word(cur.get('block_hash'),'appended block hash')!=word(prev['block_hash'],'previous hash'), 'same block hash reused')
        need(word(cur.get('parent_hash'),'appended parent hash')==word(prev['block_hash'],'previous block hash'), 'historical append ancestry mismatch')
        need(cur.get('decision_role')=='RETROSPECTIVE_BACKFILL_NOT_PROSPECTIVE_EXECUTION','forged historical decision role')
        for f in ('prospective_signal','execution_eligible','formal_shadow_admitted','p2_certified'):
            need(cur.get(f) is False, 'forged historical commercial authority: '+f)
        need(cur.get('live_executions')==0 and cur.get('realized_nqc_pnl_usd')=='0','forged historical trades')
        need(isinstance(cur.get('raw_abi_sha256'),str) and re.fullmatch(r'[0-9a-f]{64}',cur['raw_abi_sha256']) is not None,'invalid historical raw ABI digest')
        need(type(cur.get('declared_distinct_operator_ids_count')) is int and cur['declared_distinct_operator_ids_count']>=2,'historical declared operators missing')
        need(cur.get('source_tier')=='DISTINCT_DECLARED_OPERATOR_IDS_INDEPENDENCE_UNPROVEN','historical source tier promotion')
        operators=cur.get('source_operator_ids')
        need(isinstance(operators,list) and len(operators)==cur['declared_distinct_operator_ids_count'] and
             len(set(operators))==len(operators) and all(isinstance(o,str) and o for o in operators),
             'historical operator identities inconsistent')
        need(isinstance(cur.get('health_factor_wad'),str) and cur['health_factor_wad'].isdigit(),'historical HF invalid')
        need(cur.get('candidate_hf_below_one')==(int(cur['health_factor_wad'])<WAD),'historical candidate condition inconsistent')
        prev=cur
    return prev

def run(seed:bytes, providers:list, transport, *, max_blocks=2, depth=0, capture_clock=iso_now, tip_override=None, live_transport=False, expected_seed_sha=PRIOR_SHA):
    """Return append-only bytes + provenance; rejects all mismatches WITHOUT altering input."""
    check_providers(providers, allow_http_local=True)
    need(type(max_blocks) is int and 1<=max_blocks<=128,'invalid max_blocks')
    need(type(depth) is int and depth>=0,'invalid confirmation depth')
    last=validate_seed(seed,required_sha=expected_seed_sha)
    start=last['block_number']+1
    tips=[provider_tip(p,transport) for p in providers] if tip_override is None else [tip_override]*len(providers)
    safe_tip=min(tips)-depth
    need(safe_tip>=start,'no new block at common provider tip')
    end=min(start+max_blocks-1,safe_tip)
    output=bytearray(seed);prev_hash=word(last['block_hash'],'old head hash')
    rows=[];witnesses=[]
    for height in range(start,end+1):
        e=trusted_pair(providers,height,transport)
        hdr=e['header']
        need(hdr['parent_hash']==prev_hash, 'REORG_OR_GAP_AT_HEIGHT_'+str(height))
        observed=verify_iso(capture_clock(),'observed_at_utc')
        seen_dt=dt.datetime.fromisoformat(observed.replace('Z','+00:00'))
        need(seen_dt.timestamp()>=hdr['block_timestamp'],'observation before block timestamp')
        v=e['vals'];liquidatable=v[5]<WAD
        # Candidate detection is NOT a proof of executable net profitability.
        row={
          'schema_version':1,'contract':'NQC_RMC_V2_UNATTESTED_QUORUM_BACKFILL_V1',
          'block_number':height,'block_hash':hdr['hash'],'parent_hash':hdr['parent_hash'],
          'block_timestamp_utc':dt.datetime.fromtimestamp(hdr['block_timestamp'],dt.timezone.utc).isoformat().replace('+00:00','Z'),
          'observed_at_utc':observed,'source_tier':'DISTINCT_DECLARED_OPERATOR_IDS_INDEPENDENCE_UNPROVEN',
          'source_operator_ids':e['operators'],'declared_distinct_operator_ids_count':len(e['operators']),
          'raw_abi_sha256':e['raw_result_sha256'],'health_factor_wad':str(v[5]),
          'total_collateral_base':str(v[0]),'total_debt_base':str(v[1]),'current_liquidation_threshold_bps':v[3],
          'base_fee_wei':str(hdr['base_fee_wei']),
          'candidate_hf_below_one':liquidatable,
          'decision':'CANDIDATE_UNPRICED_NOT_EXECUTABLE' if liquidatable else 'SKIP_NOT_LIQUIDATABLE',
          'decision_role':'RETROSPECTIVE_BACKFILL_NOT_PROSPECTIVE_EXECUTION',
          'capital_evaluation':'NOT_VERIFIED','route_economics':'NOT_VERIFIED','competition':'NOT_VERIFIED',
          'prospective_signal':False,'execution_eligible':False,'formal_shadow_admitted':False,
          'p2_certified':False,'live_executions':0,'realized_nqc_pnl_usd':'0'
        }
        output.extend(canonical(row)+b'\n')
        rows.append(row)
        witnesses.append({'block_number':height,'raw_abi_hex':e['raw'],'source_operator_ids':e['operators'],'block_hash':hdr['hash']})
        prev_hash=hdr['hash']
    assert bytes(output).startswith(seed)
    manifest={
      'schema_version':1,'status':'QUORUM_RPC_BACKFILL_LOCAL_VALIDATION_ONLY',
      'seed_sha256':sha(seed),'new_ledger_sha256':sha(bytes(output)),
      'raw_evidence_sha256':sha(canonical(witnesses)+b'\n'),
      'first_height':start,'last_height':end,'new_blocks':len(rows),
      'latest_safe_common_tip':safe_tip,'confirmation_depth':depth,
      'real_providers_contacted':live_transport,
      'claims':{'live_trading':False,'prospective_capture':False,'shadow_certified':False,
                'rmc_closed':False,'zero_capital_feasible':False,'positive_net_ev':False,'realized_nqc_pnl_usd':'0'},
      'operator_ids':sorted(p['operator_id'] for p in providers),
      'warnings':['OPERATOR_INDEPENDENCE_DECLARED_NOT_CRYPTOGRAPHICALLY_PROVEN',
                  'BACKFILL_IS_NOT_PROSPECTIVE_DETECTION',
                  'CHAIN_CAN_REORGANIZE_BEFORE_FINALIZATION',
                  'NO_CAPITAL_ROUTE_BUILDER_OR_COMPETITION_PROOFS']
    }
    return bytes(output),manifest,witnesses

def atomic_write(path:Path,data:bytes):
    path.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix='.'+path.name+'.',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as h:
            h.write(data);h.flush();os.fsync(h.fileno())
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def main():
    p=argparse.ArgumentParser(description='Read-only block-by-block quorum backfill; never signs/broadcasts')
    p.add_argument('--seed-ledger',required=True,type=Path)
    p.add_argument('--config',required=True,type=Path)
    p.add_argument('--out-dir',required=True,type=Path)
    p.add_argument('--max-blocks',type=int,default=2)
    p.add_argument('--confirmation-depth',type=int,default=2)
    p.add_argument('--expected-seed-sha256',default=PRIOR_SHA)
    args=p.parse_args()
    providers=json.loads(args.config.read_text())['providers']
    check_providers(providers)
    before=args.seed_ledger.read_bytes()
    try:
        updated,manifest,witnesses=run(before,providers,network_rpc,max_blocks=args.max_blocks,depth=args.confirmation_depth,live_transport=True,expected_seed_sha=args.expected_seed_sha256)
    except Exception as exc:
        # No RPC URL/secret printed; type and bounded message only.
        failure={'status':'BLOCKED_NO_LEDGER_WRITTEN','error_class':type(exc).__name__,
                 'error_code':str(exc)[:110] if isinstance(exc,Rejected) else 'TRANSPORT_FAILURE'}
        atomic_write(args.out_dir/'rejection.json',canonical(failure)+b'\n')
        raise SystemExit(2)
    atomic_write(args.out_dir/'quorum-backfill-ledger.jsonl',updated)
    atomic_write(args.out_dir/'quorum-evidence.json',canonical(witnesses)+b'\n')
    atomic_write(args.out_dir/'quorum-backfill-manifest.json',canonical(manifest)+b'\n')
    print(json.dumps({'status':manifest['status'],'blocks':manifest['new_blocks'],
                      'ledger_sha256':manifest['new_ledger_sha256']},sort_keys=True))

if __name__=='__main__':main()
