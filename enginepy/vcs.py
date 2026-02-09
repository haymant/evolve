from __future__ import annotations

from typing import Any, Dict


def commit_branch(branch: str, metadata: Dict[str, Any]) -> Dict[str, Any]:
    """Return commit metadata for a branch.

    This placeholder avoids performing real VCS operations in examples.
    """
    return {"branch": branch, "metadata": metadata, "status": "noop"}
