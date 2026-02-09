from __future__ import annotations

from typing import Any, Dict, List

from .evaluator_interface import EvaluationResult, Evaluator


def evaluate(trace: Any) -> Dict[str, Any]:
    """Evaluate a trace and return workflow metadata.

    This placeholder preserves the expected token shape for downstream steps.
    """
    evaluator = Evaluator()
    result = evaluator.evaluate(trace if isinstance(trace, dict) else {"trace": trace})
    options: List[Dict[str, str]] = [
        {
            "id": "keep",
            "label": "Keep current flow",
            "description": "Continue with the generated workflow",
        },
        {
            "id": "refine",
            "label": "Refine requirements",
            "description": "Adjust constraints or KPIs and regenerate",
        },
        {
            "id": "exit",
            "label": "Exit",
            "description": "Stop the workflow",
        },
    ]
    payload: Dict[str, Any] = {
        "action": result.action,
        "ideation_spec": result.ideation_spec,
        "reasons": result.reasons or [],
        "mode": "selection",
        "options": options,
        "metadata": {"trace": trace},
    }
    return payload
