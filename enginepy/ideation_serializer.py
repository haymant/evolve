from __future__ import annotations

from typing import Any, Dict

from .ideation_spec import validate_ideation


def to_token(ideation: Dict[str, Any]) -> Dict[str, Any]:
    validate_ideation(ideation)
    mode = ideation.get("mode", "ideation")
    return {
        "mode": mode,
        "ideation": ideation,
        "metadata": ideation.get("metadata", {}),
    }


def from_token(token: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(token, dict):
        raise ValueError("token must be a dict")
    ideation = token.get("ideation")
    if not isinstance(ideation, dict):
        raise ValueError("token missing ideation payload")
    return ideation
