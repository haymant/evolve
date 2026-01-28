import os
import tempfile
import unittest

from enginepy.project_gen import generate_python_project

SAMPLE = """
pnml:
  net:
    - id: house
      type: "https://evolve.dev/pnml/hlpn/evolve-2009"
      page:
        - id: page1
          place:
            - id: p1
              evolve:
                initialTokens:
                  - value: Red
          transition:
            - id: t1
              evolve:
                inscriptions:
                  - id: in1
                    language: python
                    kind: guard
                    source: inline
                    code: |
                      (lambda d: d > 101)(102)
          arc:
            - id: a1
              source: p1
              target: t1
"""


class ProjectGenerationTests(unittest.TestCase):
    def test_generate_python_project(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            module_dir = generate_python_project(SAMPLE, tmp, source_name="sample")
            main_path = os.path.join(module_dir, "main.py")
            ins_path = os.path.join(module_dir, "inscriptions.py")
            self.assertTrue(os.path.exists(main_path))
            self.assertTrue(os.path.exists(ins_path))
            local_engine = os.path.join(module_dir, "enginepy", "pnml_engine.py")
            self.assertTrue(os.path.exists(local_engine))
            with open(ins_path, "r", encoding="utf-8") as handle:
              content = handle.read()
            self.assertIn("lambda d", content)
            self.assertIn("def in1", content)


if __name__ == "__main__":
    unittest.main()
