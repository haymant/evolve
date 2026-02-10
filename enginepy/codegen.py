from __future__ import annotations

from typing import Any, Dict

from . import codegen_adapter


def generate(pnml_text: str) -> Dict[str, Any]:
    """Return a generated code payload for a PNML workflow."""
    artifact = codegen_adapter.generate(pnml_text)
    entrypoint = artifact.get("entrypoint")
    return {
        "code": {
            "language": "python",
            "entry": entrypoint,
            "files": artifact.get("files", {}),
            "requirements": artifact.get("requirements", []),
            "run": {
                "command": ["python", entrypoint] if entrypoint else ["python"],
                "cwd": ".",
                "entrypoint": entrypoint,
            },
        },
        "summary": "Generated Python artifact from PNML",
    }
