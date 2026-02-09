from __future__ import annotations

from typing import Any, Dict, List, Optional


def collect(
    run_result: Dict[str, Any],
    transition_id: Optional[str] = None,
    inputs: Optional[Dict[str, Any]] = None,
    outputs: Optional[Dict[str, Any]] = None,
    error_class: Optional[str] = None,
) -> Dict[str, Any]:
    """Normalize runtime output into a RunTrace record."""
    start = run_result.get("start_time")
    end = run_result.get("end_time")
    entry = {
        "transitionId": transition_id,
        "stdout": run_result.get("stdout"),
        "stderr": run_result.get("stderr"),
        "start": start,
        "end": end,
        "success": run_result.get("exit_code", 1) == 0,
        "error_type": error_class,
        "inputs": inputs or {},
        "outputs": outputs or {},
    }
    return {
        "run_id": run_result.get("run_id"),
        "transition_results": [entry],
        "start_time": start,
        "end_time": end,
        "metadata": {},
    }
