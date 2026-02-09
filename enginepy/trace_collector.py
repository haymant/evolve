from __future__ import annotations

from typing import Any, Dict


def collect(run_id: Any) -> Dict[str, Any]:
    """Return a normalized trace payload for a run identifier."""
    try:
        from . import runtime
        from .trace import collector
        run = runtime.get_run(str(run_id)) if run_id is not None else None
        if isinstance(run, dict):
            trace = collector.collect(run, transition_id=None)
            return {"trace": trace}
    except Exception:
        pass
    return {"trace": {"run_id": run_id, "transition_results": []}}
