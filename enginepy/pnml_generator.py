from __future__ import annotations

import os
from typing import Any, Callable, Dict, List, Optional

from .ideation_spec import validate_ideation
from . import vscode_bridge
from . import pnml_validator


def _default_prompt(ideation: Dict[str, Any]) -> str:
    goal = ideation.get("goal", "")
    constraints = ", ".join(ideation.get("constraints", []))
    return (
        "Generate PNML YAML for an EVOLVE workflow. "
        "Return only YAML with pnml/net/page/place/transition/arc. "
        "Include at least one python expression inscription. "
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


def _extract_yaml(response: str) -> str:
    text = response.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if len(lines) >= 2 and lines[0].startswith("```"):
            # Drop the opening and closing fences
            content = "\n".join(lines[1:-1])
            return content.strip()
    return text


def _max_retries() -> int:
    raw = os.getenv("EVOLVE_PNML_MAX_RETRIES", "3")
    try:
        value = int(raw)
    except Exception:
        return 3
    return max(0, value)


def _build_retry_prompt(base_prompt: str, history: List[Dict[str, str]]) -> str:
    parts = [base_prompt, "", "Previous attempts (oldest first):"]
    for idx, entry in enumerate(history, start=1):
        error = entry.get("error", "unknown error")
        output = entry.get("output", "")
        parts.append(f"{idx}. error: {error}")
        if output:
            parts.append("Output:")
            parts.append(output)
    parts.append("")
    parts.append("Fix the errors above and return only valid PNML YAML.")
    return "\n".join(parts)


def from_ideation(ideation: Dict[str, Any], chat_func: Optional[Callable[[str], str]] = None) -> str:
    validate_ideation(ideation)
    base_prompt = _default_prompt(ideation)
    history: List[Dict[str, str]] = []
    last_response = ""
    max_retries = _max_retries()
    total_attempts = max_retries + 1

    for _attempt in range(total_attempts):
        prompt = _build_retry_prompt(base_prompt, history) if history else base_prompt
        if chat_func is None:
            if not vscode_bridge.is_available():
                return _fallback_pnml(ideation)
            response = vscode_bridge.chat(prompt)
        else:
            response = chat_func(prompt)

        if not isinstance(response, str) or not response.strip():
            last_response = ""
            history.append({"error": "empty response", "output": ""})
            continue

        response = _extract_yaml(response)
        last_response = response
        ok, msg = pnml_validator.validate(response)
        if ok:
            try:
                from .policy import first_version

                response = first_version.ensure_deterministic_pnml(response)
            except Exception:
                pass
            return response

        history.append({"error": msg, "output": response})

    return last_response
