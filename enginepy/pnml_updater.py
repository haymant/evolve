from __future__ import annotations

from typing import Any, Dict


def apply(pnml_text: str, evaluation: Dict[str, Any]) -> str:
    """Apply evaluation recommendations to PNML.

    This minimal implementation flips async to sync when suggested.
    """
    action = evaluation.get("action")
    if action != "suggest_update":
        return pnml_text
    return pnml_text.replace("execMode: async", "execMode: sync")
