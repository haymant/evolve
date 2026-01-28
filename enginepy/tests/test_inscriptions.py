import io
import unittest
from contextlib import redirect_stdout

from enginepy.inscription_registry import build_registry_key, clear_registry, register_inscription
from enginepy.pnml_engine import PNMLEngine
from enginepy.pnml_parser import parse_pnml

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
            - id: p2
              evolve:
                initialTokens:
                  - value: Blue
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
                  - id: in2
                    language: python
                    kind: expression
                    source: inline
                    code: |
                      print("Moving from Room1 to Room2")
          arc:
            - id: a1
              source: p1
              target: t1
            - id: a2
              source: t1
              target: p2
"""


class InscriptionTests(unittest.TestCase):
    def test_guard_and_expression_run(self) -> None:
        net, _ = parse_pnml(SAMPLE)
        clear_registry()

        def guard(_token=None) -> bool:
            return (lambda d: d > 101)(102)

        def expr(_token=None) -> None:
            print("Moving from Room1 to Room2")

        register_inscription(build_registry_key("house", "t1", "guard"), guard)
        register_inscription(build_registry_key("house", "t1", "expression"), expr)

        engine = PNMLEngine(net)
        buf = io.StringIO()
        with redirect_stdout(buf):
            fired = engine.step_once()
        self.assertEqual(fired, "t1")
        out = buf.getvalue()
        self.assertIn("Moving from Room1 to Room2", out)
        self.assertEqual(engine.marking["p1"], [])
        self.assertEqual(engine.marking["p2"], ["Blue", "Red"])


if __name__ == "__main__":
    unittest.main()
