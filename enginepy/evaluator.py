from __future__ import annotations

from typing import Any, Dict, List


def evaluate(trace: Any) -> Dict[str, Any]:
    """Evaluate a trace and return workflow metadata.

    This placeholder preserves the expected token shape for downstream steps.
    """
    status = "ok"
    if isinstance(trace, dict):
        events = trace.get("events")
        if isinstance(events, list):
            for event in events:
                if isinstance(event, dict) and event.get("exit_code") not in (None, 0):
                    status = "error"
                    break
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
    return {
        "mode": "selection",
        "options": options,
        "workflow": "default",
        "metadata": {"trace": trace, "status": status},
    }
