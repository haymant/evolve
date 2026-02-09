from __future__ import annotations

from typing import Any, Dict


def generate(pnml_text: str) -> Dict[str, Any]:
    """Return a generated code payload for a PNML workflow."""
    pnml = (pnml_text or "").strip()
    preview = pnml[:800]
    if len(pnml) > 800:
        preview += "\n# ... truncated ..."
    code = "\n".join(
        [
            "# Auto-generated from PNML",
            "PNML_YAML = '''{}'''".format(preview.replace("'''", "''")),
            "",
            "def main():",
            "    print('Workflow loaded')",
            "    if PNML_YAML:",
            "        print(PNML_YAML.splitlines()[0])",
            "",
            "if __name__ == '__main__':",
            "    main()",
            "",
        ]
    )
    return {
        "code": {
            "language": "python",
            "entry": "main.py",
            "files": {"main.py": code},
        },
        "summary": "Generated Python stub from PNML",
    }
