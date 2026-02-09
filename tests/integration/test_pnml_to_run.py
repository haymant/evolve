import os
import unittest

from enginepy import codegen_adapter
from enginepy import runtime_runner


class PnmlToRunIntegrationTests(unittest.TestCase):
    def test_pnml_to_run(self) -> None:
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        path = os.path.join(root, "samples", "pnml", "simple_print.yaml")
        pnml_text = open(path, "r", encoding="utf-8").read()
        artifact = codegen_adapter.generate(pnml_text)
        result = runtime_runner.run_in_venv(artifact, {"timeout_sec": 5})
        self.assertEqual(result["exit_code"], 0)
        self.assertIn("hello", result["stdout"])


if __name__ == "__main__":
    unittest.main()
