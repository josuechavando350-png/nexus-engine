#!/usr/bin/env python3
"""Prospective read-only ETH/USD pending->confirmed log/receipt overlap audit.

Bounded public dRPC WebSocket newHeads + full pending + NewTransmission logs,
then narrowly scoped canonical HTTP evidence. No keys, broadcasts, trading,
price prediction, private orderflow, or profitability claims. Source-only
observability is NOT inclusion access or capture.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen

import oracle_ws_visibility_probe as base
from oracle_pending_visibility_probe import AGGREGATOR, parse_oracle_payload, strict_json, canon

NEW_TRANSMISSION_TOPIC = '0xc797025feeeaf2cd924c99e9205ac8ec04d5cad21c41ce637a38fb6dee6016a'
SECONDARY_ROUND_TOPIC = '0x8d530b9ddc4b318d28fdd4c3a21fcfecece54c1a72a824f262985b99afef009b'
EVENT_TOPICS = [SECONDARY_ROUND_TOPIC, NEW_TRANSMISSION_TOPIC]
HTTP_RPC = 'https://eth.drpc.org'
MAX_SECONDS = 360
MAX_WS_NOTIFICATIONS = 30_000
MAX_CONTROLS = 24
MAX_LOGS = 48
MAX_RECEIPTS = 48
MAX_RPC_CALLS = 60
HEX32 = re.compile(r'0x[0-9a-fA-F]{64}\Z')
HEXQ = re.compile(r'0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z')


def now_utc():
    return datetime.now(timezone.utc).isoformat()


def need(ok, why):
    if not ok:
        raise ValueError(why)


def b32(value):
    need(type(value) is str and HEX32.fullmatch(value), 'invalid bytes32')
    return value.lower()


def quantity(value):
    need(type(value) is str and HEXQ.fullmatch(value), 'invalid RPC quantity')
    return int(value, 16)


def basic_report(seconds):
    return {
        'schema_version': 1,
        'status': 'INCOMPLETE_ORACLE_PENDING_TO_CANONICAL_OVERLAP',
        'run_started_at_utc': now_utc(),
        'duration_requested_seconds': seconds,
        'source': 'Ethereum public dRPC single-operator WebSocket + HTTP',
        'oracle_aggregator': AGGREGATOR,
        'primary_new_transmission_topic0': NEW_TRANSMISSION_TOPIC,
        'secondary_round_topic0': SECONDARY_ROUND_TOPIC,
        'oracle_update_topics': EVENT_TOPICS,
        'generic_ocr2_topic_filter_was_invalidated': True,
        'ws_observation': base.report_template(),
        'oracle_logs_subscription': {'accepted': False},
        'oracle_logs_notifications': 0,
        'oracle_logs_distinct': 0,
        'oracle_logs_removed': 0,
        'oracle_logs_invalid': 0,
        'sampled_pending_control_hashes': 0,
        'sampled_control_receipts_verified': 0,
        'control_pending_to_head_lead_ms': [],
        'confirmed_oracle_updates_in_ws_head_span': None,
        'distinct_confirmed_oracle_update_transactions': None,
        'oracle_update_kinds': {'SECONDARY_ROUND_ID_UPDATED': 0, 'PRIMARY_NEW_TRANSMISSION': 0},
        'confirmed_primary_new_transmissions': None,
        'confirmed_secondary_round_updates': None,
        'confirmed_oracle_receipts_verified': 0,
        'confirmed_oracle_with_prior_process_pending_observation': 0,
        'confirmed_oracle_without_prior_process_pending_observation': 0,
        'oracle_pending_to_head_lead_ms': [],
        'canonical_positive_controls': [],
        'source_limitations': [],
        'rpc_transcript': [],
        'ws_logs_vs_canonical_missing': [],
        'pending_first_seen_by_node_proven': False,
        'mempool_exhaustiveness_proven': False,
        'before_inclusion_to_all_builders_proven': False,
        'oracle_hf_crossing_proven': False,
        'profitable_competitive_capture_proven': False,
        'nonrecourse_native_gas_sponsor_proven': False,
        'net_pnl_certified': False,
        'RMC_closed': False,
        'P2_shadow_certified': False,
        'canary_live_authorized': False,
        'commercial_score_upgrade': False,
        'nqc_realized_pnl_usd': '0',
    }


class Witness:
    def __init__(self, seconds):
        self.output = basic_report(seconds)
        self.pending = {}
        self.controls = {}
        self.heads = {}
        self.stream_logs = {}
        self.unique_log_ids = set()
        self.ws_count = 0
        self.first_monotonic_ns = time.monotonic_ns()

    def incoming(self, raw: bytes | str, when_ns=None, when_utc=None):
        when_ns = time.monotonic_ns() if when_ns is None else when_ns
        when_utc = when_utc or now_utc()
        raw_bytes = raw.encode() if isinstance(raw, str) else raw
        need(type(raw_bytes) is bytes and 0 < len(raw_bytes) <= base.MAX_FRAME_BYTES,
             'bad or oversized WebSocket frame')
        value = strict_json(raw_bytes)
        need(type(value) is dict and value.get('jsonrpc') == '2.0',
             'invalid JSON-RPC envelope')

        if value.get('id') == 4:
            token = value.get('result')
            if 'error' in value or type(token) is not str or not base.VALID_SUB_ID.fullmatch(token):
                self.output['source_limitations'].append('ORACLE_LOGS_SUBSCRIPTION_REJECTED')
            else:
                self.output['oracle_logs_subscription'] = {
                    'accepted': True, 'subscription_id': token.lower()}
            return

        if value.get('method') == 'eth_subscription':
            params = value.get('params')
            need(type(params) is dict and type(params.get('subscription')) is str,
                 'malformed subscription notification')
            log_sub = self.output['oracle_logs_subscription']
            if log_sub.get('accepted') and params['subscription'].lower() == log_sub.get('subscription_id'):
                self.output['oracle_logs_notifications'] += 1
                log = params.get('result')
                if type(log) is not dict:
                    self.output['oracle_logs_invalid'] += 1
                    return
                try:
                    parsed_log = parse_log(log)
                except (ValueError, TypeError) as exc:
                    if log.get('removed') is True:
                        self.output['oracle_logs_removed'] += 1
                    else:
                        self.output['oracle_logs_invalid'] += 1
                    return
                identity = (parsed_log['tx_hash'], parsed_log['block_hash'],
                            parsed_log['log_index'])
                if identity not in self.unique_log_ids:
                    self.unique_log_ids.add(identity)
                    self.output['oracle_logs_distinct'] += 1
                    if len(self.stream_logs) < MAX_LOGS:
                        self.stream_logs[identity] = {
                            **parsed_log,
                            'observed_at_utc': when_utc,
                            'observed_ns': when_ns,
                        }
                return

        before_pending = self.output['ws_observation']['pending_notifications']
        before_heads = self.output['ws_observation']['observed_chain_heads']
        base.handle_rpc_message(self.output['ws_observation'], raw_bytes, when_utc)

        if self.output['ws_observation']['observed_chain_heads'] > before_heads:
            head = self.output['ws_observation']['last_head']
            self.heads[head['hash']] = {
                **head, 'observed_ns': when_ns}
            return

        if self.output['ws_observation']['pending_notifications'] > before_pending:
            params = value['params']
            tx = params['result']
            if type(tx) is not dict or type(tx.get('hash')) is not str or not HEX32.fullmatch(tx['hash']):
                return
            if any(tx.get(key) is not None for key in
                   ('blockHash', 'blockNumber', 'transactionIndex')):
                return
            txhash = tx['hash'].lower()

            # A bounded, pre-declared 1/64 uniform-hash baseline control
            # sample, independent of future inclusion or eventual outcome.
            if (sha256(bytes.fromhex(txhash[2:])).digest()[0] & 63) == 0:
                if txhash not in self.controls and len(self.controls) < MAX_CONTROLS:
                    self.controls[txhash] = {'hash': txhash,
                        'process_observed_at_utc': when_utc,
                        'process_observed_ns': when_ns}

            # Candidate selection uses a predeclared target and selector, not
            # oracle price movement, past winners or future receipts.
            to = tx.get('to', '')
            calldata = tx.get('input', '')
            if type(to) is not str or type(calldata) is not str:
                return
            if to.lower() != AGGREGATOR and not calldata.lower().startswith('0x'+base.FORWARD_SELECTOR):
                return
            try:
                parsed = parse_oracle_payload(tx)
            except (TypeError, ValueError):
                return
            if parsed is not None and txhash not in self.pending and len(self.pending) < MAX_LOGS:
                self.pending[txhash] = {
                    'hash': txhash,
                    'first_observed_by_process_utc': when_utc,
                    'first_observed_ns': when_ns,
                    'head_at_observation': self.output['ws_observation']['last_head'],
                    'kind': parsed['kind'],
                    'input_sha256': parsed['input_sha256'],
                }


class RPC:
    """Single-source, capped read-only canonical reconciliation."""

    def __init__(self, transport=None):
        self.calls = 0
        self.transport = transport or self.network
        self.transcript = []

    @staticmethod
    def network(method, params):
        need(method in ('eth_getLogs', 'eth_getTransactionReceipt',
                        'eth_getBlockByNumber'), 'read-only method allowlist')
        data = json.dumps({'jsonrpc': '2.0', 'id': 88,
                           'method': method, 'params': params}).encode()
        request = Request(HTTP_RPC, method='POST', data=data,
                          headers={'Content-Type': 'application/json',
                                   'User-Agent': 'NQC-V2-Oracle-Overlap-ReadOnly/1'})
        with urlopen(request, timeout=20) as response:
            answer = response.read(4_000_001)
        need(len(answer) <= 4_000_000, 'oversized RPC body')
        result = strict_json(answer)
        need(type(result) is dict and result.get('id') == 88 and
             result.get('jsonrpc') == '2.0' and 'error' not in result and
             'result' in result, 'RPC failed or malformed')
        return result['result']

    def call(self, method, params):
        need(self.calls < MAX_RPC_CALLS, 'RPC call quota exhausted')
        if method == 'eth_getLogs':
            need(type(params) is list and len(params) == 1 and type(params[0]) is dict,
                 'invalid eth_getLogs arguments')
            arg = params[0]
            need(set(arg) == {'address', 'topics', 'fromBlock', 'toBlock'} and
                 arg['address'] == AGGREGATOR and
                 arg['topics'] == [EVENT_TOPICS] and
                 0 <= quantity(arg['toBlock']) - quantity(arg['fromBlock']) <= 35,
                 'unbounded oracle getLogs scan')
        elif method == 'eth_getTransactionReceipt':
            need(type(params) is list and len(params) == 1 and
                 type(params[0]) is str and HEX32.fullmatch(params[0]),
                 'unbounded receipt read')
        elif method == 'eth_getBlockByNumber':
            need(type(params) is list and len(params) == 2 and
                 type(params[0]) is str and HEXQ.fullmatch(params[0]) and
                 params[1] is False, 'unbounded header read')
        else:
            raise ValueError('unknown RPC method')
        self.calls += 1
        record = {'method': method, 'params': params,
                  'started_at_utc': now_utc()}
        try:
            # Conservative provider rate budget; never evade throttling.
            if self.transport == self.network:
                time.sleep(0.6)
            result = self.transport(method, params)
            record['result_sha256'] = sha256(canon(result)).hexdigest()
            return result
        except Exception as exc:
            record['error_type'] = type(exc).__name__
            record['error_excerpt'] = str(exc).split('https://')[0][:160]
            raise
        finally:
            record['completed_at_utc'] = now_utc()
            self.transcript.append(record)


def parse_log(value):
    need(type(value) is dict and type(value.get('address')) is str and
         value['address'].lower() == AGGREGATOR, 'wrong log origin')
    topics = value.get('topics')
    need(type(topics) is list and len(topics) >= 2 and
         type(topics[0]) is str and topics[0].lower() in EVENT_TOPICS,
         'wrong/unknown DualAggregator update signature')
    need(value.get('removed') in (False, None), 'removed log')
    round_id = int(b32(topics[1]), 16)
    need(0 < round_id < 2**32, 'unusable uint32 indexed round ID')
    data = value.get('data')
    need(type(data) is str and data.startswith('0x') and len(data)%2 == 0,
         'bad event ABI payload')
    topic = topics[0].lower()
    if topic == SECONDARY_ROUND_TOPIC:
        need(data == '0x', 'secondary round-only log must not contain price data')
        answer = None
        kind = 'SECONDARY_ROUND_ID_UPDATED'
    else:
        need(len(data) >= 66 and all(ch in '0123456789abcdefABCDEF' for ch in data[2:]),
             'primary NewTransmission answer unparseable')
        answer = int(data[2:66], 16)
        need(0 < answer < 2**191, 'invalid custom primary price answer')
        kind = 'PRIMARY_NEW_TRANSMISSION'
    return {'tx_hash': b32(value.get('transactionHash')),
            'block_hash': b32(value.get('blockHash')),
            'block_number': quantity(value.get('blockNumber')),
            'log_index': quantity(value.get('logIndex')),
            'event_type': kind, 'event_topic0': topic,
            'indexed_round_id': round_id, 'primary_answer_raw': answer,
            'event_data_sha256': sha256(bytes.fromhex(data[2:])).hexdigest()}


def verify_receipt(receipt, item, witness):
    need(type(receipt) is dict and receipt.get('transactionHash', '').lower() == item['tx_hash'],
         'receipt tx hash changed')
    need(quantity(receipt.get('blockNumber')) == item['block_number'] and
         b32(receipt.get('blockHash')) == item['block_hash'],
         'receipt block mismatch')
    need(quantity(receipt.get('status')) == 1, 'oracle update transaction reverted')
    gas = quantity(receipt.get('gasUsed'))
    effective = quantity(receipt.get('effectiveGasPrice'))
    need(gas > 0 and effective > 0, 'receipt native gas missing')
    logs = receipt.get('logs')
    need(type(logs) is list and len(logs) < 20_000, 'receipt logs invalid')
    matches = [x for x in logs if type(x) is dict and
               x.get('address', '').lower() == AGGREGATOR and
               quantity(x.get('logIndex')) == item['log_index']]
    need(len(matches) == 1 and parse_log(matches[0]) == item,
         'oracle log not in canonical receipt')
    head = witness.heads.get(item['block_hash'])
    lead_ms = None
    pending = witness.pending.get(item['tx_hash'])
    if (pending is not None and head is not None and
            pending['first_observed_ns'] < head['observed_ns']):
        lead_ms = (head['observed_ns'] - pending['first_observed_ns']) // 1_000_000
    return {'tx_hash': item['tx_hash'],
            'block_number': item['block_number'],
            'block_hash': item['block_hash'],
            'receipt_status': 1,
            'event_type': item['event_type'],
            'event_topic0': item['event_topic0'],
            'gas_used': gas,
            'effective_gas_price_wei': effective,
            'was_seen_pending_in_this_process': pending is not None,
            'process_observed_pending_to_head_ms': lead_ms,
            'has_same_process_head_witness': head is not None,
            'independent_rpc_operator_parity_proven': False}


def reconcile(witness, rpc):
    out = witness.output
    stream = out['ws_observation']
    out['sampled_pending_control_hashes'] = len(witness.controls)
    out['pending_candidates_first_seen'] = [
        {k:v for k,v in case.items() if k != 'first_observed_ns'}
        for case in witness.pending.values()]
    out['new_heads_seen'] = [
        {k:v for k,v in case.items() if k != 'observed_ns'}
        for case in witness.heads.values()]
    out['ws_oracle_log_witnesses'] = [
        {k:v for k,v in case.items() if k != 'observed_ns'}
        for case in witness.stream_logs.values()]
    if not (stream['chain_id_verified'] and
            stream['subscriptions']['newHeads']['accepted'] and
            stream['subscriptions']['drpc_pendingTransactions']['accepted'] and
            out['oracle_logs_subscription']['accepted']):
        out['source_limitations'].append('MISSING_REQUIRED_WS_SUBSCRIPTION')
        return finalize(out, rpc)
    heads = list(witness.heads.values())
    if len(heads) < 2:
        out['source_limitations'].append('LESS_THAN_TWO_WS_HEADS')
        return finalize(out, rpc)
    first = min(h['number'] for h in heads)
    last = max(h['number'] for h in heads)
    if last-first > 35:
        out['source_limitations'].append('UNSUPPORTED_HEAD_SPAN_OVER_35')
        return finalize(out, rpc)
    try:
        for height in (first, last):
            head = rpc.call('eth_getBlockByNumber', [hex(height), False])
            need(type(head) is dict and quantity(head.get('number')) == height,
                 'height mismatch')
            chain_head = witness.heads.get(b32(head.get('hash')))
            need(chain_head is not None and chain_head['number'] == height,
                 'head hash/height disagrees with current canonical')
        raw_logs = rpc.call('eth_getLogs', [{
            'address': AGGREGATOR, 'topics': [EVENT_TOPICS],
            'fromBlock': hex(first), 'toBlock': hex(last)}])
        need(type(raw_logs) is list and len(raw_logs) <= 100,
             'source returned oversized oracle log corpus')
        logs = [parse_log(v) for v in raw_logs]
        need(len(logs) == len({(v['tx_hash'], v['block_hash'], v['log_index'])
                               for v in logs}), 'duplicate canonical event')
        out['confirmed_oracle_updates_in_ws_head_span'] = len(logs)
        out['distinct_confirmed_oracle_update_transactions'] = len({x['tx_hash'] for x in logs})
        out['oracle_update_kinds'] = {
            'SECONDARY_ROUND_ID_UPDATED': sum(e['event_type']=='SECONDARY_ROUND_ID_UPDATED' for e in logs),
            'PRIMARY_NEW_TRANSMISSION': sum(e['event_type']=='PRIMARY_NEW_TRANSMISSION' for e in logs),
        }
        # Scope is restricted to block hashes witnessed by the same WS,
        # and the first block is left-censored at subscription start.
        for item in logs[:MAX_LOGS]:
            if item['block_hash'] not in witness.heads:
                out['source_limitations'].append('CANONICAL_LOG_HEAD_NOT_OBSERVED_WS')
                continue
            try:
                receipt = rpc.call('eth_getTransactionReceipt', [item['tx_hash']])
                result = verify_receipt(receipt, item, witness)
                out['canonical_positive_controls'].append(result)
                out['confirmed_oracle_receipts_verified'] += 1
                if result['process_observed_pending_to_head_ms'] is not None:
                    out['confirmed_oracle_with_prior_process_pending_observation'] += 1
                    out['oracle_pending_to_head_lead_ms'].append(
                        result['process_observed_pending_to_head_ms'])
                else:
                    out['confirmed_oracle_without_prior_process_pending_observation'] += 1
            except Exception as exc:
                out['source_limitations'].append('ORACLE_RECEIPT_FAILED_'+type(exc).__name__)
        seen_ws_logs = set(witness.stream_logs)
        canonical_ids = {(item['tx_hash'], item['block_hash'], item['log_index'])
                         for item in logs}
        # The first observed block can predate our subscription start.
        # Never use it as evidence that an update was invisible while pending.
        for item in logs:
            key = (item['tx_hash'], item['block_hash'], item['log_index'])
            if item['block_number'] > first and key not in seen_ws_logs:
                out['ws_logs_vs_canonical_missing'].append(item['tx_hash'])
        if out['ws_logs_vs_canonical_missing']:
            out['source_limitations'].append('CANONICAL_NEW_TRANSMISSION_MISSING_IN_WS_STREAM')
        ws_extra = [key[0] for key in seen_ws_logs if
                    key[1] in witness.heads and key not in canonical_ids]
        if ws_extra:
            out['source_limitations'].append('WS_ORACLE_LOG_NOT_IN_CANONICAL_RESULT')
        # Deterministically preselected *ordinary* pending transactions,
        # not a cherry-picked set of successfully included transactions.
        # Confirm receipts in the same WS head span only; others censored.
        for txhash, sample in list(witness.controls.items())[:MAX_CONTROLS]:
            try:
                receipt = rpc.call('eth_getTransactionReceipt', [txhash])
                if receipt is None:
                    continue
                need(type(receipt) is dict and
                     receipt.get('transactionHash', '').lower() == txhash,
                     'control receipt mismatch')
                block_hash = b32(receipt.get('blockHash'))
                head = witness.heads.get(block_hash)
                if head is None:
                    continue
                gas = quantity(receipt.get('gasUsed'))
                need(gas > 0, 'control gas invalid')
                out['sampled_control_receipts_verified'] += 1
                if sample['process_observed_ns'] < head['observed_ns']:
                    out['control_pending_to_head_lead_ms'].append(
                        (head['observed_ns'] - sample['process_observed_ns'])//1_000_000)
            except Exception as exc:
                out['source_limitations'].append('CONTROL_RECEIPT_FAILED_'+type(exc).__name__)
        # Canonical header re-check catches reorg over the query interval.
        for height in (first,last):
            latest = rpc.call('eth_getBlockByNumber', [hex(height),False])
            need(b32(latest.get('hash')) in witness.heads and
                 witness.heads[b32(latest['hash'])]['number']==height,
                 'canonical endpoints changed during reconciliation')
    except Exception as exc:
        out['source_limitations'].append('CANONICAL_RECONCILIATION_FAILED_'+type(exc).__name__)
    return finalize(out, rpc)


def finalize(out, rpc):
    out['rpc_transcript'] = rpc.transcript
    out['rpc_calls_used'] = rpc.calls
    out['run_finished_at_utc'] = now_utc()
    if out['source_limitations']:
        out['status'] = 'INCOMPLETE_ORACLE_PENDING_TO_CANONICAL_OVERLAP'
    elif (out['confirmed_oracle_updates_in_ws_head_span'] is not None and
          out['confirmed_oracle_updates_in_ws_head_span'] ==
          out['confirmed_oracle_receipts_verified'] and
          out['confirmed_oracle_receipts_verified'] > 0):
        out['status'] = 'PROSPECTIVE_ORACLE_LOGS_RECONCILED_NO_CAPTURE'
    elif out['confirmed_oracle_updates_in_ws_head_span'] == 0:
        out['status'] = 'NO_ORACLE_TRANSMISSIONS_IN_BOUNDED_CANONICAL_SPAN'
    else:
        out['status'] = 'INCOMPLETE_ORACLE_PENDING_TO_CANONICAL_OVERLAP'
    return out


async def observe(seconds, max_notifications, connector=None):
    need(type(seconds) is int and 20 <= seconds <= MAX_SECONDS,
         'unbounded observation duration')
    need(type(max_notifications) is int and 100 <= max_notifications <= MAX_WS_NOTIFICATIONS,
         'unbounded notification budget')
    witness = Witness(seconds)
    start = time.monotonic()
    if connector is None:
        from websockets.asyncio.client import connect
        connector = connect
    try:
        async with connector(base.WS_URL, open_timeout=15, close_timeout=3,
                             ping_interval=15, ping_timeout=10,
                             max_size=base.MAX_FRAME_BYTES,max_queue=16) as ws:
            calls = ((1, 'eth_chainId', []),
                     (2, 'eth_subscribe', ['newHeads']),
                     (3, 'eth_subscribe', ['drpc_pendingTransactions']),
                     (4, 'eth_subscribe', ['logs',
                                          {'address': AGGREGATOR,
                                           'topics': [EVENT_TOPICS]}]))
            for rid, name, params in calls:
                await ws.send(json.dumps({'jsonrpc':'2.0','id':rid,
                                          'method':name,'params':params}))
            while time.monotonic()-start < seconds:
                if witness.output['ws_observation']['pending_notifications'] >= max_notifications:
                    witness.output['source_limitations'].append('NOTIFICATION_CAP_REACHED')
                    break
                try:
                    msg = await asyncio.wait_for(ws.recv(),
                            timeout=min(5, max(0.1,seconds-(time.monotonic()-start))))
                except asyncio.TimeoutError:
                    continue
                try:
                    witness.incoming(msg)
                except (ValueError,UnicodeError,TypeError) as exc:
                    witness.output['source_limitations'].append(
                        'INVALID_WS_FRAME_'+type(exc).__name__)
                    break
    except Exception as exc:
        witness.output['source_limitations'].append(
            'WS_TRANSPORT_'+type(exc).__name__+':'+str(exc).split('https://')[0][:120])
    witness.output['ws_elapsed_seconds'] = round(time.monotonic()-start,3)
    return witness


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=240)
    parser.add_argument('--max-notifications', type=int, default=24000)
    a = parser.parse_args()
    need(a.out.is_absolute() and a.out.parent.is_dir() and not a.out.exists(),
         'fresh absolute output required')
    witness = asyncio.run(observe(a.seconds, a.max_notifications))
    report = reconcile(witness, RPC())
    with a.out.open('xb') as f:
        f.write(canon(report))
    print(report['status'], 'pending',report['ws_observation']['pending_notifications'],
          'oracle_logs_ws', report['oracle_logs_distinct'],
          'canonical_oracle_updates', report['confirmed_oracle_updates_in_ws_head_span'],
          'receipts_verified',report['confirmed_oracle_receipts_verified'],
          'prior_pending',report['confirmed_oracle_with_prior_process_pending_observation'],
          'controls',report['sampled_control_receipts_verified'],
          'limitations',len(report['source_limitations']))
    return 0  # The audit may validly conclude INCOMPLETE; no economic PASS.


if __name__ == '__main__':
    raise SystemExit(main())
