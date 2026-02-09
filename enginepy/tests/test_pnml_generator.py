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


if __name__ == "__main__":
    unittest.main()
