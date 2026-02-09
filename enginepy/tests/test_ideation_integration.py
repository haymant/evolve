import json
import os
import unittest

from enginepy.ideation_serializer import to_token
from enginepy.pnml_generator import from_ideation
from enginepy.pnml_validator import validate


class IdeationIntegrationTests(unittest.TestCase):
    def _load_sample(self, name: str):
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        path = os.path.join(root, "samples", "ideation", name)
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def test_ideation_to_pnml(self) -> None:
        payload = self._load_sample("valid_001.json")
        token = to_token(payload)
        pnml_text = from_ideation(token["ideation"], chat_func=lambda _prompt: "")
        ok, msg = validate(pnml_text)
        self.assertTrue(ok, msg)


if __name__ == "__main__":
    unittest.main()
