from __future__ import annotations

from typing import Any, Dict

IMPLEMENTED_EXTENDED_MODULES = frozenset({
    "M201", "M202", "M203", "M204", "M205", "M206", "M207", "M208",
    "M209", "M210", "M211", "M212", "M213", "M214",
    "M301", "M302", "M303", "M304", "M305", "M306", "M307", "M308", "M309", "M310",
    "M401", "M402", "M403", "M404", "M405", "M406", "M407", "M408",
    "M501", "M502", "M503", "M504", "M505", "M506", "M507", "M508",
    "M601", "M602", "M603", "M604", "M605", "M606",
    "M701", "M702", "M703", "M704", "M705", "M706",
    "M801", "M802", "M803", "M804", "M805", "M806",
    "M901", "M902",
    "M1001", "M1002", "M1003", "M1004", "M1005", "M1006",
    "M1101", "M1102",
})

PRE_GATE_MODULES = tuple(
    sorted(
        (module_id for module_id in IMPLEMENTED_EXTENDED_MODULES if module_id not in {"M1101", "M1102"}),
        key=lambda module_id: int(module_id[1:]),
    )
)


def module_registry() -> Dict[str, Dict[str, Any]]:
    registry: Dict[str, Dict[str, Any]] = {}
    for number in range(1, 1201):
        module_id = f"M{number}"
        if number <= 200:
            status = "DELEGATED_TO_SEO_AVENGERS_200"
        elif module_id in IMPLEMENTED_EXTENDED_MODULES:
            status = "IMPLEMENTED_PRODUCTION"
        else:
            status = "RESERVED"
        registry[module_id] = {
            "module": module_id,
            "status": status,
            "executable_here": module_id in IMPLEMENTED_EXTENDED_MODULES,
        }
    return registry
