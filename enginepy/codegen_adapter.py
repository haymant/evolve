from __future__ import annotations

from typing import Any, Dict, List, Tuple

from .pnml_parser import parse_pnml


def _collect_expression_blocks(pnml_text: str) -> List[Tuple[str, str]]:
    net, _places = parse_pnml(pnml_text)
    blocks: List[Tuple[str, str]] = []
    for tid, transition in net.transitions.items():
        for ins in transition.inscriptions:
            if ins.language != "python" or ins.kind != "expression":
                continue
            code = ins.code or ""
            blocks.append((tid, code))
    return blocks


def generate(pnml_text: str) -> Dict[str, Any]:
    """Generate a runnable Python artifact from PNML.

    The output keeps a simple single-file entrypoint for now.
    """
    pnml = pnml_text or ""
    blocks = _collect_expression_blocks(pnml)

    lines: List[str] = [
        "# Auto-generated from PNML",
        "",
        "def main():",
    ]
    if not blocks:
        lines.append("    print('No executable inscriptions found')")
    for tid, code in blocks:
        lines.append(f"    # transition {tid}")
        for raw in code.splitlines() or [""]:
            lines.append(f"    {raw}")
    lines.extend(["", "if __name__ == '__main__':", "    main()", ""])

    content = "\n".join(lines)
    return {
        "entrypoint": "main.py",
        "files": {"main.py": content},
        "requirements": [],
    }
