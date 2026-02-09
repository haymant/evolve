import json
import os
import unittest

from enginepy.ideation_spec import IdeationValidationError, load_schema, validate_ideation


class IdeationSpecTests(unittest.TestCase):
    def _load_sample(self, name: str):
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        path = os.path.join(root, "samples", "ideation", name)
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def test_schema_valid(self) -> None:
        schema = load_schema()
        self.assertIn("required", schema)
        self.assertIn("goal", schema["required"])

    def test_schema_missing_required(self) -> None:
        payload = self._load_sample("invalid_missing_goal.json")
        with self.assertRaises(IdeationValidationError):
            validate_ideation(payload)

    def test_schema_valid_payload(self) -> None:
        payload = self._load_sample("valid_001.json")
        validate_ideation(payload)


if __name__ == "__main__":
    unittest.main()
