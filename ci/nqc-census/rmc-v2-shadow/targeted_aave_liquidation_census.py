#!/usr/bin/env python3
"""RMC V2 — deterministic post-window Aave liquidation discovery.

Read-only public Ethereum JSON-RPC. No signing, transactions, funding, P&L,
prospective observation or retrospective-to-prospective promotion.

Searches every block after the original RMC016 certified window for
LiquidationCall with either target token (sUSDe or USDtb) as collateral OR debt.
Validates receipt identity and ledger ordering and fails closed on incomplete
coverage. Two provider endpoints may corroborate exact raw event identities,
but distinct endpoints alone do not authenticate independent RPC operators.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

CHAIN = 1
PREVIOUS_END = 26_095_351
START = PREVIOUS_END + 1
END = 26_184_741
PREVIOUS_END_HASH = '0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781'
END_HASH = '0xe4b0718c51a6a484eef56edce0f25e9a5c546c2f66f595c6e305a589a612dbbe'
END_PARENT = '0x53ddf49d46b566154bbb876ae76839331ee43b01beab19190b813eecbda5ec66'
AAVE = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
TOPIC = '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286'
SUSDE = '0x9d39a5de30e57443bff2a8307a4256c8797a3497'
USDTB = '0xc139190f447e929f090edeb554d95abb8b18ac1c'
TARGETS = {SUSDE, USDTB}
PROVIDERS = {
    'publicnode': ('PublicNode', 'https://ethereum-rpc.publicnode.com'),
    'drpc': ('dRPC', 'https://eth.drpc.org'),
    'llama': ('LlamaNodes', 'https://eth.llamarpc.com'),
}
HEX32 = re.compile(r'0x[0-9a-f]{64}\Z')
RAW4 = re.compile(r'0x[0-9a-f]{256}\Z')
QTY = re.compile(r'0x(?:0|[1-9a-f][0-9a-f]*)\Z')
MAX_RESPONSE = 8_000_000
MAX_EVENT_PER_STREAM_SHARD = 1000
SPLIT_LIMIT = 8
DEFAULT_SPAN = 20_000
MIN_RPC_INTERVAL = 22.0
MAX_REQUESTS = 150

class SourceError(ValueError):
    pass

def need(ok, reason):
    if not ok:
        raise SourceError(reason)

def canon(obj):
    return (json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n').encode()

def sha(obj):
    return hashlib.sha256(canon(obj)).hexdigest()

def q(v, label):
    need(type(v) is str and QTY.fullmatch(v.lower()) is not None,
         label + ': exact hex quantity required')
    return int(v, 16)

def topic_for(address):
    need(address in TARGETS, 'unsupported asset')
    return '0x' + '0' * 24 + address[2:]

def topic_addr(raw):
    need(type(raw) is str and HEX32.fullmatch(raw) is not None,
         'invalid indexed address topic')
    need(raw[2:26] == '0' * 24, 'nonzero indexed address padding')
    return '0x' + raw[-40:]

def checked_header(header, height, expected_hash=None, expected_parent=None):
    need(type(header) is dict, 'missing canonical block header')
    need(q(header.get('number'), 'header number') == height,
         'block number mismatch')
    digest = header.get('hash')
    parent = header.get('parentHash')
    need(type(digest) is str and HEX32.fullmatch(digest), 'bad block hash')
    need(type(parent) is str and HEX32.fullmatch(parent), 'bad parent hash')
    need(type(header.get('stateRoot')) is str and HEX32.fullmatch(header['stateRoot']),
         'missing canonical state root')
    ts = q(header.get('timestamp'), 'timestamp')
    need(ts > 0, 'invalid block timestamp')
    if expected_hash is not None:
        need(digest == expected_hash, 'known canonical hash mismatch')
    if expected_parent is not None:
        need(parent == expected_parent, 'known parent hash mismatch')
    return {'number': height, 'hash': digest, 'parent_hash': parent,
            'state_root': header['stateRoot'], 'timestamp': ts}

def normalize(raw, a, b, stream):
    need(type(raw) is dict, 'malformed eth_getLogs entry')
    row = {}
    for key in ('address', 'blockHash', 'transactionHash', 'data',
                'blockNumber', 'transactionIndex', 'logIndex'):
        v = raw.get(key)
        need(type(v) is str, 'missing log field ' + key)
        row[key] = v.lower()
    need(raw.get('removed') is False, 'removed/reorganized log')
    topics = raw.get('topics')
    need(type(topics) is list and len(topics) == 4,
         'incorrect indexed LiquidationCall topic length')
    topics = [t.lower() if type(t) is str else t for t in topics]
    need(topics[0] == TOPIC, 'different event signature')
    collateral = topic_addr(topics[1])
    debt = topic_addr(topics[2])
    topic_addr(topics[3])
    need((collateral in TARGETS) if stream == 'collateral' else (debt in TARGETS),
         'RPC returned event outside the exact asset filter')
    need(row['address'] == AAVE, 'wrong pool deployment')
    need(type(row['data']) is str and RAW4.fullmatch(row['data']),
         'bad LiquidationCall ABI event payload')
    debt_raw = int(row['data'][2:66], 16)
    collateral_raw = int(row['data'][66:130], 16)
    liquidator_word = row['data'][130:194]
    bool_raw = int(row['data'][194:258], 16)
    need(debt_raw > 0 and collateral_raw > 0,
         'zero-sized liquidation payload')
    need(liquidator_word[:24] == '0' * 24 and bool_raw in (0, 1),
         'malformed liquidator or receiveAToken ABI')
    height = q(row['blockNumber'], 'log block number')
    need(a <= height <= b, 'log outside requested shard')
    tx_order = q(row['transactionIndex'], 'transactionIndex')
    index = q(row['logIndex'], 'logIndex')
    need(HEX32.fullmatch(row['blockHash']) and HEX32.fullmatch(row['transactionHash']),
         'invalid log block/tx hash')
    raw_core = {'address': row['address'], 'blockHash': row['blockHash'],
                'transactionHash': row['transactionHash'], 'blockNumber': row['blockNumber'],
                'transactionIndex': row['transactionIndex'], 'logIndex': row['logIndex'],
                'data': row['data'], 'topics': topics, 'removed': False}
    return {'block_number': height, 'block_hash': row['blockHash'],
            'transaction_hash': row['transactionHash'], 'transaction_index': tx_order,
            'log_index': index, 'collateral_asset': collateral, 'debt_asset': debt,
            'borrower_address_hash_sha256': hashlib.sha256(topics[3].encode()).hexdigest(),
            'debt_to_cover_raw': str(debt_raw),
            'collateral_liquidated_raw': str(collateral_raw),
            'receive_atoken': bool(bool_raw), 'raw_event_commitment_sha256': sha(raw_core)}

def identifier(event):
    return event['block_hash'], event['transaction_hash'], event['log_index']

def classify(events):
    return {
        'events_referencing_susde': sum(SUSDE in (e['collateral_asset'], e['debt_asset'])
                                      for e in events),
        'events_referencing_usdtb': sum(USDTB in (e['collateral_asset'], e['debt_asset'])
                                      for e in events),
        'susde_collateral_usdtb_debt': sum(
            (e['collateral_asset'], e['debt_asset']) == (SUSDE, USDTB)
            for e in events),
        'usdtb_collateral_susde_debt': sum(
            (e['collateral_asset'], e['debt_asset']) == (USDTB, SUSDE)
            for e in events),
        'unique_transactions': len({e['transaction_hash'] for e in events}),
        'unique_borrower_hashes': len(
            {e['borrower_address_hash_sha256'] for e in events}),
    }

def interval_cover(shards, start=START, end=END):
    ordered = sorted(shards, key=lambda r: r['start'])
    cursor = start
    for s in ordered:
        need(type(s['start']) is int and type(s['end']) is int and
             s['start'] == cursor and s['end'] >= s['start'],
             'overlapping/missing/inverted source shards')
        cursor = s['end'] + 1
    need(cursor == end + 1, 'incomplete trailing coverage')
    return True

def permitted_split(err):
    s = str(err).lower()
    if any(token in s for token in ('429', 'rate limit', 'api key', '403', '401',
                                    'forbidden', 'unauthorized', 'quota')):
        return False
    return any(token in s for token in ('block range', 'maximum block',
                                        'query exceeds', 'range too large',
                                        'limit the query to', 'max range'))

class RPC:
    def __init__(self, provider, *, min_interval=MIN_RPC_INTERVAL,
                 request_limit=MAX_REQUESTS, transport=None):
        need(provider in PROVIDERS, 'RPC operator not allowlisted')
        need(type(min_interval) in (int, float) and min_interval >= 0,
             'invalid rate-spacing budget')
        need(transport is not None or min_interval >= MIN_RPC_INTERVAL,
             'public RPC minimum spacing cannot be reduced')
        self.operator, self.url = PROVIDERS[provider]
        self.provider = provider
        self.spacing = min_interval
        self.limit = request_limit
        self.transport = transport or self._fetch
        self.requests = 0
        self._previous = None

    @staticmethod
    def _fetch(url, method, params):
        payload = json.dumps({'jsonrpc': '2.0', 'id': 7, 'method': method,
                              'params': params}, separators=(',', ':')).encode()
        req = Request(url, data=payload, method='POST', headers={
            'Content-Type': 'application/json', 'Accept': 'application/json',
            'User-Agent': 'NQC-RMC-V2-Targeted-Historical-ReadOnly/1.0'})
        try:
            with urlopen(req, timeout=36) as stream:
                data = stream.read(MAX_RESPONSE + 1)
                need(len(data) <= MAX_RESPONSE, 'RPC response exceeds size bound')
        except HTTPError as exc:
            # HTTP 400 may mean block range or invalid query. A 403/429
            # must be preserved as a source blocker, never accepted as empty.
            try:
                msg = exc.read(1200).decode('utf-8', 'replace')
            except (OSError, UnicodeError):
                msg = 'ERROR_BODY_UNREADABLE'
            msg = re.sub(r'[^a-zA-Z0-9 _.,:;()\\[\\]/-]', ' ', msg)[:600]
            raise SourceError('RPC_HTTP_' + str(exc.code) + ': ' + msg) from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise SourceError('RPC_NETWORK_' + str(exc)[:170]) from exc
        try:
            doc = json.loads(data)
        except (UnicodeError, ValueError) as exc:
            raise SourceError('RPC JSON malformed') from exc
        need(type(doc) is dict and doc.get('jsonrpc') == '2.0' and doc.get('id') == 7,
             'unexpected RPC envelope')
        if 'error' in doc:
            raise SourceError('RPC_JSON_ERROR_' + str(doc['error'])[:200])
        need('result' in doc, 'RPC result absent')
        return doc['result']

    def call(self, method, params):
        need(self.requests < self.limit, 'RPC_REQUEST_BUDGET_EXHAUSTED')
        if self._previous is not None:
            wait = self.spacing - (time.monotonic() - self._previous)
            if wait > 0:
                time.sleep(wait)
        self._previous = time.monotonic()
        self.requests += 1
        return self.transport(self.url, method, params)

    def header(self, height):
        return checked_header(
            self.call('eth_getBlockByNumber', [hex(height), False]), height)

def compare_receipt(rpc, event, cache):
    tx = event['transaction_hash']
    receipt = cache.get(tx)
    if receipt is None:
        receipt = rpc.call('eth_getTransactionReceipt', [tx])
        need(type(receipt) is dict, 'selected event missing receipt')
        need(receipt.get('transactionHash') == tx and
             receipt.get('blockHash') == event['block_hash'],
             'receipt does not match event tx/block')
        need(q(receipt.get('status'), 'receipt status') == 1, 'winner tx reverted')
        need(q(receipt.get('blockNumber'), 'receipt block') == event['block_number'],
             'receipt different block number')
        need(type(receipt.get('logs')) is list, 'receipt logs unavailable')
        cache[tx] = receipt
    candidates = [
        log for log in receipt['logs']
        if type(log) is dict and
        str(log.get('address', '')).lower() == AAVE and
        q(str(log.get('logIndex', '')), 'receipt logIndex') == event['log_index']
    ]
    need(len(candidates) == 1,
         'candidate Aave LiquidationCall receipt log missing/duplicated')
    match = normalize(
        candidates[0], event['block_number'], event['block_number'],
        'collateral' if event['collateral_asset'] in TARGETS else 'debt')
    need(match['raw_event_commitment_sha256'] == event['raw_event_commitment_sha256'],
         'receipt log raw ABI identity mismatch')
    return {
        'transaction_hash': tx,
        'receipt_gas_used_raw': str(q(receipt['gasUsed'], 'gasUsed')),
        'receipt_effective_gas_price_wei_raw': str(
            q(receipt['effectiveGasPrice'], 'effectiveGasPrice')),
        'receipt_identity_matches': True,
    }

def report_for_provider(rpc, *, start=START, end=END,
                        span=DEFAULT_SPAN, split_limit=SPLIT_LIMIT):
    need(type(start) is int and type(end) is int and
         START <= start <= end <= END,
         'window is not inside the declared post-RMC016 interval')
    need(type(span) is int and 1 <= span <= 50000,
         'invalid source shard span')
    need(type(split_limit) is int and 0 <= split_limit <= SPLIT_LIMIT,
         'invalid split depth')
    need(q(rpc.call('eth_chainId', []), 'chain ID') == CHAIN,
         'non-Ethereum RPC chain')
    prev = rpc.header(PREVIOUS_END)
    need(prev['hash'] == PREVIOUS_END_HASH,
         'old certified window does not chain to new scan')
    first = rpc.header(START)
    need(first['parent_hash'] == PREVIOUS_END_HASH,
         'new scan does not chain from prior block')
    last = rpc.header(END)
    need(last['hash'] == END_HASH and last['parent_hash'] == END_PARENT,
         'new scan target end block canonicality mismatch')

    rows = {}
    shards = []
    streams = (
        ('collateral', [TOPIC, [topic_for(SUSDE), topic_for(USDTB)]]),
        ('debt', [TOPIC, None, [topic_for(SUSDE), topic_for(USDTB)]]),
    )

    def scan(a, b, depth):
        chunk = {}
        try:
            for stream, topics in streams:
                result = rpc.call('eth_getLogs', [{
                    'address': AAVE, 'topics': topics,
                    'fromBlock': hex(a), 'toBlock': hex(b)}])
                need(type(result) is list,
                     'eth_getLogs did not return an array')
                need(len(result) < MAX_EVENT_PER_STREAM_SHARD,
                     'possible capped/truncated log array')
                chunk[stream] = [normalize(row, a, b, stream) for row in result]
        except SourceError as exc:
            if depth >= split_limit or a == b or not permitted_split(exc):
                raise
            mid = (a + b) // 2
            scan(a, mid, depth+1)
            scan(mid+1, b, depth+1)
            return
        for stream in chunk:
            for row in chunk[stream]:
                key = identifier(row)
                if key in rows:
                    need(rows[key] == row,
                         'contradictory duplicate event between streams')
                else:
                    rows[key] = row
        shards.append({'start': a, 'end': b,
                       'collateral_stream_count': len(chunk['collateral']),
                       'debt_stream_count': len(chunk['debt'])})

    cursor = start
    while cursor <= end:
        right = min(cursor + span - 1, end)
        scan(cursor, right, 0)
        cursor = right + 1
    interval_cover(shards, start, end)
    events = sorted(rows.values(), key=lambda e: (
        e['block_number'], e['transaction_index'],
        e['log_index'], e['transaction_hash']))
    need(len({identifier(e) for e in events}) == len(events),
         'duplicate raw events')
    block_cache, receipt_cache = {}, {}
    receipts = []
    for e in events:
        bn = e['block_number']
        if bn not in block_cache:
            block_cache[bn] = rpc.header(bn)
        need(block_cache[bn]['hash'] == e['block_hash'],
             'candidate event block hash differs from canonical header')
        receipts.append(compare_receipt(rpc, e, receipt_cache))
    again_prev = rpc.header(PREVIOUS_END)
    again_first = rpc.header(START)
    again_end = rpc.header(END)
    need(again_prev == prev and again_first == first and again_end == last,
         'scan headers differ between start and completion')
    return {
        'schema_version': 1,
        'contract': 'NQC_RMC_V2_POSTWINDOW_TARGETED_LIQUIDATION_EVIDENCE',
        'scope': 'HISTORICAL_TARGETED_SUSDE_USDTB_NOT_FULL_AAVE_CENSUS',
        'status': 'COMPLETE_SINGLE_PUBLIC_RPC_TARGETED_HISTORICAL_ONLY',
        'chain_id': CHAIN, 'operator_label': rpc.operator,
        'provider_id': rpc.provider,
        'window': {'start': start, 'end': end,
                   'previous_end_hash': PREVIOUS_END_HASH,
                   'end_hash': END_HASH, 'parent_hash': END_PARENT},
        'shards': sorted(shards, key=lambda s: s['start']),
        'total_targeted_events': len(events),
        'summary': classify(events),
        'events': events, 'receipt_checks': receipts,
        'events_sha256': sha(events),
        'receipt_checks_sha256': sha(receipts),
        'provider_rpc_requests': rpc.requests,
        'provider_rate_spacing_seconds': rpc.spacing,
        'full_Aave_liquidation_count_in_postwindow_known': False,
        'independent_operator_authenticity_proven': False,
        'actual_liquidation_by_Nexus': False,
        'nqc_capture_probability_calibrated': False,
        'nqc_realized_pnl_usd': '0',
        'rmc_closed': False, 'p2_shadow_certified': False,
        'commercial_score_upgrade': False,
    }

def compare_reports(first, second):
    for report in (first, second):
        need(type(report) is dict and report.get('contract') ==
             'NQC_RMC_V2_POSTWINDOW_TARGETED_LIQUIDATION_EVIDENCE'
             and report.get('status') == 'COMPLETE_SINGLE_PUBLIC_RPC_TARGETED_HISTORICAL_ONLY',
             'a source is incomplete, cannot compare as exhaustive')
        need(report.get('p2_shadow_certified') is False and
             report.get('nqc_realized_pnl_usd') == '0',
             'provider claimed unverified commercial/Shadow authority')
        window = report.get('window')
        need(type(window) is dict and window.get('start') == START
             and window.get('end') == END
             and window.get('end_hash') == END_HASH,
             'incomplete or wrong post-window bounds')
        interval_cover(report['shards'])
        events = report['events']
        need(type(events) is list and
             len(events) == report['total_targeted_events'],
             'event universe cardinality conflict')
        need(sha(events) == report['events_sha256'],
             'reported event digest mismatch')
        receipts = report.get('receipt_checks')
        need(type(receipts) is list and len(receipts) == len(events)
             and sha(receipts) == report.get('receipt_checks_sha256')
             and all(x.get('receipt_identity_matches') is True for x in receipts),
             'receipt commitments missing or contradictory')
        need(classify(events) == report['summary'],
             'reported targeted statistics incorrect')
    need(first['provider_id'] != second['provider_id'],
         'same endpoint cannot corroborate itself')
    need(first['window'] == second['window'],
         'different canonical periods')
    need(first['events_sha256'] == second['events_sha256']
         and first['events'] == second['events'],
         'targeted event mismatch between public RPC endpoints')
    need(first['receipt_checks_sha256'] == second['receipt_checks_sha256']
         and first['receipt_checks'] == second['receipt_checks'],
         'targeted receipt mismatch between public RPC endpoints')
    return {
        'schema_version': 1,
        'contract': 'NQC_RMC_V2_TARGETED_POSTWINDOW_DUAL_ENDPOINT_COMPARISON',
        'status': 'TWO_DISTINCT_PUBLIC_ENDPOINTS_EXACT_EVENTS_MATCH',
        'provider_ids': sorted([first['provider_id'], second['provider_id']]),
        'block_start': START, 'block_end': END,
        'events_sha256': first['events_sha256'],
        'total_targeted_events': first['total_targeted_events'],
        'summary': first['summary'],
        'independent_rpc_operator_authentication_proven': False,
        'zero_event_result_only_valid_for_target_pair_and_interval': True,
        'no_evidence_of_live_Nexus_capture_or_profit': True,
        'rmc_closed': False,
        'p2_shadow_certified': False,
        'nqc_realized_pnl_usd': '0',
    }

def write_json(path, obj):
    Path(path).write_bytes(
        json.dumps(obj, indent=2, sort_keys=True).encode() + b'\n')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--provider', choices=sorted(PROVIDERS),
                    default='publicnode')
    ap.add_argument('--span', type=int, default=DEFAULT_SPAN)
    ap.add_argument('--min-interval', type=float,
                    default=MIN_RPC_INTERVAL)
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--compare', nargs=2, type=Path)
    args = ap.parse_args()
    if args.compare:
        a, b = (json.loads(p.read_text()) for p in args.compare)
        result = compare_reports(a, b)
    else:
        result = report_for_provider(
            RPC(args.provider, min_interval=args.min_interval),
            span=args.span)
    write_json(args.output, result)
    print(result['status'], 'targeted events', result['total_targeted_events'])

if __name__ == '__main__':
    main()
