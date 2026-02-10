from __future__ import annotations

from typing import Tuple

from .pnml_parser import parse_pnml


class PNMLValidationError(ValueError):
    pass


def _normalize_net_list(text: str) -> str:
    # If `net:` is followed by `page:` directly (no list entry), inject a generated net id
    # and indent the block under net by two spaces so it nests under the list item.
    lines = text.splitlines()
    net_line = None
    net_indent = 0

    for i, raw in enumerate(lines):
        if raw.strip() == "net:":
            net_line = i
            net_indent = len(raw) - len(raw.lstrip(" "))
            break

    if net_line is None:
        return text

    # Find the next non-empty, non-comment line
    next_line = None
    for j in range(net_line + 1, len(lines)):
        stripped = lines[j].strip()
        if not stripped or stripped.startswith("#"):
            continue
        next_line = j
        break

    if next_line is None:
        return text

    next_raw = lines[next_line]
    next_indent = len(next_raw) - len(next_raw.lstrip(" "))
    if next_indent <= net_indent:
        return text

    # If already a list under net, do nothing
    if next_raw.lstrip().startswith("-"):
        return text

    # Only normalize when the next key is page:
    if not next_raw.lstrip().startswith("page:"):
        return text

    insert_line = " " * (net_indent + 2) + "- id: generated_net"
    lines.insert(net_line + 1, insert_line)

    # Indent the existing net block (from original next_line) by +2 spaces
    # Stop when indentation returns to net level or less.
    for k in range(net_line + 2, len(lines)):
        raw = lines[k]
        if raw.strip() == "" or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        if indent <= net_indent:
            break
        lines[k] = "  " + raw

    return "\n".join(lines)


def validate(text: str) -> Tuple[bool, str]:
    try:
        net, _ = parse_pnml(text)
    except Exception as exc:  # pragma: no cover - defensive
        # Try normalization attempt before returning parse error
        try:
            alt = _normalize_net_list(text)
            if alt != text:
                net, _ = parse_pnml(alt)
            else:
                return False, f"parse error: {exc}"
        except Exception as exc2:
            return False, f"parse error: {exc}; normalization failed: {exc2}"
    if not net.places:
        # Attempt to normalize text by wrapping net in a list entry if possible
        alt = _normalize_net_list(text)
        if alt != text:
            try:
                net2, _ = parse_pnml(alt)
                if net2.places:
                    return True, "ok (normalized net list)"
            except Exception:
                pass
        return False, "no places found"
    if not net.transitions:
        return False, "no transitions found"
    return True, "ok"
