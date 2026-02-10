from __future__ import annotations

import json
import os
from typing import Any, Callable, Dict, List, Optional

from .ideation_spec import validate_ideation
from . import vscode_bridge
from . import pnml_validator
from .pnml_parser import parse_pnml


def _default_prompt(ideation: Dict[str, Any], schema_excerpt: str) -> str:
    goal = ideation.get("goal", "")
    constraints = ", ".join(ideation.get("constraints", []))
    schema_hint = f"\nSchema excerpt:\n{schema_excerpt}" if schema_excerpt else ""
    return (
        "Generate PNML YAML for an EVOLVE workflow. "
        "Return only YAML with pnml/net/page/place/transition/arc. "
        "Include at least one python expression inscription. "
        f"Goal: {goal}. Constraints: {constraints}."
        f"{schema_hint}"
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


def _load_schema_text() -> str:
    if vscode_bridge.is_available():
        try:
            result = vscode_bridge.execute_command("evolve.getPnmlSchema")
            if isinstance(result, dict) and isinstance(result.get("schema"), str):
                return result["schema"]
            if isinstance(result, str):
                return result
        except Exception:
            pass
    schema_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "schema", "pnml.schema")
    try:
        with open(schema_path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""


def _schema_excerpt(schema_text: str) -> str:
    if not schema_text:
        return ""
    try:
        data = json.loads(schema_text)
    except Exception:
        return ""
    defs = data.get("$defs", {}) if isinstance(data, dict) else {}
    keep = {
        "transition": defs.get("transition"),
        "evolveTransition": defs.get("evolveTransition"),
        "evolveInscription": defs.get("evolveInscription"),
        "arc": defs.get("arc"),
        "place": defs.get("place"),
    }
    try:
        return json.dumps({"$defs": keep}, indent=2, sort_keys=True)
    except Exception:
        return ""


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
    schema_text = _load_schema_text()
    schema_excerpt = _schema_excerpt(schema_text)
    base_prompt = _default_prompt(ideation, schema_excerpt)
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

        # Try to sanitize common structural mistakes (missing net id/type or page id)
        sanitized = _sanitize_pnml(response)
        if sanitized != response:
            # record that we sanitized once for the history
            history.append({"error": "sanitized", "output": response})
            response = sanitized
            last_response = response

        ok, msg = pnml_validator.validate(response)
        if ok:
            if not _has_expression_inscriptions(response):
                msg = "no python expression inscriptions found"
                # record a non-fatal validation failure so we can retry
                history.append({"error": msg, "output": response})
                try:
                    if chat_func is None and vscode_bridge.is_available():
                        safe_msg = (
                            "Validation failed: no python expression inscriptions found.\n"
                            "Previous output:\n"
                            f"{response}\n"
                            "Please add at least one python expression inscription in a transition."
                        )
                        try:
                            vscode_bridge.chat(safe_msg)
                        except Exception:
                            pass
                except Exception:
                    pass
                continue
            try:
                from .policy import first_version

                response = first_version.ensure_deterministic_pnml(response)
            except Exception:
                pass
            return response
        # send invalid output into Copilot chat history to help model self-correct
        try:
            if chat_func is None and vscode_bridge.is_available():
                safe_msg = f"Validation failed: {msg}\nPrevious output:\n{response}\nPlease fix and return valid PNML YAML."
                try:
                    vscode_bridge.chat(safe_msg)
                except Exception:
                    pass
        except Exception:
            pass

        history.append({"error": msg, "output": response})

    return last_response


def _sanitize_pnml(text: str) -> str:
    # Fix common structure issues from model output:
    # 1) net: list item written as '- page:' (missing id/type) -> expand into id/type/page
    lines = text.splitlines()
    out_lines: list[str] = []
    for line in lines:
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if stripped.startswith("- page:"):
            base = " " * indent
            out_lines.append(f"{base}- id: generated_net")
            out_lines.append(f"{base}  type: \"https://evolve.dev/pnml/hlpn/evolve-2009\"")
            out_lines.append(f"{base}  page:")
            continue
        # Normalize common plural keys emitted by models
        if stripped.startswith("places:"):
            out_lines.append(" " * indent + "place:")
            continue
        if stripped.startswith("transitions:"):
            out_lines.append(" " * indent + "transition:")
            continue
        if stripped.startswith("arcs:"):
            out_lines.append(" " * indent + "arc:")
            continue
        out_lines.append(line)
    return "\n".join(out_lines)


def _has_expression_inscriptions(text: str) -> bool:
    try:
        net, _ = parse_pnml(text)
    except Exception:
        return False
    for transition in net.transitions.values():
        for ins in transition.inscriptions:
            if (ins.language or "").lower() == "python" and (ins.kind or "").lower() == "expression":
                return True
    return False
