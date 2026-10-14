#!/usr/bin/env python3
"""Offline stress envelope for the exact PR698 historical route artifact.

NO execution, network, signatures, wallet, real P&L, or calibrated win rate.
A hypothetical positive residual MUST NOT be promoted to net EV or a trade.
"""
from __future__ import annotations

import argparse
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
import re
import zipfile


EXPECTED_ARTIFACT_SHA256 = '6778f8e190d13c739331f731ca532d8607e3f653ca000de746b058b4903c7d7d'
EXPECTED_PRODUCER_SHA = '156e106c2efcd8bcb7f4931be3daa98309bd770b'
EXPECTED_PARENT_ARTIFACT = '1c5837ad97607fda9cb60c4888a77648645c48326a93a67adcb9f121e52d7fb8'
EXPECTED_ATTRIBUTION_ARTIFACT = '819106f72a95eb1b894161fc3447d856fbe18c6e6f7d0dc0c5d3648e5b36a6f5'
EXPECTED_CASES = {
    'WETH_COLLATERAL_USDC_DEBT': {'surplus': 2_273_989_378, 'call_gas': 1_115_038},
    'WETH_COLLATERAL_USDT_DEBT': {'surplus': 150_882_941, 'call_gas': 948_267},
}
# Entire-gas, priority, FX, builder, failed-attempt and sponsor numbers below are
# openly synthetic *stress inputs* (not on-chain, commitments, or predictions).
TOTAL_GAS_UNITS = (1_250_000, 1_750_000, 2_500_000)
PRIORITY_GWEI = (1, 5, 25)
ETH_USD_CENTS = (200_000, 300_000, 400_000)
BUILDER_USD_MICROS = (0, 100_000_000)
FAILED_BID_USD_MICROS = (0, 100_000_000)
SPONSOR_FEE_USD_MICROS = (0, 100_000_000)
USD_MICROS = 1_000_000
ETH_WEI = 10**18
GWEI = 10**9


class Rejected(ValueError):
    pass


def need(ok: bool, why: str) -> None:
    if not ok:
        raise Rejected(why)


def strict_json(raw: bytes):
    def pairs(items):
        obj = {}
        for k, v in items:
            need(k not in obj, 'duplicate JSON key: ' + k)
            obj[k] = v
        return obj
    def reject_constant(value):
        raise Rejected('nonfinite JSON number: ' + value)
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=reject_constant)


def integer(v, what: str, minimum=0) -> int:
    need(type(v) is int and v >= minimum, what + ' must be nonnegative integer')
    return v


def safe_name(name: str) -> str:
    need(type(name) is str and len(name) <= 250, 'unsafe archive member name')
    p = PurePosixPath(name)
    need(not p.is_absolute() and name == str(p) and '..' not in p.parts
         and '\\' not in name and not name.startswith('./'), 'unsafe archive path')
    return name


def authenticate_archive(body: bytes):
    need(type(body) is bytes and len(body) <= 120_000_000, 'invalid producer archive type/size')
    need(sha256(body).hexdigest() == EXPECTED_ARTIFACT_SHA256, 'producer ZIP digest mismatch')
    with zipfile.ZipFile(BytesIO(body)) as z:
        fs = {safe_name(i.filename): i for i in z.infolist() if not i.is_dir()}
        need(len(fs) == sum(not i.is_dir() for i in z.infolist()), 'duplicate archive entry')
        need(len(fs) <= 500 and sum(i.file_size for i in fs.values()) <= 300_000_000,
             'archive resources exceeded')
        need(all(i.file_size <= 45_000_000 for i in fs.values()), 'archive member too large')
        need('manifest.sha256' in fs, 'archive manifest absent')
        manifest = z.read('manifest.sha256').decode('utf-8')
        declared = {}
        for line in manifest.splitlines():
            m = re.fullmatch(r'([0-9a-f]{64})  \./([a-zA-Z0-9._/\-]+)', line)
            need(m is not None, 'malformed sha256sum manifest')
            name = safe_name(m[2])
            need(name not in declared and name != 'manifest.sha256', 'duplicated/self-reference manifest')
            declared[name] = m[1]
        need(set(declared) == set(fs) - {'manifest.sha256'}, 'manifest omissions or extras')
        for name, digest in declared.items():
            need(sha256(z.read(name)).hexdigest() == digest, 'manifest digest mismatch: ' + name)
        head = z.read('code-commit.txt').decode('ascii').strip()
        tree = z.read('code-tree.txt').decode('ascii').strip()
        need(head == EXPECTED_PRODUCER_SHA, 'producer commit mismatch')
        need(re.fullmatch(r'[0-9a-f]{40}', tree) is not None, 'missing producer tree identity')
        report = strict_json(z.read('attempt/funded-route.json'))
        return report, {'zip_sha256': EXPECTED_ARTIFACT_SHA256, 'commit': head,
                        'tree': tree, 'manifest_files_verified': len(declared)}


def authenticated_cases(report: dict) -> list[dict]:
    need(type(report) is dict and report.get('status') ==
         'TWO_ENDPOINT_HISTORICAL_ROUTE_SURPLUS_BEFORE_NATIVE_COSTS', 'route producer not passed')
    need(report.get('source_zip_sha256') == EXPECTED_PARENT_ARTIFACT, 'parent archive drift')
    need(report.get('attribution_zip_sha256') == EXPECTED_ATTRIBUTION_ARTIFACT, 'attribution archive drift')
    need(report.get('attribution_producer_full_ci_passed') is False,
         'historical partial predecessor CI promoted')
    need(report.get('historical_selection_uses_future_winner') is True,
         'historical selection bias omitted')
    for field in ('native_gas_payment_modeled', 'gas_metric_is_receipt_gas_used',
                  'nqc_net_margin_proven', 'prospective_detection_proven',
                  'external_nonrecourse_gas_funding_proven', 'P2_shadow_certified',
                  'RMC_closed', 'commercial_score_upgrade', 'canary_live_authorized'):
        need(report.get(field) is False, 'claim drift: ' + field)
    need(report.get('nqc_realized_pnl_usd') == '0', 'P&L drift')
    need(report.get('errors') == [], 'producer has unresolved errors')
    cases = report.get('cases')
    need(type(cases) is list and len(cases) == 2, 'case cardinality drift')
    need({c.get('label') for c in cases if type(c) is dict} == set(EXPECTED_CASES),
         'case labels drift')
    result = []
    for c in sorted(cases, key=lambda x: x['label']):
        need(c.get('two_endpoint_parity') is True, 'missing two-URL parity')
        metrics = c.get('provider_metrics')
        need(type(metrics) is dict and set(metrics) == {'drpc', 'blast'} and
             metrics['drpc'] == metrics['blast'], 'route metric parity drift')
        m = metrics['drpc']
        need(type(m) is dict, 'missing exact fork metrics')
        surplus = integer(m.get('NQC_SURPLUS'), 'surplus', 1)
        call_gas = integer(m.get('NQC_EXECUTE_CALL_GAS'), 'gross call gas', 1)
        base_fee = integer(m.get('NQC_BASE_FEE_WEI'), 'historical block base fee', 1)
        principal = integer(m.get('NQC_PRINCIPAL'), 'principal', 1)
        fee = integer(m.get('NQC_FLASH_FEE'), 'flash fee', 1)
        output = integer(m.get('NQC_SWAP_OUTPUT'), 'swap output', 1)
        need(m.get('NQC_PRODUCTION_GAS_SPONSORED') == 0, 'invented sponsor')
        need(m.get('NQC_PROFIT_FLOOR_ROLLBACK') == 1, 'rollback unverified')
        need(output == principal + fee + surplus, 'amounts fail repayment identity')
        need(fee == (principal * 5 + 9999) // 10000, 'flash fee rounding drift')
        need(surplus == EXPECTED_CASES[c['label']]['surplus'] and
             call_gas == EXPECTED_CASES[c['label']]['call_gas'], 'source numerical witness drift')
        need(call_gas < min(TOTAL_GAS_UNITS), 'stress gas scenario below gross observed call gas')
        result.append({'label': c['label'], 'surplus_asset_micros': surplus,
                       'gross_call_gas_not_receipt_gas': call_gas,
                       'block_base_fee_wei': base_fee})
    return result


def ceildiv(a: int, b: int) -> int:
    need(a >= 0 and b > 0, 'invalid division')
    return (a + b - 1) // b


def scenario(asset_surplus_micros: int, gas_units: int, effective_fee_wei: int,
             eth_usd_cents: int, builder_micros: int, failed_micros: int,
             sponsor_micros: int) -> dict:
    for key, v in locals().copy().items():
        integer(v, key, 1 if key in ('gas_units', 'effective_fee_wei', 'eth_usd_cents') else 0)
    # USDC and USDT are hypothetically treated as USD 1; NOT a sourced peg or FX conversion.
    gas_usd_micros = ceildiv(gas_units * effective_fee_wei * eth_usd_cents * USD_MICROS,
                             ETH_WEI * 100)
    other_usd_micros = builder_micros + failed_micros + sponsor_micros
    residual_micros = asset_surplus_micros - gas_usd_micros - other_usd_micros
    remaining_for_gas = max(0, asset_surplus_micros - other_usd_micros)
    break_even_wei = (remaining_for_gas * ETH_WEI * 100 //
                      (gas_units * eth_usd_cents * USD_MICROS))
    return {'gas_units_assumed': gas_units, 'effective_gas_price_wei_assumed': effective_fee_wei,
            'eth_usd_cents_assumed': eth_usd_cents, 'builder_usd_micros_assumed': builder_micros,
            'failed_attempt_usd_micros_assumed': failed_micros,
            'sponsor_fee_usd_micros_assumed': sponsor_micros,
            'gas_usd_micros_assumed': gas_usd_micros,
            'residual_asset_micros_hypothetical_not_net_pnl': residual_micros,
            'break_even_effective_gas_price_wei_assumed': break_even_wei,
            'positive_residual_under_assumptions_only': residual_micros > 0}


def build(report: dict, provenance: dict) -> dict:
    cases = authenticated_cases(report)
    result = []
    for c in cases:
        rows = []
        for gas in TOTAL_GAS_UNITS:
            for tip in PRIORITY_GWEI:
                for fx in ETH_USD_CENTS:
                    for builder in BUILDER_USD_MICROS:
                        for failed in FAILED_BID_USD_MICROS:
                            for sponsor_fee in SPONSOR_FEE_USD_MICROS:
                                rows.append(scenario(c['surplus_asset_micros'], gas,
                                    c['block_base_fee_wei'] + tip * GWEI, fx,
                                    builder, failed, sponsor_fee))
        remaining = [row['residual_asset_micros_hypothetical_not_net_pnl'] for row in rows]
        result.append({**c, 'scenarios_count': len(rows),
                       'positive_sensitivity_scenarios': sum(v > 0 for v in remaining),
                       'minimum_hypothetical_residual_asset_micros': min(remaining),
                       'maximum_hypothetical_residual_asset_micros': max(remaining),
                       'scenarios': rows})
    return {'schema_version': 1, 'status': 'HISTORICAL_SENSITIVITY_ONLY_NO_NET_OR_CAPTURE_AUTHORITY',
            'source': provenance, 'stress_inputs_are_synthetic': True,
            'eth_usd_quote_authenticated': False, 'stablecoin_one_usd_assumption_authenticated': False,
            'total_transaction_gas_used_authenticated': False,
            'real_builder_payments_authenticated': False,
            'failed_attempt_costs_authenticated': False,
            'sponsor_contract_nonrecourse_authenticated': False,
            'prospective_detection_and_inclusion_authenticated': False,
            'historical_selected_from_winning_transactions': True,
            'nqc_net_pnl_certified': False, 'capital_constraint_own_capital_zero_fulfilled': False,
            'shadow_p2_certified': False, 'canary_authorized': False,
            'RMC_closed': False, 'commercial_upgrade_authorized': False,
            'nqc_realized_pnl_usd': '0', 'cases': result}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source-artifact', required=True, type=Path)
    p.add_argument('--out', required=True, type=Path)
    args = p.parse_args()
    need(args.out.parent.exists() and not args.out.exists(), 'output must be a fresh file')
    report, provenance = authenticate_archive(args.source_artifact.read_bytes())
    out = build(report, provenance)
    args.out.write_text(json.dumps(out, sort_keys=True, separators=(',', ':')) + '\n', encoding='utf8')
    print(out['status'], [(c['label'], c['positive_sensitivity_scenarios'], c['scenarios_count'])
                          for c in out['cases']])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
