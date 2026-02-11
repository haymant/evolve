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
    args = code_artifact.get("args") or []

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

    # Default preserve behavior may be controlled via options or environment.
    preserve_tmp = bool(opts.get("preserve_tmp", os.environ.get("EVOLVE_PRESERVE_RUNS") == "1"))
    tmp = None

    # Use a deletable TemporaryDirectory unless caller asked to preserve it.
    if preserve_tmp:
        # Allow callers to specify a base directory to place preserved runs under
        # (e.g., a project workspace's `.vscode/pnmlGen`). If provided, create the
        # base dir and place the run directory there. Falls back to system temp.
        preserve_base = opts.get("preserve_dir") or os.environ.get("EVOLVE_PRESERVE_BASE")
        if preserve_base:
            try:
                os.makedirs(preserve_base, exist_ok=True)
                tmp = tempfile.mkdtemp(prefix="evolve_run_", dir=preserve_base)
                tmp_owner_created = True
            except Exception:
                # If creating under preserve_base fails for any reason, fall back
                # to the default behaviour of creating a temp dir in /tmp.
                tmp = tempfile.mkdtemp(prefix="evolve_run_")
                tmp_owner_created = True
        else:
            tmp = tempfile.mkdtemp(prefix="evolve_run_")
            tmp_owner_created = True
    else:
        tmp_context = tempfile.TemporaryDirectory(prefix="evolve_run_")
        tmp = tmp_context.name
        tmp_owner_created = False

    try:
        for rel_path, content in files.items():
            abs_path = os.path.join(tmp, rel_path)
            os.makedirs(os.path.dirname(abs_path), exist_ok=True)
            with open(abs_path, "w", encoding="utf-8") as f:
                f.write(str(content))

        # If we're preserving the run directory and a source PNML text was
        # provided as part of the artifact, write it to the preserved directory
        # so it's available alongside the generated project/run files.
        if preserve_tmp and code_artifact.get("pnml"):
            try:
                pnml_path = os.path.join(tmp, "pnml.yaml")
                with open(pnml_path, "w", encoding="utf-8") as pf:
                    pf.write(str(code_artifact.get("pnml")))
            except Exception:
                # Do not fail the run for PNML write errors; just continue.
                pass

        entry_path = os.path.join(tmp, entrypoint)
        try:
            cmd = [sys.executable, entry_path]
            if isinstance(args, (list, tuple)):
                cmd.extend(str(a) for a in args)
            completed = subprocess.run(
                cmd,
                cwd=tmp,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
            end = time.time()
            # When preserved, also print the location to stderr so the DevTools/Debug Console sees it.
            if preserve_tmp:
                try:
                    print(f"[evolve] preserved run directory: {tmp}", file=sys.stderr)
                except Exception:
                    pass
            result = {
                "run_id": run_id,
                "stdout": completed.stdout,
                "stderr": completed.stderr,
                "exit_code": completed.returncode,
                "start_time": start,
                "end_time": end,
                "tmp_dir": tmp,
                "preserved": preserve_tmp,
            }
            return result
        except subprocess.TimeoutExpired:
            end = time.time()
            return {
                "run_id": run_id,
                "stdout": "",
                "stderr": "timeout",
                "exit_code": 124,
                "start_time": start,
                "end_time": end,
                "tmp_dir": tmp,
                "preserved": preserve_tmp,
            }
    finally:
        # Clean up the temporary directory if we created a TemporaryDirectory context
        if not preserve_tmp and not tmp_owner_created:
            try:
                tmp_context.cleanup()
            except Exception:
                pass
