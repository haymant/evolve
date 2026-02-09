from __future__ import annotations

from typing import Any, Dict

from . import codegen_adapter


def generate(pnml_text: str) -> Dict[str, Any]:
    """Return a generated code payload for a PNML workflow."""
    artifact = codegen_adapter.generate(pnml_text)
    return {
        "code": {
            "language": "python",
            "entry": artifact.get("entrypoint"),
            "files": artifact.get("files", {}),
            "requirements": artifact.get("requirements", []),
        },
        "summary": "Generated Python artifact from PNML",
    }
