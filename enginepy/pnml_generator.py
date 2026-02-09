from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from .ideation_spec import validate_ideation
from . import vscode_bridge


def _default_prompt(ideation: Dict[str, Any]) -> str:
    goal = ideation.get("goal", "")
    constraints = ", ".join(ideation.get("constraints", []))
    return (
        "Generate PNML YAML for an EVOLVE workflow. "
        "Return only YAML with pnml/net/page/place/transition/arc. "
        f"Goal: {goal}. Constraints: {constraints}."
    )


def _fallback_pnml(ideation: Dict[str, Any]) -> str:
    title = ideation.get("goal", "Ideation")
    return (
        "pnml:\n"
        "  net:\n"
        "    - id: ideation_flow\n"
        "      type: \"https://evolve.dev/pnml/hlpn/evolve-2009\"\n"
        "      page:\n"
        "        - id: page1\n"
        "          place:\n"
        "            - id: p_start\n"
        f"              name: {{ text: \"{title}\" }}\n"
        "              evolve:\n"
        "                initialTokens:\n"
        "                  - value: {}\n"
        "            - id: p_end\n"
        "              name: { text: END }\n"
        "          transition:\n"
        "            - id: t_noop\n"
        "              name: { text: \"No-op\" }\n"
        "          arc:\n"
        "            - { id: a1, source: p_start, target: t_noop }\n"
        "            - { id: a2, source: t_noop, target: p_end }\n"
    )


def from_ideation(ideation: Dict[str, Any], chat_func: Optional[Callable[[str], str]] = None) -> str:
    validate_ideation(ideation)
    prompt = _default_prompt(ideation)
    if chat_func is None:
        if not vscode_bridge.is_available():
            return _fallback_pnml(ideation)
        response = vscode_bridge.chat(prompt)
    else:
        response = chat_func(prompt)
    if not isinstance(response, str) or not response.strip():
        return _fallback_pnml(ideation)
    return response
