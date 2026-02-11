import os
import tempfile
import unittest

from enginepy import codegen
from enginepy import codegen_adapter
from enginepy import project_gen
from enginepy import runtime_runner
from enginepy import runtime


class CodeGenRuntimeTests(unittest.TestCase):
    def test_codegen_generates_files(self) -> None:
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        path = os.path.join(root, "samples", "pnml", "simple_print.yaml")
        pnml_text = open(path, "r", encoding="utf-8").read()
        artifact = codegen_adapter.generate(pnml_text)
        self.assertIn("entrypoint", artifact)
        self.assertIn("files", artifact)
        self.assertIn("main.py", artifact["files"])

    def test_codegen_accepts_inscription_without_id(self) -> None:
        pnml_text = """
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
                                        kind: expression
                                        source: inline
                                        code: "print('hi')"
                    arc:
                        - { id: a1, source: p1, target: t1 }
                        - { id: a2, source: t1, target: p2 }
"""
        artifact = codegen_adapter.generate(pnml_text)
        content = artifact["files"].get("inscriptions.py", "")
        self.assertIn("print('hi')", content)

    def test_project_gen_writes_project(self) -> None:
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        path = os.path.join(root, "samples", "pnml", "simple_print.yaml")
        pnml_text = open(path, "r", encoding="utf-8").read()
        with tempfile.TemporaryDirectory(prefix="evolve_project_") as tmp:
            module_dir = project_gen.generate_python_project(pnml_text, tmp, source_name="sample")
            main_path = os.path.join(module_dir, "main.py")
            inscriptions_path = os.path.join(module_dir, "inscriptions.py")
            engine_path = os.path.join(module_dir, "enginepy", "pnml_engine.py")
            self.assertTrue(os.path.exists(main_path))
            self.assertTrue(os.path.exists(inscriptions_path))
            self.assertTrue(os.path.exists(engine_path))

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

    def test_runtime_blocks_disallowed_dependency(self) -> None:
        artifact = {
            "entrypoint": "main.py",
            "files": {"main.py": "print('ok')\n"},
            "requirements": ["requests"],
        }
        result = runtime_runner.run_in_venv(artifact, {"allowlist": []})
        self.assertEqual(result["exit_code"], 3)
        self.assertIn("blocked dependency", result["stderr"])

    def test_runtime_preserve_tmp_dir(self) -> None:
        artifact = {
            "entrypoint": "main.py",
            "files": {"main.py": "print('persistent')\n"},
            "requirements": [],
        }
        result = runtime_runner.run_in_venv(artifact, {"preserve_tmp": True, "timeout_sec": 5})
        self.assertEqual(result["exit_code"], 0)
        self.assertTrue(result.get("preserved"))
        tmp = result.get("tmp_dir")
        self.assertTrue(tmp and __import__("os").path.exists(tmp))
        main_path = __import__("os").path.join(tmp, "main.py")
        self.assertTrue(__import__("os").path.exists(main_path))
        content = open(main_path, "r", encoding="utf-8").read()
        self.assertIn("persistent", content)
        # cleanup
        import shutil

        shutil.rmtree(tmp)
    
    def test_runtime_preserve_tmp_via_env(self) -> None:
        prev = __import__("os").environ.get("EVOLVE_PRESERVE_RUNS")
        __import__("os").environ["EVOLVE_PRESERVE_RUNS"] = "1"
        try:
            artifact = {
                "entrypoint": "main.py",
                "files": {"main.py": "print('env_persistent')\n"},
                "requirements": [],
            }
            result = runtime_runner.run_in_venv(artifact, None)
            self.assertEqual(result["exit_code"], 0)
            self.assertTrue(result.get("preserved"))
            tmp = result.get("tmp_dir")
            self.assertTrue(tmp and __import__("os").path.exists(tmp))
            main_path = __import__("os").path.join(tmp, "main.py")
            self.assertTrue(__import__("os").path.exists(main_path))
            content = open(main_path, "r", encoding="utf-8").read()
            self.assertIn("env_persistent", content)
            # cleanup
            import shutil
            shutil.rmtree(tmp)
        finally:
            if prev is None:
                __import__("os").environ.pop("EVOLVE_PRESERVE_RUNS", None)
            else:
                __import__("os").environ["EVOLVE_PRESERVE_RUNS"] = prev

    def test_runtime_preserve_in_project_dir(self) -> None:
        import os
        import tempfile
        import shutil

        artifact = {
            "entrypoint": "main.py",
            "files": {"main.py": "print('project_persistent')\n"},
            "requirements": [],
        }
        with tempfile.TemporaryDirectory(prefix="proj_") as proj:
            # simulate project .vscode/pnmlGen path
            preserve_base = os.path.join(proj, ".vscode", "pnmlGen")
            # Simulate codegen attaching run.preserve_dir to the generated code
            code_payload = {"entry": "main.py", "files": artifact["files"], "requirements": artifact["requirements"], "run": {"preserve_dir": preserve_base}, "pnml": "sample: pnml_content\n"}
            result = runtime.run_in_venv(code_payload, {"preserve_tmp": True, "timeout_sec": 5})
            self.assertEqual(result["exit_code"], 0)
            self.assertTrue(result.get("preserved"))
            tmp = result.get("tmp_dir")
            self.assertTrue(tmp and __import__("os").path.exists(tmp))
            # The preserved tmp dir should be under the project preserve_base
            self.assertTrue(os.path.commonpath([tmp, preserve_base]) == preserve_base)
            main_path = os.path.join(tmp, "main.py")
            self.assertTrue(os.path.exists(main_path))
            content = open(main_path, "r", encoding="utf-8").read()
            self.assertIn("project_persistent", content)
            pnml_path = os.path.join(tmp, "pnml.yaml")
            self.assertTrue(os.path.exists(pnml_path))
            pnml_content = open(pnml_path, "r", encoding="utf-8").read()
            self.assertIn("pnml_content", pnml_content)
            # cleanup
            shutil.rmtree(tmp)

    def test_codegen_includes_preserve_dir_from_env(self) -> None:
        import os
        prev = os.environ.get("EVOLVE_PRESERVE_BASE")
        try:
            with tempfile.TemporaryDirectory(prefix="proj_") as proj:
                preserve_base = os.path.join(proj, ".vscode", "pnmlGen")
                os.environ["EVOLVE_PRESERVE_BASE"] = preserve_base
                path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "samples", "pnml", "simple_print.yaml")
                pnml_text = open(path, "r", encoding="utf-8").read()
                payload = codegen.generate(pnml_text)
                code = payload.get("code", {})
                run = code.get("run", {})
                self.assertEqual(run.get("preserve_dir"), preserve_base)
        finally:
            if prev is None:
                os.environ.pop("EVOLVE_PRESERVE_BASE", None)
            else:
                os.environ["EVOLVE_PRESERVE_BASE"] = prev
    def test_codegen_includes_run_metadata(self) -> None:
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        path = os.path.join(root, "samples", "pnml", "simple_print.yaml")
        pnml_text = open(path, "r", encoding="utf-8").read()
        payload = codegen.generate(pnml_text)
        code = payload.get("code", {})
        run = code.get("run", {})
        self.assertEqual(code.get("entry"), "main.py")
        self.assertEqual(run.get("entrypoint"), "main.py")
        self.assertEqual(run.get("cwd"), ".")
        self.assertEqual(run.get("command"), ["python", "main.py", "pnml.yaml"])
        self.assertEqual(run.get("args"), ["pnml.yaml"])


if __name__ == "__main__":
    unittest.main()
