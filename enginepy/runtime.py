from __future__ import annotations

import time
from typing import Any, Dict, Optional


_RUNS: Dict[str, Dict[str, Any]] = {}


def run_in_venv(code: Any) -> Dict[str, Any]:
    """Pretend to run code and return a run identifier."""
    run_id = f"run-{int(time.time() * 1000)}"
    entry = None
    files = None
    if isinstance(code, dict):
        entry = code.get("entry")
        files = code.get("files")
    stdout = "Simulated run"
    if entry:
        stdout += f" for {entry}"
    if isinstance(files, dict) and entry in files:
        first_line = str(files[entry]).splitlines()[0] if files[entry] else ""
        if first_line:
            stdout += f"\n{first_line}"
    result = {
        "run_id": run_id,
        "exit_code": 0,
        "stdout": stdout,
        "code": code,
    }
    _RUNS[run_id] = result
    return result


def get_run(run_id: str) -> Optional[Dict[str, Any]]:
    return _RUNS.get(run_id)
