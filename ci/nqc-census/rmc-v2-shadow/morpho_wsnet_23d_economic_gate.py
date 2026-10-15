#!/usr/bin/env python3
"""NQC V2: source-locked wsNET/USDG recurring capacity falsification.

Strictly OFFLINE. Does not call RPC, Morpho API, DEX, wallet, or GitHub.
The *single Morpho indexer* does not prove canonical onchain state, exits,
exclusive access, P&L, gas sponsorship, or recurring monthly profit.
"""
import argparse
import hashlib
import json
from collections import defaultdict
from decimal import Decimal, ROUND_DOWN
from pathlib import Path
from zipfile import ZipFile

SOURCE_SHA256 = "f65c2b526fe93d105b096716515b4eac7b98698cb331048d3c6a8cf936b65ce4"
SOURCE_EVENTS_SHA256 = "8deb600b064bee39767f203e22f9cda3fd9ab61d67a2030e5369c5967215ff0e"
MARKET = "0xaa586d26a6fe62d9c0f0948fede6e2130500ac7a655587447e2d4a37e6330589"
CHAIN = 4663
USDG_DECIMALS = 6  # Blockscout chain4663 contract metadata + on-chain source registry; single indexed view.
WSNET_DECIMALS = 18
LLTV = Decimal("0.625")
LIF = Decimal("1.126760563380281690")  # Source-pinned Morpho LLTV-derived incentive.
MICRO = Decimal(10) ** USDG_DECIMALS
HAIRCUT_PCTS = (0, 3, 5, 8, 10, 12)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def dec(raw):
    return format(Decimal(raw) / MICRO, '.6f')


def require(ok, reason):
    if not ok:
        raise ValueError('FAIL_CLOSED_' + reason)


def read_certified_zip(path):
    data = Path(path).read_bytes()
    require(sha(data) == SOURCE_SHA256, 'SOURCE_OUTER_SHA256')
    with ZipFile(path) as z:
        files = set(z.namelist())
        require({'manifest.sha256', 'liquidations.jsonl', 'census.json'} <= files,
                'SOURCE_MISSING_MEMBERS')
        require(sha(z.read('liquidations.jsonl')) == SOURCE_EVENTS_SHA256,
                'SOURCE_EVENTS_SHA256')
        lines = z.read('manifest.sha256').decode('utf-8').splitlines()
        require(len(lines) == 9, 'SOURCE_MEMBER_COUNT')
        checked = set()
        for line in lines:
            digest, name = line.strip().split(maxsplit=1)
            name = name.lstrip('*').removeprefix('./')
            require(name in files and name not in checked and '..' not in name.split('/'),
                    'SOURCE_MANIFEST_PATH')
            require(len(digest) == 64 and sha(z.read(name)) == digest,
                    'SOURCE_MANIFEST_HASH')
            checked.add(name)
        census = json.loads(z.read('census.json'))
        require(census['source'] == 'public_morpho_single_api_indexer_no_independent_rpc_quorum',
                'SOURCE_AUTHORITY')
        require(census['status'] == 'INCOMPLETE_MORPHO_API_WINDOW',
                'FULL_30D_FABRICATION')
        require(census['event_count'] == 2565 and census['unique_winning_transactions'] == 1932,
                'SOURCE_GLOBAL_COUNTS')
        complete = [day for day in census['daily_source_provenance']
                    if day['status'] == 'COMPLETE_MORPHO_API_DAY_INDEX_ONLY']
        require(len(complete) == 23, 'SOURCE_23D_SCOPE')
        for i, day in enumerate(complete):
            require(day['day_index'] == i and day['end']-day['start'] == 86399,
                    'SOURCE_DAY_WINDOW')
            if i:
                require(day['start'] == complete[i-1]['end']+1, 'NONCONTIGUOUS_DAYS')
        events = [json.loads(s) for s in z.read('liquidations.jsonl').decode().splitlines()]
        require(len(events) == 2565, 'EVENT_COUNT')
        ids = set()
        daily_all_count = defaultdict(int)
        for event in events:
            require(event['id'] not in ids, 'DUPLICATE_EVENT')
            ids.add(event['id'])
            require(event['id'] == f"{event['chain_id']}:{event['tx']}:{event['log_index']}",
                    'EVENT_ID_TAMPERED')
            require(event['win_id'] == f"{event['chain_id']}:{event['tx']}",
                    'WIN_ID_TAMPERED')
            for field in ('repaid_raw', 'seized_raw', 'bad_debt_raw'):
                require(str(event[field]).isdigit(), 'NONINTEGER_' + field.upper())
            idx = locate_day(complete, event['timestamp'])
            daily_all_count[idx] += 1
        for idx, day in enumerate(complete):
            require(daily_all_count[idx] == day['event_count'] == day['claimed_indexer_count'],
                    'INDEX_DAY_COMPLETENESS')
    return events, complete


def locate_day(days, ts):
    for i, day in enumerate(days):
        if day['start'] <= ts <= day['end']:
            return i
    raise ValueError('FAIL_CLOSED_UNCERTIFIED_SOURCE_TIME')


def oracle_haircut_profit_micro(events, h):
    """Intentional optimistic oracle-price model, all other costs 0.

    Per-event ROUND_DOWN in original USDG integer base units. This is NOT
    quoted fill; does not include actual seized WSNET/ratio, oracle staleness,
    slippage route, TWAP mismatch, gas, nonincluded attempts or sponsor fees.
    """
    coefficient = LIF * (Decimal(1) - Decimal(h) / 100) - 1
    if coefficient <= 0:
        return 0
    return sum(int((Decimal(e['repaid_raw']) * coefficient).to_integral_value(rounding=ROUND_DOWN))
               for e in events)


def analyze(events, days):
    target = [x for x in events if x['chain_id'] == CHAIN and x['market_id'] == MARKET]
    require(len(target) == 224, 'TARGET_224_EVENTS')
    require(all(x['collateral'] == 'wsNET' and x['loan'] == 'USDG' for x in target),
            'TOKEN_SYMBOL_DISAGREEMENT')
    require(all(int(x['repaid_raw']) > 0 for x in target), 'EMPTY_REPAY')
    require(all(int(x['bad_debt_raw']) == 0 for x in target), 'BAD_DEBT_NONZERO')
    winning_txs = {x['win_id'] for x in target}
    addrs = {x['liquidator'] for x in target}
    require(len(winning_txs) == 164 and len(addrs) == 52, 'TARGET_TX_ADDR_COUNTS')
    win_addr = defaultdict(set)
    for event in target:
        win_addr[event['win_id']].add(event['liquidator'])
    require(all(len(s) == 1 for s in win_addr.values()), 'AMBIGUOUS_TX_LIQUIDATOR')
    address_principal = defaultdict(int)
    daily_principal = defaultdict(int)
    for e in target:
        address_principal[e['liquidator']] += int(e['repaid_raw'])
        daily_principal[locate_day(days, e['timestamp'])] += int(e['repaid_raw'])
    principal = sum(int(e['repaid_raw']) for e in target)
    peak_idx = max(daily_principal, key=lambda k: (daily_principal[k], -k))
    top3 = sorted(address_principal, key=lambda k: (-address_principal[k], k))[:3]
    require(len(daily_principal) == 18, 'SOURCE_WINDOW_RECURRENCE')
    by_segment = {
        'all_market': target,
        'excluding_top_three_historical_addresses': [e for e in target if e['liquidator'] not in top3],
        'excluding_peak_24h_source_window': [e for e in target if locate_day(days,e['timestamp']) != peak_idx],
        'excluding_both_peak_and_top_three': [e for e in target if e['liquidator'] not in top3 and locate_day(days,e['timestamp']) != peak_idx],
    }
    segments = {}
    for label, rows in by_segment.items():
        n = sum(int(e['repaid_raw']) for e in rows)
        sensitivities=[]
        for h in HAIRCUT_PCTS:
            gross = oracle_haircut_profit_micro(rows, h)
            share = gross // 2  # 50/50 illustrative, before ALL other costs
            sensitivities.append({'dex_haircut_percent_assumed':h,
                'gross_oracle_model_margin_usdg_before_costs':dec(gross),
                'nqc_50pct_oracle_model_share_usdg_before_costs':dec(share),
                'exceeds_5000_nominal_not_monthly':share > 5_000_000_000})
        segments[label]={'events':len(rows),
            'distinct_winner_txs':len({e['win_id'] for e in rows}),
            'active_complete_source_24h_windows':len({locate_day(days,e['timestamp']) for e in rows}),
            'source_loan_principal_usdg_not_profit':dec(n),
            'share_of_original_principal_percent':format(Decimal(n)*100/Decimal(principal),'.4f'),
            'model':sensitivities}
    amounts_by_tx=defaultdict(int)
    for e in target:
        amounts_by_tx[e['win_id']]+=int(e['repaid_raw'])
    sorted_amounts=sorted(amounts_by_tx.values())
    result={
        'status':'INDEXED_WSNET_USDG_23D_CONDITIONAL_CAPACITY_NOT_PROFIT',
        'source_original_zip_sha256':SOURCE_SHA256,
        'source_market_id':MARKET,
        'chain_id':CHAIN,
        'authority':'one_Morpho_GraphQL_indexer_23_complete_consecutive_24h_windows_NOT_30D_or_onchain_quorum',
        'source_30d_complete':False,
        'source_window_days_complete':23,
        'observed_active_complete_24h_windows':len(daily_principal),
        'source_market_events':len(target),
        'source_distinct_winning_txs':len(winning_txs),
        'source_distinct_liquidator_addresses':len(addrs),
        'source_total_repaid_nominal_usdg_not_profit':dec(principal),
        'source_total_seized_nominal_wsnet_not_quoted':format(Decimal(sum(int(e['seized_raw']) for e in target))/Decimal(10)**WSNET_DECIMALS,'.18f'),
        'source_median_winner_loan_repay_usdg':dec((sorted_amounts[81]+sorted_amounts[82])//2),
        'source_winning_txs_under_1000_usdg':sum(x<1_000_000_000 for x in sorted_amounts),
        'source_winning_txs_above_or_equal_10000_usdg':sum(x>=10_000_000_000 for x in sorted_amounts),
        'source_largest_winner_repay_usdg':dec(sorted_amounts[-1]),
        'source_top_three_address_ids':top3,
        'source_top_three_principal_percent':format(Decimal(sum(address_principal[a] for a in top3))*100/Decimal(principal),'.4f'),
        'source_peak_24h_window_index':peak_idx,
        'source_peak_24h_start_timestamp':days[peak_idx]['start'],
        'source_peak_24h_repay_usdg':dec(daily_principal[peak_idx]),
        'source_peak_24h_repay_percent':format(Decimal(daily_principal[peak_idx])*100/Decimal(principal),'.4f'),
        'segments':segments,
        'token_identity':{
            'loan_token_address':'0x5fc5360d0400a0fd4f2af552add042d716f1d168',
            'loan_symbol':'USDG','loan_decimals':6,
            'collateral_token_address':'0x63c12667638f2ae6fc6ae09b43d98ec84a8586ea',
            'collateral_symbol':'wsNET','collateral_decimals':18,
            'identity_source':'Blockscout contract metadata chain4663; independent of Morpho indexer, NOT two same-block RPC'},
        'oracle_information':{
            'contract':'0xcde9599059f8ae6d6b9f33a0af7877827ec75f16',
            'source_verified_contract_name':'LoopbackOracle',
            'source_verified_rule':'clamp(TWAP*(1-10%), floor, 5*floor)*sNET.index',
            'source_spot_TWAP_lower_divergence_guard_pct':15,
            'same_block_oracle_state_proven':False},
        'external_gas_sponsor_proven':False,
        'same_block_executable_quote_proven':False,
        'prospective_first_seen_proven':False,
        'competitor_capture_probability_proven':False,
        'nqc_realized_pnl_usd':'0',
        'own_capital_usd':'0',
        'commercial_gate':'INCOMPLETE_NO_SAME_BLOCK_COLLATERAL_TO_USDG_QUOTE_OR_SPONSOR',
        'NONCLAIMS':'No financial forecast; no price model equal to an executed swap; no 30-day extension; no NQC gain; no gas financing.'
    }
    require(result['source_total_repaid_nominal_usdg_not_profit']=='526735.979790', 'TARGET_AMOUNT_INTEGRITY')
    return result


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--source-zip',required=True)
    ap.add_argument('--output',required=True)
    args=ap.parse_args()
    events, days=read_certified_zip(args.source_zip)
    result=analyze(events,days)
    Path(args.output).write_text(json.dumps(result,indent=2,sort_keys=True)+'\n')
    print(result['status'])
    print('indexed nominal repaid USDG',result['source_total_repaid_nominal_usdg_not_profit'])
    print('NQC P&L USD',result['nqc_realized_pnl_usd'])

if __name__=='__main__':
    main()
