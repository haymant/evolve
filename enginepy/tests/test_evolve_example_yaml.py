import os
import unittest

from enginepy.pnml_parser import parse_pnml
from enginepy.pnml_engine import PNMLEngine


class EvolveExampleYamlTests(unittest.TestCase):
    def test_input_transition_returns_async_request(self) -> None:
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        path = os.path.join(root, "examples", "evolve.evolve.yaml")
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
        net, _ = parse_pnml(text)
        start_place = net.places.get("p_start")
        self.assertIsNotNone(start_place)
        self.assertTrue(start_place.tokens)
        engine = PNMLEngine(net)
        self.assertIn("t_input", engine.enabled_transitions())
        transition = net.transitions.get("t_input")
        self.assertIsNotNone(transition)
        inscriptions = transition.inscriptions
        self.assertTrue(inscriptions)
        code = inscriptions[0].code or ""
        self.assertIn("return vscode_bridge.participant_async", code)
        self.assertIn("token", code)
        self.assertNotIn("lambda d:", code)


if __name__ == "__main__":
    unittest.main()
