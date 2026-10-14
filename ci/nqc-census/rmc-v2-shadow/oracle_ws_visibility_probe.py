#!/usr/bin/env python3
"""Bounded prospective ETH/USD oracle-report *visibility* via dRPC WebSocket.

Read only. An RPC subscription is not a complete mempool and a reported pending
transaction is not proof of future inclusion, actionable HF or NQC capture.
No signing, transaction sending, private flow access, infrastructure deployment,
or economic authority. Preserve negative and unsupported-source results.
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

from oracle_pending_visibility_probe import (
    AGGREGATOR, FORWARD_SELECTOR, Rejected, need, canon, parse_oracle_payload,
    strict_json,
)

WS_URL = 'wss://eth.drpc.org'
MAX_RUNTIME_SECONDS = 90
MAX_NOTIFICATIONS = 30_000
MAX_FRAME_BYTES = 256_000
MAX_EVIDENCE_CANDIDATES = 12
VALID_HEX_32 = re.compile(r'0x[0-9a-fA-F]{64}\Z')
VALID_SUB_ID = re.compile(r'0x[0-9a-fA-F]{1,128}\Z')
VALID_HEX_NUMBER = re.compile(r'0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z')
SUBSCRIPTIONS = {2: 'newHeads', 3: 'drpc_pendingTransactions'}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def is_hex_quantity(value):
    return type(value) is str and VALID_HEX_NUMBER.fullmatch(value) is not None


def is_hex_hash(value):
    return type(value) is str and VALID_HEX_32.fullmatch(value) is not None


def report_template():
    return {
        'schema_version': 1,
        'status': 'INCOMPLETE_WEBSOCKET_SOURCE_CAPABILITY',
        'started_at_utc': utc_now(),
        'source_id': 'drpc-public-wss',
        'source_url': WS_URL,
        'documented_pending_type': 'drpc_pendingTransactions',
        'documented_head_type': 'newHeads',
        'chain_id_verified': False,
        'subscriptions': {'newHeads': {'accepted': False},
                          'drpc_pendingTransactions': {'accepted': False}},
        'observed_chain_heads': 0,
        'first_head': None,
        'last_head': None,
        'pending_notifications': 0,
        'pending_full_tx_objects_valid': 0,
        'pending_hash_only_notifications': 0,
        'pending_invalid_tx_objects': 0,
        'candidate_matches': [],
        'candidate_count_total': 0,
        'subscription_or_rpc_errors': [],
        'unexpected_payload_sha256': [],
        'max_notifications': MAX_NOTIFICATIONS,
        'max_runtime_seconds': MAX_RUNTIME_SECONDS,
        'pending_first_seen_in_node_mempool_proven': False,
        'public_mempool_completeness_proven': False,
        'observed_before_canonical_inclusion_proven': False,
        'price_report_acceptance_proven': False,
        'hf_crossing_proven': False,
        'accessible_transaction_ordering_proven': False,
        'prospective_capture_proven': False,
        'external_nonrecourse_gas_sponsor_proven': False,
        'nqc_net_pnl_certified': False,
        'RMC_closed': False,
        'P2_shadow_certified': False,
        'canary_live_authorized': False,
        'commercial_score_upgrade': False,
        'nqc_realized_pnl_usd': '0',
    }


def handle_rpc_message(report: dict, body: bytes | str, now: str | None = None):
    """Verify and classify a single RPC WebSocket frame; never promote malformed data.

    Maintains only counters, head identity and bounded candidate fingerprints.
    A syntactically accepted subscription and zero events != a working feed.
    """
    if type(body) is str:
        body = body.encode('utf8')
    need(type(body) is bytes and 0 < len(body) <= MAX_FRAME_BYTES, 'invalid WS frame size')
    obj = strict_json(body)
    need(type(obj) is dict and obj.get('jsonrpc') == '2.0', 'non-JSONRPC WS frame')
    now = now or utc_now()

    if 'id' in obj:
        rid = obj['id']
        need(type(rid) is int and rid in (1, 2, 3, 4, 5), 'unexpected WS response ID')
        if rid == 1:
            if obj.get('result') == '0x1' and 'error' not in obj:
                report['chain_id_verified'] = True
            else:
                report['subscription_or_rpc_errors'].append(
                    {'kind': 'WRONG_OR_UNAVAILABLE_CHAIN', 'id': 1})
            return
        if rid in SUBSCRIPTIONS:
            name = SUBSCRIPTIONS[rid]
            subid = obj.get('result')
            if 'error' in obj or type(subid) is not str or not VALID_SUB_ID.fullmatch(subid):
                report['subscription_or_rpc_errors'].append(
                    {'kind': 'SUBSCRIPTION_REJECTED', 'method': name,
                     'error_code': obj.get('error', {}).get('code')
                     if type(obj.get('error')) is dict else None})
                return
            report['subscriptions'][name] = {'accepted': True, 'subscription_id': subid.lower()}
            return
        # Cleanup unsubscribe acknowledgements never assert data authority.
        return

    need(obj.get('method') == 'eth_subscription', 'unrecognized unsolicited WS RPC method')
    params = obj.get('params')
    need(type(params) is dict and type(params.get('subscription')) is str,
         'invalid WS subscription wrapper')
    sub = params['subscription'].lower()
    head_sub = report['subscriptions']['newHeads']
    pending_sub = report['subscriptions']['drpc_pendingTransactions']

    if head_sub.get('accepted') and sub == head_sub.get('subscription_id'):
        h = params.get('result')
        need(type(h) is dict and is_hex_quantity(h.get('number'))
             and is_hex_quantity(h.get('timestamp')) and
             is_hex_hash(h.get('hash')) and is_hex_hash(h.get('parentHash')),
             'unverifiable newHeads notification')
        head = {'number': int(h['number'], 16), 'hash': h['hash'].lower(),
                'parent_hash': h['parentHash'].lower(),
                'timestamp': int(h['timestamp'], 16), 'observed_at_utc': now}
        need(head['number'] > 0 and head['hash'] != head['parent_hash'],
             'bad/degenerate block header')
        report['observed_chain_heads'] += 1
        if report['first_head'] is None:
            report['first_head'] = head
        report['last_head'] = head
        return

    if pending_sub.get('accepted') and sub == pending_sub.get('subscription_id'):
        report['pending_notifications'] += 1
        tx = params.get('result')
        if type(tx) is str and is_hex_hash(tx):
            report['pending_hash_only_notifications'] += 1
            return
        if type(tx) is not dict or not is_hex_hash(tx.get('hash')):
            report['pending_invalid_tx_objects'] += 1
            if len(report['unexpected_payload_sha256']) < 3:
                report['unexpected_payload_sha256'].append(sha256(body).hexdigest())
            return
        # Cannot classify already mined metadata as a pending observation.
        if any(tx.get(x) is not None for x in
               ('blockHash', 'blockNumber', 'transactionIndex')):
            report['pending_invalid_tx_objects'] += 1
            return
        report['pending_full_tx_objects_valid'] += 1
        to = tx.get('to')
        raw_input = tx.get('input')
        if to is None:  # contract creation, irrelevant to the narrow target
            return
        if type(to) is not str or type(raw_input) is not str:
            report['pending_invalid_tx_objects'] += 1
            return
        if to.lower() != AGGREGATOR and not raw_input.lower().startswith('0x'+FORWARD_SELECTOR):
            return
        try:
            candidate = parse_oracle_payload(tx)
        except (ValueError, TypeError, Rejected):
            report['pending_invalid_tx_objects'] += 1
            return
        if candidate is None:
            return
        report['candidate_count_total'] += 1
        if len(report['candidate_matches']) < MAX_EVIDENCE_CANDIDATES:
            report['candidate_matches'].append({
                'hash': tx['hash'].lower(),
                'first_observed_by_this_process_utc': now,
                'observed_head_number': report['last_head']['number']
                if report['last_head'] else None,
                'first_seen_by_node_unproven': True,
                'receipt_null_at_detection_unverified': True,
                **candidate,
            })
        return

    # A notification for a subscription with no authenticated ACK is censored.
    report['pending_invalid_tx_objects'] += 1


def conclude(report: dict, transport_closed: bool = False):
    heads = report['subscriptions']['newHeads']['accepted']
    pending = report['subscriptions']['drpc_pendingTransactions']['accepted']
    if not report['chain_id_verified'] or not heads or not pending:
        status = 'SOURCE_SUBSCRIPTION_OR_CHAIN_UNAVAILABLE'
    elif report['pending_hash_only_notifications'] and not report['pending_full_tx_objects_valid']:
        status = 'FULL_PENDING_TX_OBJECTS_NOT_SUPPORTED'
    elif report['pending_invalid_tx_objects'] and not report['pending_full_tx_objects_valid']:
        status = 'UNVERIFIABLE_PENDING_WS_PAYLOAD'
    elif report['pending_notifications'] == 0 or report['observed_chain_heads'] == 0:
        status = 'CENSORED_NO_HEAD_OR_PENDING_HEARTBEAT'
    elif report['candidate_count_total'] > 0:
        status = 'PENDING_ETH_USD_CANDIDATE_UNCONFIRMED'
    elif transport_closed:
        status = 'CENSORED_PREMATURE_WS_DISCONNECT'
    else:
        status = 'NO_ORACLE_CANDIDATE_IN_BOUNDED_WS_STREAM_NOT_ABSENCE'
    report['status'] = status
    report['finished_at_utc'] = utc_now()
    return report


async def observe(seconds: int, max_notifications: int, connect=None):
    need(type(seconds) is int and 10 <= seconds <= MAX_RUNTIME_SECONDS,
         'duration out of audited bounds')
    need(type(max_notifications) is int and 50 <= max_notifications <= MAX_NOTIFICATIONS,
         'notification quota out of audited bounds')
    report = report_template()
    report['duration_requested_seconds'] = seconds
    report['notification_quota_requested'] = max_notifications
    t0 = time.monotonic()
    premature = False
    try:
        if connect is None:
            from websockets.asyncio.client import connect as ws_connect
            connect = ws_connect
        async with connect(WS_URL, open_timeout=15, close_timeout=3,
                           ping_interval=15, ping_timeout=10,
                           max_size=MAX_FRAME_BYTES, max_queue=16) as ws:
            for rid, method, params in (
                (1, 'eth_chainId', []),
                (2, 'eth_subscribe', ['newHeads']),
                (3, 'eth_subscribe', ['drpc_pendingTransactions']),
            ):
                await ws.send(json.dumps({'jsonrpc': '2.0', 'id': rid,
                                          'method': method, 'params': params}))
            while time.monotonic() - t0 < seconds:
                if (report['pending_notifications'] + report['observed_chain_heads']
                        >= max_notifications):
                    report['observation_stopped_by_quota'] = True
                    break
                budget = min(7.0, seconds-(time.monotonic()-t0))
                if budget <= 0:
                    break
                try:
                    data = await asyncio.wait_for(ws.recv(), timeout=budget)
                except asyncio.TimeoutError:
                    continue
                try:
                    handle_rpc_message(report, data)
                except (ValueError, TypeError, UnicodeError) as exc:
                    report['subscription_or_rpc_errors'].append(
                        {'kind': 'INVALID_WS_FRAME', 'error_type': type(exc).__name__,
                         'excerpt': str(exc)[:160]})
                    premature = True
                    break
            # Explicit close of the bounded read-only subscription transport.
    except Exception as exc:
        report['subscription_or_rpc_errors'].append(
            {'kind': 'WEBSOCKET_TRANSPORT', 'error_type': type(exc).__name__,
             'excerpt': str(exc).split('https://')[0][:150]})
        premature = True
    report['elapsed_seconds'] = round(time.monotonic()-t0, 3)
    return conclude(report, transport_closed=premature)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=70)
    parser.add_argument('--max-notifications', type=int, default=20_000)
    args = parser.parse_args()
    need(args.out.parent.is_dir() and not args.out.exists(), 'append-only destination required')
    result = asyncio.run(observe(args.seconds, args.max_notifications))
    with args.out.open('xb') as f:
        f.write(canon(result))
    print(result['status'], 'seconds', result['elapsed_seconds'],
          'pending', result['pending_notifications'],
          'full_tx', result['pending_full_tx_objects_valid'],
          'heads', result['observed_chain_heads'],
          'candidates', result['candidate_count_total'])
    return 0  # Valid negative/unsupported evidence is not a signal/capture PASS.


if __name__ == '__main__':
    raise SystemExit(main())
