import json
import os
import unittest

from enginepy.ideation_serializer import from_token, to_token


class IdeationSerializerTests(unittest.TestCase):
    def _load_sample(self, name: str):
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        path = os.path.join(root, "samples", "ideation", name)
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def test_serializer_roundtrip(self) -> None:
        payload = self._load_sample("valid_001.json")
        token = to_token(payload)
        ideation = from_token(token)
        self.assertEqual(ideation["goal"], payload["goal"])
        self.assertEqual(ideation["mode"], payload["mode"])


if __name__ == "__main__":
    unittest.main()
