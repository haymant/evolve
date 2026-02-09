from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional


DEFAULT_TIMEOUT_SEC = 10
DEFAULT_ALLOWLIST: List[str] = []


def _validate_requirements(requirements: List[str], allowlist: List[str]) -> Optional[str]:
    for req in requirements:
        if req in allowlist:
            continue
        return req
    return None


def run_in_venv(code_artifact: Dict[str, Any], options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Execute a code artifact and capture stdout/stderr.

    This implementation runs with the current interpreter and temp files.
    """
    opts = options or {}
    timeout = float(opts.get("timeout_sec", DEFAULT_TIMEOUT_SEC))
    allowlist = list(opts.get("allowlist", DEFAULT_ALLOWLIST))

    entrypoint = code_artifact.get("entrypoint")
    files = code_artifact.get("files")
    requirements = code_artifact.get("requirements") or []

    if not entrypoint or not isinstance(files, dict):
        return {
            "run_id": None,
            "stdout": "",
            "stderr": "invalid code artifact",
            "exit_code": 2,
            "start_time": None,
            "end_time": None,
        }

    blocked = _validate_requirements(list(requirements), allowlist)
    if blocked:
        return {
            "run_id": None,
            "stdout": "",
            "stderr": f"blocked dependency: {blocked}",
            "exit_code": 3,
            "start_time": None,
            "end_time": None,
        }

    start = time.time()
    run_id = f"run-{int(start * 1000)}"

    with tempfile.TemporaryDirectory(prefix="evolve_run_") as tmp:
        for rel_path, content in files.items():
            abs_path = os.path.join(tmp, rel_path)
            os.makedirs(os.path.dirname(abs_path), exist_ok=True)
            with open(abs_path, "w", encoding="utf-8") as f:
                f.write(str(content))
        entry_path = os.path.join(tmp, entrypoint)
        try:
            completed = subprocess.run(
                [sys.executable, entry_path],
                cwd=tmp,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
            end = time.time()
            return {
                "run_id": run_id,
                "stdout": completed.stdout,
                "stderr": completed.stderr,
                "exit_code": completed.returncode,
                "start_time": start,
                "end_time": end,
            }
        except subprocess.TimeoutExpired:
            end = time.time()
            return {
                "run_id": run_id,
                "stdout": "",
                "stderr": "timeout",
                "exit_code": 124,
                "start_time": start,
                "end_time": end,
            }
