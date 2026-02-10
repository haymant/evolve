from __future__ import annotations

import time
from typing import Any, Dict, Optional

from . import runtime_runner


_RUNS: Dict[str, Dict[str, Any]] = {}


def run_in_venv(code: Any, options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Run code artifacts and return a run identifier.

    Options are forwarded to the underlying runner. Recognized options include:
    - preserve_tmp: bool -> keep the temporary run directory and return its path as `tmp_dir` in the result.
    - allowlist / timeout_sec etc. passed through.
    """
    if not isinstance(code, dict):
        result = {
            "run_id": None,
            "exit_code": 2,
            "stdout": "",
            "stderr": "invalid code payload",
            "code": code,
            "start_time": None,
            "end_time": None,
        }
        return result
    artifact = {
        "entrypoint": code.get("entry") or code.get("entrypoint"),
        "files": code.get("files", {}),
        "requirements": code.get("requirements", []),
    }
    result = runtime_runner.run_in_venv(artifact, options)
    if not result.get("run_id"):
        result["run_id"] = f"run-{int(time.time() * 1000)}"
    result["code"] = code
    _RUNS[str(result["run_id"])] = result
    return result


def get_run(run_id: str) -> Optional[Dict[str, Any]]:
    return _RUNS.get(run_id)
