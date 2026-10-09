#!/usr/bin/env python3
"""Integer-only gas-budget evaluation; never grants transaction authority."""
from rmc016_winner_net_audit import parse_json, require, uint


def read_scenario(raw: bytes) -> dict:
    scenario = parse_json(raw)
    require(scenario.get('schema_version') == 2, 'unknown operator scenario schema')
    require(scenario.get('scenario_id') == 'OPERATOR_GAS_MXN_2000_20261009',
            'unknown operator scenario')
    require(scenario.get('declared_currency') == 'MXN' and
            'operator_gas_budget_usd_wad' not in scenario,
            'user budget is Mexican pesos, not dollars')
    require(scenario.get('funding_basis') == 'USER_DECLARED_BUDGET_NOT_ONCHAIN_BALANCE',
            'declared budget cannot become verified funds')
    require(uint(scenario.get('operator_gas_budget_mxn_wad'), 'gas budget') == 2000 * 10**18,
            'operator gas allocation differs from user declaration')
    for field in ('operator_principal_budget_mxn_wad', 'operator_collateral_budget_mxn_wad'):
        require(uint(scenario.get(field), field) == 0, 'gas budget cannot fund principal/collateral')
    require(scenario.get('fx_reference') == {
        'source_url': 'https://www.banxico.org.mx/tipcamb/llenarTiposCambioAction.do',
        'determination_date': '2026-10-09',
        'basis': 'BANXICO_FIX_REFERENCE_NOT_EXECUTABLE_QUOTE',
        'mxn_per_usd_wad': '18416300000000000000',
        'conversion_fees_included': False,
        'native_gas_purchase_quote_verified': False,
    }, 'unrecognized or inflated FX reference')
    for field in ('operator_gas_loss_borne_by_operator',
                  'principal_requires_independently_verified_atomic_funding', 'evaluation_only'):
        require(scenario.get(field) is True, 'required scenario boundary: ' + field)
    for field in ('external_gas_sponsor_required_for_this_scenario',
                  'gas_asset_and_balance_verified', 'live_execution_authorized',
                  'historical_zero_own_capital_certificates_reclassified'):
        require(scenario.get(field) is False, 'unsupported scenario authority: ' + field)
    return scenario


def gas_budget_stress(scenario: dict, observed_winner_gas_usd_wad: int) -> dict:
    """Cost sensitivities on a *third-party winner sample*, not NQC attempts."""
    # Revalidate even callers that construct a dict directly.
    from rmc016_winner_net_audit import canonical
    scenario = read_scenario(canonical(scenario))
    require(type(observed_winner_gas_usd_wad) is int and observed_winner_gas_usd_wad > 0,
            'positive integer observed gas required')
    budget = int(scenario['operator_gas_budget_mxn_wad'])
    rate = int(scenario['fx_reference']['mxn_per_usd_wad'])
    wad = 10**18
    cases = []
    for multiplier in (1, 2, 4):
        for failures in (0, 1, 3):
            cost = observed_winner_gas_usd_wad * multiplier * (1 + failures)
            # Round converted costs up and equivalent USD budget down.
            cost_mxn = (cost * rate + wad - 1) // wad
            cases.append({
                'gas_cost_multiplier': multiplier,
                'assumed_equal_cost_failed_attempts_per_winner': failures,
                'modeled_gas_spend_usd_wad': str(cost),
                'modeled_gas_spend_at_reference_fx_mxn_wad': str(cost_mxn),
                'budget_balance_after_modeled_gas_at_reference_fx_mxn_wad': str(budget - cost_mxn),
                'within_declared_mxn_budget_at_reference_fx': cost_mxn <= budget,
            })
    return {
        'scenario_id': scenario['scenario_id'],
        'basis': 'THIRD_PARTY_HISTORICAL_WINNER_GAS_SENSITIVITY_ONLY',
        'declared_currency': 'MXN',
        'operator_gas_budget_mxn_wad': str(budget),
        'reference_equivalent_budget_usd_wad': str(budget * wad // rate),
        'fx_reference': scenario['fx_reference'],
        'fx_and_onramp_fees_measured': False,
        'failed_attempt_cost_basis': 'EXPLICIT_ASSUMPTION_EQUAL_TO_WINNER_GAS_NOT_MEASURED',
        'native_asset_prefunding_sufficient_proven': False,
        'nqc_gas_limit_and_max_fee_reserve_measured': False,
        'nqc_capture_or_profitability_proven': False,
        'principal_or_collateral_funded_by_gas_budget': False,
        'cases': cases,
    }
