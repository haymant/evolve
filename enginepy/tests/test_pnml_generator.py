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

    def test_generator_accepts_valid_ideation(self) -> None:
        payload = self._load_sample("valid_001.json")
        text = from_ideation(payload, chat_func=lambda _prompt: "")
        ok, _msg = validate(text)
        self.assertTrue(ok)

    def test_generator_rejects_invalid_ideation(self) -> None:
        payload = self._load_sample("invalid_missing_goal.json")
        with self.assertRaises(Exception):
            from_ideation(payload, chat_func=lambda _prompt: "")


if __name__ == "__main__":
    unittest.main()
