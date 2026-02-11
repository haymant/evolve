from __future__ import annotations

from typing import Any, Dict

from . import codegen_adapter


def generate(pnml_text: str) -> Dict[str, Any]:
    """Return a generated code payload for a PNML workflow."""
    artifact = codegen_adapter.generate(pnml_text)
    entrypoint = artifact.get("entrypoint")
    run_metadata = {
        "command": ["python", entrypoint, "pnml.yaml"] if entrypoint else ["python"],
        "cwd": ".",
        "entrypoint": entrypoint,
        "args": ["pnml.yaml"],
    }
    # If a preserve base dir has been configured (e.g., by the DAP server),
    # include it in the run metadata so tooling and runtime can preserve runs
    # under the project tree (e.g., .vscode/pnmlGen).
    preserve_base = __import__("os").environ.get("EVOLVE_PRESERVE_BASE")
    if preserve_base:
        run_metadata["preserve_dir"] = preserve_base

    return {
        "code": {
            "language": "python",
            "entry": entrypoint,
            "files": artifact.get("files", {}),
            "requirements": artifact.get("requirements", []),
            "run": run_metadata,
            # Include the original PNML text so tooling (and runtime) can
            # preserve the source PNML alongside the run artifacts when
            # requested.
            "pnml": pnml_text,
        },
        "summary": "Generated Python artifact from PNML",
    }
