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
    # Include PNML text in the artifact if provided by the code payload so the
    # runner may optionally preserve it alongside run files.
    if isinstance(code, dict) and code.get("pnml"):
        artifact["pnml"] = code.get("pnml")

    # If the generated code includes run metadata with a preserve_dir, forward
    # that into the runner options so preserved runs go under the project tree.
    if isinstance(code, dict):
        run_meta = code.get("run") or {}
        preserve_dir = run_meta.get("preserve_dir")
        if preserve_dir:
            opts = dict(options or {})
            if "preserve_dir" not in opts:
                opts["preserve_dir"] = preserve_dir
            options = opts
        # Forward explicit args from the code payload or run metadata.
        if "args" in code:
            artifact["args"] = code.get("args")
        elif "args" in run_meta:
            artifact["args"] = run_meta.get("args")
    result = runtime_runner.run_in_venv(artifact, options)
    if not result.get("run_id"):
        result["run_id"] = f"run-{int(time.time() * 1000)}"
    result["code"] = code
    _RUNS[str(result["run_id"])] = result
    return result


def get_run(run_id: str) -> Optional[Dict[str, Any]]:
    return _RUNS.get(run_id)
