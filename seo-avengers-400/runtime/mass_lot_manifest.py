from __future__ import annotations

from typing import Dict, Tuple

from ._source_blueprint import FAMILIES, SOURCE_NAMES, SOURCE_SPEC_RANGE, SOURCE_SPEC_SHA256, _family_for, _slug

# The supplied blueprint keeps its source identities M1201-M1400. The active
# 400-suite mapping is exactly sequential M201-M400.
TARGET_NUMBERS = tuple(range(201, 401))
MASS_LOT_SPECS: Dict[str, Tuple[str, str, str, str, str]] = {}
for offset, (target_number, source_name) in enumerate(zip(TARGET_NUMBERS, SOURCE_NAMES)):
    source_number = 1201 + offset
    family, dataset_key = _family_for(source_number)
    MASS_LOT_SPECS[f"M{target_number}"] = (f"M{source_number}", source_name, family, dataset_key, _slug(source_name))

MASS_LOT_TARGET_MODULES = frozenset(MASS_LOT_SPECS)
MASS_LOT_SOURCE_MODULES = tuple(spec[0] for spec in MASS_LOT_SPECS.values())


def source_to_target_map() -> Dict[str, str]:
    return {source_id: target_id for target_id, (source_id, *_rest) in MASS_LOT_SPECS.items()}

__all__ = [
    "FAMILIES", "SOURCE_NAMES", "SOURCE_SPEC_RANGE", "SOURCE_SPEC_SHA256", "TARGET_NUMBERS",
    "MASS_LOT_SPECS", "MASS_LOT_TARGET_MODULES", "MASS_LOT_SOURCE_MODULES",
    "source_to_target_map", "_family_for", "_slug",
]
