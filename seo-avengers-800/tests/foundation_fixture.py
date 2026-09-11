from __future__ import annotations

from runtime.foundation_specs import FOUNDATION_SPECS


def foundation_row(module_id: str) -> dict:
    spec = FOUNDATION_SPECS[module_id]
    fields = tuple(spec['input_fields'])
    formula = str(spec['formula'])
    row = {'module_id': module_id}

    if formula == 'coverage_count': row.update({fields[0]: 10, fields[1]: 10})
    elif formula == 'defect_rate': row.update({fields[0]: 10, fields[1]: 0})
    elif formula == 'budget': row.update({fields[0]: 5, fields[1]: 10})
    elif formula == 'minimum': row.update({fields[0]: 10, fields[1]: 10})
    elif formula == 'ratio_score': row.update({fields[0]: 10, fields[1]: 10})
    elif formula in {'subset', 'overlap'}: row.update({fields[0]: ['alpha', 'beta'], fields[1]: ['alpha', 'beta']})
    elif formula == 'separation': row.update({fields[0]: ['alpha'], fields[1]: ['beta']})
    elif formula == 'equality': row.update({fields[0]: 'sha256:stable', fields[1]: 'sha256:stable'})
    elif formula in {'ppm_mean', 'ppm_min'}: row.update({fields[0]: [1_000_000, 1_000_000]})
    elif formula == 'ppm_pair_mean': row.update({fields[0]: 1_000_000, fields[1]: 1_000_000})
    elif formula == 'inverse_balance': row.update({fields[0]: 10, fields[1]: 10})
    elif formula == 'delta_ppm': row.update({fields[0]: 500_000, fields[1]: 500_000, fields[2]: 0})
    elif formula == 'delta_int': row.update({fields[0]: 10, fields[1]: 10, fields[2]: 0})
    else: raise AssertionError(f'unsupported fixture formula:{formula}')
    return row
