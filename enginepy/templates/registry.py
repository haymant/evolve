from __future__ import annotations

import os
from typing import Any, Dict

try:
    import yaml
except Exception:  # pragma: no cover - optional dependency
    yaml = None  # type: ignore[assignment]


def _simple_parse(text: str) -> Dict[str, Any]:
    data: Dict[str, Any] = {}
    current_map: Dict[str, Any] | None = None
    current_key: str | None = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0 and ":" in line:
            key, value = line.split(":", 1)
            key = key.strip()
            value = value.strip().strip('"')
            if value:
                data[key] = value
                current_map = None
                current_key = None
            else:
                data[key] = {}
                current_map = data[key]
                current_key = key
        elif indent > 0 and current_map is not None and ":" in line:
            key, value = line.split(":", 1)
            key = key.strip()
            value = value.strip().strip('"')
            current_map[key] = value
    return data


def _default_templates_dir() -> str:
    root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
    return os.path.join(root, "templates")


def load_templates(path: str | None = None) -> Dict[str, Dict[str, Any]]:
    """Load YAML templates from a directory."""
    templates: Dict[str, Dict[str, Any]] = {}
    directory = path or _default_templates_dir()
    if not os.path.isdir(directory):
        return templates
    for name in os.listdir(directory):
        if not name.endswith((".yml", ".yaml")):
            continue
        full = os.path.join(directory, name)
        with open(full, "r", encoding="utf-8") as f:
            raw = f.read()
        if yaml is None:
            data = _simple_parse(raw)
        else:
            data = yaml.safe_load(raw) or {}
        template_id = data.get("id") or os.path.splitext(name)[0]
        data["id"] = template_id
        templates[template_id] = data
    return templates
