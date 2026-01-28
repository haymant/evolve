import unittest
import time

from enginepy.inscription_registry import build_registry_key, clear_registry, register_inscription
from enginepy.pnml_engine import DebugEngine, PNMLEngine, PendingOp
from enginepy.pnml_parser import parse_pnml
from enginepy.async_ops import run_async

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
          arc:
            - id: a1
              source: p1
              target: t1
            - id: a2
              source: t1
              target: p2
"""


SAMPLE_WITH_INSCRIPTIONS = """
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
                      (lambda d: d > 0)(1)
                  - id: in2
                    language: python
                    kind: expression
                    source: inline
                    code: |
                      print("Moving")
          arc:
            - id: a1
              source: p1
              target: t1
            - id: a2
              source: t1
              target: p2
"""


SAMPLE_WITH_ASYNC = """
pnml:
  net:
    - id: async_demo
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
                  - id: in_async
                    language: python
                    kind: expression
                    execMode: async
                    source: inline
                    code: |
                      return "async-result"
          arc:
            - id: a1
              source: p1
              target: t1
            - id: a2
              source: t1
              target: p2
"""


class EngineTests(unittest.TestCase):
    def test_parse_yaml_to_graph(self) -> None:
        net, _ = parse_pnml(SAMPLE)
        self.assertIn("p1", net.places)
        self.assertIn("p2", net.places)
        self.assertIn("t1", net.transitions)
        self.assertEqual(len(net.arcs), 2)

    def test_marking_initialization(self) -> None:
        net, _ = parse_pnml(SAMPLE)
        engine = PNMLEngine(net)
        self.assertEqual(engine.marking["p1"], ["Red"])
        self.assertEqual(engine.marking["p2"], ["Blue"])

    def test_enabled_transitions(self) -> None:
        net, _ = parse_pnml(SAMPLE)
        engine = PNMLEngine(net)
        self.assertIn("t1", engine.enabled_transitions())

    def test_scheduler_firing(self) -> None:
        net, _ = parse_pnml(SAMPLE)
        engine = PNMLEngine(net)
        fired = engine.step_once()
        self.assertEqual(fired, "t1")
        self.assertEqual(engine.marking["p1"], [])
        self.assertTrue(len(engine.marking["p2"]) >= 1)

    def test_async_pause_placeholder(self) -> None:
      net, _ = parse_pnml(SAMPLE_WITH_ASYNC)
      clear_registry()

      def async_expr(_token=None):
        return run_async(lambda: "async-token")

      register_inscription(build_registry_key("async_demo", "t1", "expression"), async_expr)
      engine = PNMLEngine(net)

      result = engine.step_once()
      self.assertIsInstance(result, PendingOp)
      # Wait for async completion
      time.sleep(0.1)
      self.assertIn("async-token", engine.marking.get("p2", []))

    def test_async_immediate_result_no_duplicate(self) -> None:
      net, _ = parse_pnml(SAMPLE_WITH_ASYNC)
      clear_registry()

      def async_expr(_token=None):
        return "async-result"

      register_inscription(build_registry_key("async_demo", "t1", "expression"), async_expr)
      engine = PNMLEngine(net)

      result = engine.step_once()
      self.assertIsNotNone(result)
      marking = engine.marking.get("p2", [])
      # moved token (1) + async result
      self.assertEqual(marking.count(1), 1)
      self.assertEqual(marking.count("async-result"), 1)

    def test_bridge_execution_placeholder(self) -> None:
        # Placeholder: inscriptions are not executed in this engine.
        net, _ = parse_pnml(SAMPLE)
        engine = PNMLEngine(net)
        self.assertIsNotNone(engine)

    def test_ls_generation_placeholder(self) -> None:
        # Placeholder for LS generation: verify parser builds place index.
        _, places = parse_pnml(SAMPLE)
        self.assertTrue(any(p.id == "p1" for p in places))

    def test_dap_initialize_placeholder(self) -> None:
        engine = DebugEngine()
        engine.load(SAMPLE)
        self.assertIsNotNone(engine.engine)

    def test_set_breakpoints_mapping(self) -> None:
        engine = DebugEngine()
        engine.load(SAMPLE)
        place_line = engine.place_index[0].id_line
        engine.set_breakpoints_by_lines([place_line])
        self.assertTrue(len(engine.breakpoints) >= 1)

    def test_history_recording(self) -> None:
        engine = DebugEngine()
        engine.load(SAMPLE)
        entry = engine.step_once()
        self.assertIsNotNone(entry)
        self.assertEqual(len(engine.history), 1)

    def test_lazy_inscription_registry_wiring(self) -> None:
      net, _ = parse_pnml(SAMPLE_WITH_INSCRIPTIONS)
      clear_registry()

      def guard(_token=None) -> bool:
        return True

      def expr(_token=None) -> None:
        return None

      register_inscription(build_registry_key("house", "t1", "guard"), guard)
      register_inscription(build_registry_key("house", "t1", "expression"), expr)

      engine = PNMLEngine(net)
      transition = net.transitions["t1"]
      self.assertTrue(transition.inscriptions)
      self.assertTrue(all(ins.func is None for ins in transition.inscriptions))

      engine.step_once()
      self.assertTrue(all(ins.func is not None for ins in transition.inscriptions))


if __name__ == "__main__":
    unittest.main()
