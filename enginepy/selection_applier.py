from __future__ import annotations

from typing import Any, Dict


def apply_to_code(selection: Any) -> Dict[str, Any]:
    """Return a code payload for the selected option.

    This is a lightweight placeholder so workflows can progress without
    a full code-selection engine.
    """
    return {"code": selection}
