from __future__ import annotations

from typing import Any, Dict, List


def collect(run_id: Any) -> Dict[str, Any]:
    """Return a minimal trace payload for a run identifier."""
    events: List[Dict[str, Any]] = []
    try:
        from . import runtime
        run = runtime.get_run(str(run_id)) if run_id is not None else None
        if isinstance(run, dict):
            events.append(
                {
                    "type": "run",
                    "exit_code": run.get("exit_code"),
                    "stdout": run.get("stdout"),
                }
            )
    except Exception:
        pass
    return {"trace": {"run_id": run_id, "events": events}}
