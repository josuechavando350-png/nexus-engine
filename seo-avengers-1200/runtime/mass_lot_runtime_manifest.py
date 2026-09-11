from __future__ import annotations

from typing import Dict, Tuple

from .mass_lot_manifest import FAMILIES, SOURCE_NAMES, SOURCE_SPEC_RANGE, SOURCE_SPEC_SHA256, _family_for, _slug

# Runtime IDs deliberately preserve the two historical post-batch sentinel slots
# M215 and M317 as RESERVED because existing audited batches use them as their
# next-slot non-execution proof. The 200 new algorithms occupy other free slots.
TARGET_NUMBERS = tuple(range(216, 301)) + tuple(range(318, 401)) + tuple(range(409, 441))

RUNTIME_MASS_LOT_SPECS: Dict[str, Tuple[str, str, str, str, str]] = {}
for offset, (target_number, source_name) in enumerate(zip(TARGET_NUMBERS, SOURCE_NAMES)):
    source_number = 1201 + offset
    family, dataset_key = _family_for(source_number)
    target_id = f"M{target_number}"
    source_id = f"M{source_number}"
    RUNTIME_MASS_LOT_SPECS[target_id] = (
        source_id,
        source_name,
        family,
        dataset_key,
        _slug(source_name),
    )

RUNTIME_MASS_LOT_TARGET_MODULES = frozenset(RUNTIME_MASS_LOT_SPECS)
RUNTIME_MASS_LOT_SOURCE_MODULES = tuple(spec[0] for spec in RUNTIME_MASS_LOT_SPECS.values())


def runtime_source_to_target_map() -> Dict[str, str]:
    return {
        source_id: target_id
        for target_id, (source_id, *_rest) in RUNTIME_MASS_LOT_SPECS.items()
    }
