from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional
import json
import os


@dataclass
class ValidationErrorDetail:
    field: str
    message: str


class IdeationValidationError(ValueError):
    def __init__(self, errors: List[ValidationErrorDetail]) -> None:
        super().__init__("IdeationSpec validation failed")
        self.errors = errors


def _schema_path() -> str:
    root = os.path.dirname(os.path.dirname(__file__))
    return os.path.join(root, "schema", "ideation.spec.json")


def load_schema() -> Dict[str, Any]:
    path = _schema_path()
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def validate_ideation(ideation: Dict[str, Any]) -> None:
    errors: List[ValidationErrorDetail] = []
    if not isinstance(ideation, dict):
        raise IdeationValidationError([ValidationErrorDetail(field="root", message="ideation must be an object")])

    schema = load_schema()
    required = schema.get("required", [])
    for key in required:
        if key not in ideation or ideation.get(key) in (None, ""):
            errors.append(ValidationErrorDetail(field=key, message="required field missing"))

    mode = ideation.get("mode")
    if mode is not None and mode not in {"ideation", "selection", "exit"}:
        errors.append(ValidationErrorDetail(field="mode", message="invalid mode value"))

    for list_key in ("constraints", "kpis", "data_sources", "tooling_limits"):
        value = ideation.get(list_key)
        if value is None:
            continue
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            errors.append(ValidationErrorDetail(field=list_key, message="must be an array of strings"))

    metadata = ideation.get("metadata")
    if metadata is not None and not isinstance(metadata, dict):
        errors.append(ValidationErrorDetail(field="metadata", message="must be an object"))

    if errors:
        raise IdeationValidationError(errors)


def summarize_errors(error: IdeationValidationError) -> str:
    return "; ".join(f"{e.field}: {e.message}" for e in error.errors)
