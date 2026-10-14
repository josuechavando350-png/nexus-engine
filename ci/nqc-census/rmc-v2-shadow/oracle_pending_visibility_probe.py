#!/usr/bin/env python3
"""Bounded read-only Ethereum pending-view audit for historical ETH/USD trigger.

A green audit proves only that an audit ran and preserved its negative findings.
No mempool coverage, private orderflow access, capture, gas, or P&L is implied.
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

from verify_postwindow_competitor_receipts import PROVIDERS
from postwindow_oracle_causality import AGGREGATOR, FORWARD_SELECTOR, INNER_SELECTOR

MAX_RPC_BYTES = 8_000_000
MAX_PENDING_TRANSACTIONS = 5_000
MAX_SAMPLES = 6
MAX_CALLS_PER_PROVIDER = 30
HEX32 = re.compile(r'0x[0-9a-fA-F]{64}\Z')
HEX20 = re.compile(r'0x[0-9a-fA-F]{40}\Z')
HEX = re.compile(r'0x(?:[0-9a-fA-F]{2})*\Z')
QTY = re.compile(r'0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z')
ALLOWED = frozenset(('eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionReceipt'))


class Rejected(ValueError):
    pass


def need(value, message):
    if not value:
        raise Rejected(message)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def canon(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'),
                       ensure_ascii=True) + '\n').encode()


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    def constant(_):
        raise Rejected('invalid JSON constant')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def qty(raw, name):
    need(type(raw) is str and QTY.fullmatch(raw), 'invalid '+name)
    return int(raw, 16)


def b32(raw, name):
    need(type(raw) is str and HEX32.fullmatch(raw), 'invalid '+name)
    return raw.lower()


def parse_oracle_payload(tx):
    """Recognize only *specified* direct or exact forward(address,bytes) calls.

    Do not assume every forwarded call is public/available, nor that a target
    calldata match implies the Chainlink report will be accepted.
    """
    need(type(tx) is dict, 'pending transaction must be object')
    dest, data = tx.get('to'), tx.get('input')
    need(type(dest) is str and HEX20.fullmatch(dest), 'invalid pending target')
    need(type(data) is str and HEX.fullmatch(data) and len(data) <= 250_000,
         'invalid pending calldata')
    dest, data = dest.lower(), data.lower()
    direct = '0x'+INNER_SELECTOR
    if dest == AGGREGATOR and data.startswith(direct):
        return {'kind':'direct_aggregator_report_candidate','target':AGGREGATOR,
                'outer_method_id':direct, 'input_sha256':sha256(bytes.fromhex(data[2:])).hexdigest()}
    if not data.startswith('0x'+FORWARD_SELECTOR):
        return None
    body = bytes.fromhex(data[10:])
    if len(body) < 96 or any(body[:12]):
        raise Rejected('malformed ABI forward address/length')
    target = '0x'+body[12:32].hex()
    if target != AGGREGATOR:
        return None
    offset = int.from_bytes(body[32:64], 'big')
    size = int.from_bytes(body[64:96], 'big')
    need(offset == 64 and 4 <= size <= 100_000 and
         len(body) == 96 + ((size + 31)//32)*32 and
         not any(body[96+size:]), 'malformed ETH/USD forwarding ABI')
    inner = body[96:96+size]
    if inner[:4].hex() != INNER_SELECTOR:
        return None
    return {'kind':'forwarded_aggregator_report_candidate','target':AGGREGATOR,
            'outer_method_id':'0x'+FORWARD_SELECTOR,
            'inner_method_id':'0x'+INNER_SELECTOR,
            'input_sha256':sha256(bytes.fromhex(data[2:])).hexdigest()}


def header(raw):
    need(type(raw) is dict, 'missing latest block')
    number = qty(raw.get('number'), 'latest height')
    digest = b32(raw.get('hash'), 'latest hash')
    parent = b32(raw.get('parentHash'), 'latest parent')
    need(digest != parent and qty(raw.get('timestamp'), 'latest time') > 0, 'unverifiable header')
    return {'number':number,'hash':digest,'parent_hash':parent,
            'timestamp':qty(raw['timestamp'], 'latest timestamp')}


def classify_view(latest_before, pending, latest_after):
    """Return a narrow provider-view result. A false negative is never certified."""
    before, after = header(latest_before), header(latest_after)
    result = {'head_before':before,'head_after':after,'status':None,
              'pending_transactions_count':None,'candidates':[],
              'invalid_candidates':0}
    if before != after:
        result['status'] = 'CENSORED_HEAD_MOVED_DURING_RPC_READ'
        return result
    if not isinstance(pending, dict):
        result['status'] = 'CENSORED_PENDING_UNSUPPORTED'
        return result
    # Some public RPCs return the last mined block for the pending tag. Such
    # responses are NEVER treated as a pre-inclusion mempool view.
    if pending.get('hash') is not None:
        result['status'] = 'CENSORED_PENDING_NOT_UNMINED_VIEW'
        return result
    if pending.get('parentHash', '').lower() != before['hash'] or \
            qty(pending.get('number'), 'pending height') != before['number'] + 1:
        result['status'] = 'CENSORED_PENDING_PARENT_NOT_CURRENT_TIP'
        return result
    txs = pending.get('transactions')
    if type(txs) is not list or len(txs) > MAX_PENDING_TRANSACTIONS:
        result['status'] = 'CENSORED_PENDING_TRANSACTIONS_ABSENT_OR_TOO_LARGE'
        return result
    result['pending_transactions_count'] = len(txs)
    if any(type(tx) is not dict for tx in txs):
        result['status'] = 'CENSORED_PENDING_TRANSACTION_OBJECTS_MISSING'
        return result

    seen=set()
    for tx in txs:
        tx_hash = tx.get('hash')
        if type(tx_hash) is not str or HEX32.fullmatch(tx_hash) is None:
            result['invalid_candidates'] += 1
            continue
        tx_hash = tx_hash.lower()
        if tx_hash in seen:
            result['invalid_candidates'] += 1
            continue
        seen.add(tx_hash)
        try:
            match = parse_oracle_payload(tx)
        except (Rejected, ValueError, TypeError):
            result['invalid_candidates'] += 1
            continue
        if match is None:
            continue
        # A "pending" block whose tx objects already carry mined metadata is
        # *not* evidence of seeing it before canonical inclusion.
        if any(tx.get(key) is not None for key in
               ('blockHash', 'blockNumber', 'transactionIndex')):
            result['invalid_candidates'] += 1
            continue
        result['candidates'].append({'hash':tx_hash, **match})
    # Invalid objects make the sample inconclusive for "no candidate".
    result['status'] = ('PENDING_ORACLE_CANDIDATES_IN_SINGLE_RPC_VIEW'
                        if result['candidates'] else
                        'CENSORED_MALFORMED_PENDING_TXS'
                        if result['invalid_candidates'] else
                        'NO_TARGET_IN_BOUNDED_PENDING_VIEW_NOT_MARKET_ABSENCE')
    return result


class RPC:
    def __init__(self, provider, transport=None):
        need(provider in PROVIDERS and set(PROVIDERS) == {'drpc','blast'},
             'unapproved RPC provider configuration')
        self.provider=provider
        self.url=PROVIDERS[provider][1]
        need(self.url in ('https://eth.drpc.org','https://eth-mainnet.public.blastapi.io'),
             'unapproved RPC URL')
        self.transport=transport or self.network
        self.records=[]
        self.calls=0

    @staticmethod
    def network(url, method, params):
        need(url in ('https://eth.drpc.org','https://eth-mainnet.public.blastapi.io'),
             'unapproved outbound RPC URL')
        need(method in ALLOWED, 'non read-only RPC method')
        req = Request(url, data=json.dumps({'jsonrpc':'2.0','id':7,'method':method,
                  'params':params}).encode('utf8'), method='POST',
                  headers={'Content-Type':'application/json',
                           'User-Agent':'NQC-V2-PendingOracleCapabilityReadOnly/1'})
        with urlopen(req, timeout=18) as res:
            raw = res.read(MAX_RPC_BYTES+1)
        need(len(raw) <= MAX_RPC_BYTES, 'RPC payload exceeds size limit')
        parsed = strict_json(raw)
        need(type(parsed) is dict and parsed.get('id') == 7 and
             parsed.get('jsonrpc') == '2.0' and 'error' not in parsed and
             'result' in parsed, 'RPC returned unsupported/malformed result')
        return parsed['result']

    def call(self, method, params):
        need(method in ALLOWED, 'read-only allowlist violation')
        allowed_params = (method == 'eth_chainId' and params == [] or
                          method == 'eth_getBlockByNumber' and
                          params in (['latest', False],['pending', True]) or
                          method == 'eth_getTransactionReceipt' and
                          type(params) is list and len(params)==1 and
                          type(params[0]) is str and HEX32.fullmatch(params[0]))
        need(allowed_params, 'RPC parameters outside bounded read-only contract')
        self.calls += 1
        need(self.calls <= MAX_CALLS_PER_PROVIDER, 'RPC request quota exceeded')
        begin = utc_now(); tick=time.monotonic_ns()
        row={'provider':self.provider,'method':method,'parameters':params,
             'started_at_utc':begin}
        try:
            answer = self.transport(self.url,method,params)
            row['result_sha256'] = sha256(canon(answer)).hexdigest()
            return answer
        except Exception as exc:
            row['error_type'] = type(exc).__name__
            row['error_excerpt'] = str(exc).split('https://')[0][:160]
            raise
        finally:
            row['completed_at_utc']=utc_now()
            row['elapsed_ns']=time.monotonic_ns()-tick
            self.records.append(row)

    def verify_chain(self):
        need(qty(self.call('eth_chainId', []),'chain')==1, 'not Ethereum mainnet')

    def sample(self):
        stamp=utc_now()
        start=self.call('eth_getBlockByNumber',['latest',False])
        pending=self.call('eth_getBlockByNumber',['pending',True])
        end=self.call('eth_getBlockByNumber',['latest',False])
        result=classify_view(start,pending,end)
        result['request_started_at_utc']=stamp
        result['request_completed_at_utc']=utc_now()
        if result['candidates']:
            for candidate in result['candidates']:
                receipt=self.call('eth_getTransactionReceipt',[candidate['hash']])
                candidate['receipt_null_at_probe'] = receipt is None
                if receipt is not None:
                    result['status']='CENSORED_MINED_RECEIPT_RACE'
        return result


def probe(samples, interval_seconds, transport_factory=None, sleeper=time.sleep):
    need(type(samples) is int and 1 <= samples <= MAX_SAMPLES, 'invalid sample budget')
    need(type(interval_seconds) is int and 0 <= interval_seconds <= 30, 'invalid interval')
    result={'schema_version':1,
        'status':'INCOMPLETE_PENDING_SOURCE_CAPABILITY',
        'source':'live_uncommitted_rpc_pending_view_only',
        'target_eth_usd_aggregator':AGGREGATOR,
        'start_utc':utc_now(), 'samples_requested_per_provider':samples,
        'providers':{},'cross_provider_overlap_hashes':[],
        'prospective_capture_proven':False,'pending_channel_exhaustive':False,
        'mempool_first_seen_time_proven':False,'private_orderflow_observed':False,
        'nqc_net_margin_proven':False,'native_gas_sponsor_nonrecourse_proven':False,
        'RMC_closed':False,'P2_shadow_certified':False,'canary_live_authorized':False,
        'commercial_score_upgrade':False,'nqc_realized_pnl_usd':'0'}
    for provider in ('drpc','blast'):
        rpc=RPC(provider, transport_factory(provider) if transport_factory else None)
        row={'status':'INCOMPLETE','observations':[], 'errors':[],
             'rpc_provider_id':provider,'rpc_operator_independence_proven':False}
        result['providers'][provider]=row
        try:
            rpc.verify_chain()
            for sample_number in range(samples):
                if sample_number:
                    sleeper(interval_seconds)
                try:
                    observed=rpc.sample()
                    row['observations'].append(observed)
                    if observed['status'].startswith('CENSORED_'):
                        row['status']='CENSORED_PENDING_VIEW'
                    elif observed['status']=='PENDING_ORACLE_CANDIDATES_IN_SINGLE_RPC_VIEW':
                        row['status']='OBSERVED_UNCONFIRMED_RPC_VIEW'
                except Exception as exc:
                    row['errors'].append({'sample':sample_number,
                                          'error_type':type(exc).__name__,
                                          'detail':str(exc).split('https://')[0][:160]})
                    row['status']='SOURCE_FAILURE_CENSORED'
                    break  # no repeated hammering a failing public endpoint
            if not row['errors'] and row['status']=='INCOMPLETE':
                row['status']='NO_TARGET_IN_BOUNDED_VIEWS_NOT_MARKET_ABSENCE'
        except Exception as exc:
            row['errors'].append({'stage':'verify_chain','error_type':type(exc).__name__,
                                  'detail':str(exc).split('https://')[0][:160]})
            row['status']='SOURCE_FAILURE_CENSORED'
        row['rpc_calls_consumed']=rpc.calls
        row['rpc_transcript']=rpc.records
    hits=[set(candidate['hash'] for sample in data['observations']
              if sample['status']=='PENDING_ORACLE_CANDIDATES_IN_SINGLE_RPC_VIEW'
              for candidate in sample['candidates'] if candidate['receipt_null_at_probe'])
          for data in result['providers'].values()]
    result['cross_provider_overlap_hashes']=sorted(hits[0]&hits[1])
    observed=any(hits)
    usable=all(r['observations'] and not r['errors'] and
               all(o['status'] in ('NO_TARGET_IN_BOUNDED_PENDING_VIEW_NOT_MARKET_ABSENCE',
                                   'PENDING_ORACLE_CANDIDATES_IN_SINGLE_RPC_VIEW')
                   for o in r['observations'])
               for r in result['providers'].values())
    result['status']=('PENDING_ORACLE_REPORT_OBSERVED_UNCALIBRATED'
                      if observed else 'BOUNDED_OBSERVATION_NO_TARGET_NOT_EXHAUSTIVE'
                      if usable else 'INCOMPLETE_PENDING_SOURCE_CAPABILITY')
    result['finished_at_utc']=utc_now()
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--samples',type=int,default=3)
    parser.add_argument('--interval-seconds',type=int,default=6)
    args=parser.parse_args()
    need(args.out.parent.is_dir() and not args.out.exists(),'output must be a new file')
    result=probe(args.samples,args.interval_seconds)
    with args.out.open('xb') as f:
        f.write(canon(result))
    print(result['status'],
          [(k,v['status'],len(v['observations']),len(v['errors']))
           for k,v in result['providers'].items()])
    return 0  # Valid negative/incomplete evidence is NOT a market PASS.


if __name__ == '__main__':
    raise SystemExit(main())
