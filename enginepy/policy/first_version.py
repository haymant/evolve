from __future__ import annotations

from typing import Any, Dict, List


def choose_mode(node: Dict[str, Any], templates: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    node_type = node.get("type")
    for template in templates.values():
        if template.get("node_type") == node_type:
            return {"mode": "deterministic", "template_id": template.get("id")}
    return {"mode": "async", "template_id": None}


def ensure_deterministic_pnml(pnml_text: str) -> str:
    """Ensure at least one deterministic execMode is present.

    If no deterministic execMode is found, flip the first async occurrence.
    """
    if "execMode: sync" in pnml_text or "execMode: deterministic" in pnml_text:
        return pnml_text
    return pnml_text.replace("execMode: async", "execMode: sync", 1)


def apply_policy(nodes: List[Dict[str, Any]], templates: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    decisions = [choose_mode(node, templates) for node in nodes]
    if not any(d.get("mode") == "deterministic" for d in decisions):
        if decisions:
            decisions[0]["mode"] = "deterministic"
    return decisions
