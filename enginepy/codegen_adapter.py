from __future__ import annotations

import os
import tempfile
from typing import Any, Dict

from . import project_gen


def _collect_project_files(module_dir: str) -> Dict[str, str]:
    files: Dict[str, str] = {}
    for root, _dirs, names in os.walk(module_dir):
        for name in names:
            path = os.path.join(root, name)
            rel_path = os.path.relpath(path, module_dir)
            with open(path, "r", encoding="utf-8") as f:
                files[rel_path] = f.read()
    return files


def generate(pnml_text: str) -> Dict[str, Any]:
    """Generate a runnable Python artifact from PNML.

    Use the same project generation logic as RUN/DEBUG so that inscription
    helpers and runtime facilities are present.
    """
    pnml = pnml_text or ""
    with tempfile.TemporaryDirectory(prefix="evolve_codegen_") as tmp:
        module_dir = project_gen.generate_python_project(pnml, tmp, source_name="pnml")
        files = _collect_project_files(module_dir)
    # Include the PNML source so the generated main can run without external files.
    files["pnml.yaml"] = pnml
    return {
        "entrypoint": "main.py",
        "files": files,
        "requirements": [],
        "args": ["pnml.yaml"],
    }
