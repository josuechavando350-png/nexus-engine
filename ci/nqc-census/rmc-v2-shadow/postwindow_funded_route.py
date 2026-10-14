#!/usr/bin/env python3
"""Bounded historical Aave+Uniswap route; evidence only, never broadcasts."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import zipfile

import postwindow_intrablock_attribution as attribution

need = attribution.need
write = attribution.write
ATTRIBUTION_SHA = '819106f72a95eb1b894161fc3447d856fbe18c6e6f7d0dc0c5d3648e5b36a6f5'
ATTRIBUTION_HEAD = 'edf9568378b76a2a026383e3c4060ef615955373'
EXECUTOR_SHA = '1eb01ef850e8de52c89ef0825207f0a3086251f713313300a73aede1e450875e'
CONTRACT = 'NqcV2FundedRouteForkTest'
NUMBERS = ('NQC_PRINCIPAL', 'NQC_FLASH_FEE', 'NQC_SOLD_WETH', 'NQC_SWAP_OUTPUT',
           'NQC_SURPLUS', 'NQC_EXECUTE_CALL_GAS', 'NQC_BASE_FEE_WEI',
           'NQC_PRODUCTION_GAS_SPONSORED', 'NQC_PROFIT_FLOOR_ROLLBACK')


def authenticate(source_body, attribution_body):
    cases = attribution.authenticate(source_body)
    need(type(attribution_body) is bytes and len(attribution_body) < 10_000_000, 'invalid attribution size/type')
    need(sha256(attribution_body).hexdigest() == ATTRIBUTION_SHA, 'attribution digest mismatch')
    with zipfile.ZipFile(BytesIO(attribution_body)) as z:
        need(len(z.namelist()) == len(set(z.namelist())), 'duplicate attribution members')
        def read(name):
            need(z.getinfo(name).file_size < 8_000_000, 'oversize attribution member')
            return z.read(name)
        need(read('code-commit.txt').decode().strip() == ATTRIBUTION_HEAD, 'attribution head drift')
        report = attribution.pre.receipts.source.strict_json(read('attempt/attribution.json'))
        # This producer FAILED its full two-endpoint gate. Bind only the exact
        # successful dRPC logs; never inherit a green CI or two-endpoint status.
        need(report['status'] == 'INCOMPLETE_NO_ATTRIBUTION' and len(report['errors']) == 2,
             'partial producer status drift')
        need(len(report['cases']) == len(cases) == 2, 'case count drift')
        for case, row in zip(cases, report['cases']):
            w = case['witness']
            need(row['label'] == w['label'] and row['two_endpoint_parity'] is False, 'source row drift')
            log = read('attempt/' + w['label'].lower() + '-drpc/forge.log').decode()
            metrics = attribution.parse_metrics(log, w['winner_transaction_index'])
            need(row['provider_metrics'] == {'drpc': metrics}, 'source metrics/log mismatch')
            need(metrics['NQC_REFERENCE_PRESTATE_HF'] < 10**18, 'source borrower not liquidatable')
            case['prestate_abi'] = metrics['reference_prestate_abi']
    return cases


def parse_metrics(output, case):
    need('2 passed; 0 failed; 0 skipped' in output, 'expected two passing fork tests')
    for name in ('testHistoricalAtomicRouteSurplus', 'testImpossibleProfitRollsBackEntireRoute'):
        need('[PASS] ' + name + '()' in output, 'missing required fork test')
    found = re.findall(r'^\s+(NQC_[A-Z_]+): (\d+)(?: \[[^\n]*\])?\s*$', output, re.M)
    need(len(found) == len(NUMBERS) and {k for k, _ in found} == set(NUMBERS), 'metric set/duplicates')
    m = {k: int(v) for k, v in found}
    event = case['event']
    need(m['NQC_PRINCIPAL'] == int(event['debt_raw']) and
         m['NQC_SOLD_WETH'] == int(event['collateral_raw']), 'historical size drift')
    need(m['NQC_FLASH_FEE'] == (m['NQC_PRINCIPAL'] * 5 + 5000) // 10000, 'fee mismatch')
    need(m['NQC_SURPLUS'] > 0 and m['NQC_SWAP_OUTPUT'] ==
         m['NQC_PRINCIPAL'] + m['NQC_FLASH_FEE'] + m['NQC_SURPLUS'], 'economic identity mismatch')
    need(100_000 < m['NQC_EXECUTE_CALL_GAS'] < 3_000_000, 'implausible call gas')
    need(m['NQC_PRODUCTION_GAS_SPONSORED'] == 0 and m['NQC_PROFIT_FLOOR_ROLLBACK'] == 1,
         'sponsor promotion or rollback missing')
    for name, size in (('NQC_SWAP_POOL', 40), ('NQC_ROUTER_CODEHASH', 64), ('NQC_SWAP_POOL_CODEHASH', 64)):
        matches = re.findall(r'^\s+' + name + r': (0x[0-9a-fA-F]{' + str(size) + r'})\s*$', output, re.M)
        need(len(matches) == 1 and int(matches[0], 16) != 0, 'missing/duplicate route identity')
        m[name] = matches[0].lower()
    return m


def run_fork(case, provider, root, forge):
    w, event = case['witness'], case['event']
    folder = root / (w['label'].lower() + '-' + provider)
    folder.mkdir()
    (folder/'src').mkdir(); (folder/'test').mkdir()
    ci = Path(__file__).resolve().parents[2]
    source = ci/'nqc-census/weth-physical'
    coordinator = ci/'nqc-t36/contracts/src/NqcFlashFundingExecutor.sol'
    need(sha256(coordinator.read_bytes()).hexdigest() == EXECUTOR_SHA, 'immutable coordinator drift')
    shutil.copy(coordinator, folder/'src/')
    shutil.copy(source/'test/NqcV2FundedRouteFork.t.sol', folder/'test/')
    shutil.copy(source/'foundry-time-only.toml', folder/'foundry.toml')
    values = {'NQC_RPC_URL': attribution.pre.receipts.PROVIDERS[provider][1],
              'NQC_BORROWER': w['borrower'], 'NQC_DEBT_ASSET': w['debt_asset'],
              'NQC_WINNER_BLOCK': str(w['winner_block']['number']),
              'NQC_WINNER_TIMESTAMP': str(w['winner_block']['timestamp']),
              'NQC_PARENT_HASH': w['predecessor_block']['hash'],
              'NQC_WINNER_TX': w['competitor_tx_hash'], 'NQC_PRESTATE_ABI': case['prestate_abi'],
              'NQC_PRINCIPAL': event['debt_raw'], 'NQC_COLLATERAL': event['collateral_raw']}
    write(folder/'public-inputs.json', values)
    write(folder/'tested-source-sha256.json', {str(p.relative_to(folder)): sha256(p.read_bytes()).hexdigest()
          for p in (folder/'foundry.toml', folder/'src/NqcFlashFundingExecutor.sol',
                    folder/'test/NqcV2FundedRouteFork.t.sol')})
    transcript = []
    try:
        attribution.canonical_check(case, provider, transcript)
        with (folder/'forge.log').open('xb') as log:
            try:
                result = subprocess.run([forge, 'test', '--match-contract', CONTRACT,
                    '--fork-url', values['NQC_RPC_URL'], '--fork-block-number',
                    str(w['predecessor_block']['number']), '--no-storage-caching',
                    '--compute-units-per-second', '20', '--fork-retries', '2',
                    '--fork-retry-backoff', '2000', '--threads', '1', '-vvv'],
                    cwd=folder, env=dict(os.environ, **values), stdout=log,
                    stderr=subprocess.STDOUT, timeout=900, check=False)
            except subprocess.TimeoutExpired:
                write(folder/'exit.json', {'returncode': None, 'timeout_seconds': 900})
                raise
        write(folder/'exit.json', {'returncode': result.returncode})
        need(result.returncode == 0, 'forge failed; inspect preserved log')
        metrics = parse_metrics((folder/'forge.log').read_text(), case)
        attribution.canonical_check(case, provider, transcript)
        write(folder/'metrics.json', metrics)
        return metrics
    finally:
        write(folder/'canonical-rpc-transcript.json', transcript)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--source-artifact', required=True, type=Path)
    p.add_argument('--attribution-artifact', required=True, type=Path)
    p.add_argument('--out-dir', required=True, type=Path)
    p.add_argument('--forge', required=True)
    a = p.parse_args()
    need(a.out_dir.is_absolute() and not a.out_dir.exists(), 'fresh absolute output required')
    a.out_dir.mkdir(parents=True)
    summary = {'status': 'INCOMPLETE_HISTORICAL_ROUTE', 'cases': [], 'errors': [],
        'source_zip_sha256': attribution.SOURCE_SHA, 'attribution_zip_sha256': ATTRIBUTION_SHA,
        'attribution_producer_full_ci_passed': False,
        'started_at_utc': datetime.now(timezone.utc).isoformat(),
        'route': 'AaveV3_flashLoanSimple_liquidation_UniswapV3_exactInputSingle_fee500',
        'historical_selection_uses_future_winner': True, 'route_optimization_claimed': False,
        'test_injected_erc20_inventory_raw': '0', 'native_gas_payment_modeled': False,
        'gas_metric_is_receipt_gas_used': False, 'nqc_net_margin_proven': False,
        'prospective_detection_proven': False, 'external_nonrecourse_gas_funding_proven': False,
        'P2_shadow_certified': False, 'RMC_closed': False, 'commercial_score_upgrade': False,
        'canary_live_authorized': False, 'nqc_realized_pnl_usd': '0'}
    try:
        for case in authenticate(a.source_artifact.read_bytes(), a.attribution_artifact.read_bytes()):
            row = {'label': case['witness']['label'], 'provider_metrics': {}, 'two_endpoint_parity': False}
            summary['cases'].append(row)
            for provider in attribution.pre.receipts.PROVIDERS:
                try:
                    row['provider_metrics'][provider] = run_fork(case, provider, a.out_dir, a.forge)
                except Exception as exc:
                    summary['errors'].append({'label': row['label'], 'provider': provider,
                        'error': type(exc).__name__ + ':' + str(exc)[:400]})
            if len(row['provider_metrics']) == 2:
                need(row['provider_metrics']['drpc'] == row['provider_metrics']['blast'], 'endpoint metric mismatch')
                row['two_endpoint_parity'] = True
            write(a.out_dir/'funded-route.json', summary)
        if not summary['errors'] and len(summary['cases']) == 2 and all(x['two_endpoint_parity'] for x in summary['cases']):
            summary['status'] = 'TWO_ENDPOINT_HISTORICAL_ROUTE_SURPLUS_BEFORE_NATIVE_COSTS'
    except Exception as exc:
        summary['errors'].append({'error': type(exc).__name__ + ':' + str(exc)[:400]})
    finally:
        summary['finished_at_utc'] = datetime.now(timezone.utc).isoformat()
        write(a.out_dir/'funded-route.json', summary)
    print(summary['status'])
    return 0 if summary['status'] == 'TWO_ENDPOINT_HISTORICAL_ROUTE_SURPLUS_BEFORE_NATIVE_COSTS' else 2


if __name__ == '__main__':
    raise SystemExit(main())
