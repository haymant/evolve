import os
import unittest

from enginepy import codegen_adapter
from enginepy import runtime_runner


class CodeGenRuntimeTests(unittest.TestCase):
    def test_codegen_generates_files(self) -> None:
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        path = os.path.join(root, "samples", "pnml", "simple_print.yaml")
        pnml_text = open(path, "r", encoding="utf-8").read()
        artifact = codegen_adapter.generate(pnml_text)
        self.assertIn("entrypoint", artifact)
        self.assertIn("files", artifact)
        self.assertIn("main.py", artifact["files"])

    def test_runtime_runs_success(self) -> None:
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        path = os.path.join(root, "samples", "pnml", "simple_print.yaml")
        pnml_text = open(path, "r", encoding="utf-8").read()
        artifact = codegen_adapter.generate(pnml_text)
        result = runtime_runner.run_in_venv(artifact, {"timeout_sec": 5})
        self.assertEqual(result["exit_code"], 0)
        self.assertIn("hello", result["stdout"])

    def test_runtime_times_out(self) -> None:
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        path = os.path.join(root, "samples", "code", "long_sleep.py")
        code = open(path, "r", encoding="utf-8").read()
        artifact = {
            "entrypoint": "main.py",
            "files": {"main.py": code},
            "requirements": [],
        }
        result = runtime_runner.run_in_venv(artifact, {"timeout_sec": 0.1})
        self.assertEqual(result["exit_code"], 124)


if __name__ == "__main__":
    unittest.main()
