import json
import os
import unittest

from enginepy.pnml_generator import from_ideation
from enginepy.pnml_validator import validate


class PNMLGeneratorTests(unittest.TestCase):
    def _load_sample(self, name: str):
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        path = os.path.join(root, "samples", "ideation", name)
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def _load_pnml(self, name: str) -> str:
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        path = os.path.join(root, "samples", "pnml", name)
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def test_generator_accepts_valid_ideation(self) -> None:
        payload = self._load_sample("valid_001.json")
        pnml_text = self._load_pnml("simple_print.yaml")
        text = from_ideation(payload, chat_func=lambda _prompt: pnml_text)
        ok, _msg = validate(text)
        self.assertTrue(ok)

    def test_generator_rejects_invalid_ideation(self) -> None:
        payload = self._load_sample("invalid_missing_goal.json")
        with self.assertRaises(Exception):
            from_ideation(payload, chat_func=lambda _prompt: "")

    def test_generator_retries_on_validation_error(self) -> None:
        payload = self._load_sample("valid_001.json")
        pnml_text = self._load_pnml("simple_print.yaml")
        calls = {"count": 0}

        def _chat(_prompt: str) -> str:
            calls["count"] += 1
            if calls["count"] == 1:
                return "pnml: {}"
            return pnml_text

        text = from_ideation(payload, chat_func=_chat)
        ok, _msg = validate(text)
        self.assertTrue(ok)
        self.assertGreaterEqual(calls["count"], 2)

    def test_generator_sanitizes_missing_net_id(self) -> None:
        payload = self._load_sample("valid_001.json")
        malformed = """
pnml:
  net:
    - page:
        place:
          - id: "start"
            name:
              text: "Initial Capital Deployed"
            evolve:
              initialTokens:
                - value: 500000
          - id: "signal_pending"
            name:
              text: "Waiting for Signal"
        transition:
          - id: t1
            name: { text: "noop" }
"""
        # Chat returns malformed response; generator should sanitize and return valid PNML
        text = from_ideation(payload, chat_func=lambda _prompt: malformed)
        ok, msg = validate(text)
        self.assertTrue(ok, msg)

    def test_generator_requires_expression_inscription(self) -> None:
        payload = self._load_sample("valid_001.json")
        pnml_guard_only = """
pnml:
  net:
    - id: net1
      type: "https://evolve.dev/pnml/hlpn/evolve-2009"
      page:
        - id: page1
          place:
            - id: p1
              evolve:
                initialTokens:
                  - value: 1
            - id: p2
          transition:
            - id: t1
              evolve:
                inscriptions:
                  - language: python
                    kind: guard
                    source: inline
                    code: "lambda d: True"
          arc:
            - { id: a1, source: p1, target: t1 }
            - { id: a2, source: t1, target: p2 }
"""
        pnml_with_expr = self._load_pnml("simple_print.yaml")
        calls = {"count": 0}

        def _chat(_prompt: str) -> str:
            calls["count"] += 1
            return pnml_guard_only if calls["count"] == 1 else pnml_with_expr

        text = from_ideation(payload, chat_func=_chat)
        ok, msg = validate(text)
        self.assertTrue(ok, msg)
        self.assertGreaterEqual(calls["count"], 2)

    def test_generator_normalizes_plural_keys(self) -> None:
        payload = self._load_sample("valid_001.json")
        malformed = """
pnml:
  net:
    - id: net1
      type: "https://evolve.dev/pnml/hlpn/evolve-2009"
      page:
        places:
          - id: p1
            evolve:
              initialTokens:
                - value: 1
          - id: p2
        transitions:
          - id: t1
            evolve:
              inscriptions:
                - language: python
                  kind: expression
                  source: inline
                  code: "print('hi')"
        arcs:
          - { id: a1, source: p1, target: t1 }
          - { id: a2, source: t1, target: p2 }
"""
        text = from_ideation(payload, chat_func=lambda _prompt: malformed)
        ok, msg = validate(text)
        self.assertTrue(ok, msg)

if __name__ == "__main__":
    unittest.main()
