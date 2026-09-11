from __future__ import annotations

from typing import Dict, Tuple

from .mass_lot_manifest import SOURCE_NAMES, _family_for, _slug

# Exact fusion contract: source M1201-M1400 becomes runtime M201-M400.
TARGET_NUMBERS = tuple(range(201, 401))

RUNTIME_MASS_LOT_SPECS: Dict[str, Tuple[str, str, str, str, str]] = {}
for offset, (target_number, source_name) in enumerate(zip(TARGET_NUMBERS, SOURCE_NAMES)):
    source_number = 1201 + offset
    family, dataset_key = _family_for(source_number)
    target_id = f"M{target_number}"
    source_id = f"M{source_number}"
    RUNTIME_MASS_LOT_SPECS[target_id] = (source_id, source_name, family, dataset_key, _slug(source_name))

RUNTIME_MASS_LOT_TARGET_MODULES = frozenset(RUNTIME_MASS_LOT_SPECS)
RUNTIME_MASS_LOT_SOURCE_MODULES = tuple(spec[0] for spec in RUNTIME_MASS_LOT_SPECS.values())


def runtime_source_to_target_map() -> Dict[str, str]:
    return {source_id: target_id for target_id, (source_id, *_rest) in RUNTIME_MASS_LOT_SPECS.items()}
