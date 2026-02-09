from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional


@dataclass
class EvaluationResult:
    action: str
    ideation_spec: Optional[Dict[str, Any]] = None
    reasons: Optional[List[str]] = None


class Evaluator:
    def evaluate(self, trace: Dict[str, Any]) -> EvaluationResult:
        return EvaluationResult(action="no_update", reasons=["default evaluator"])
