from __future__ import annotations

from typing import Tuple

from .pnml_parser import parse_pnml


class PNMLValidationError(ValueError):
    pass


def validate(text: str) -> Tuple[bool, str]:
    try:
        net, _ = parse_pnml(text)
    except Exception as exc:  # pragma: no cover - defensive
        return False, f"parse error: {exc}"
    if not net.places:
        return False, "no places found"
    if not net.transitions:
        return False, "no transitions found"
    return True, "ok"
