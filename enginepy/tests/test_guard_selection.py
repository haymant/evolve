import os
import unittest

from enginepy.pnml_parser import parse_pnml
from enginepy.pnml_engine import PNMLEngine


class GuardSelectionTests(unittest.TestCase):
    def test_xor_guard_on_p_ideation(self) -> None:
        # Load example evolve net
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        path = os.path.join(root, "examples", "evolve.evolve.yaml")
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
        net, _ = parse_pnml(text)
        engine = PNMLEngine(net)

        # Simulate host submission by placing the ideation token into p_ideation
        from enginepy.inscription_registry import register_inscription, clear_registry
        from enginepy.inscription_registry import build_registry_key
        # Register guard and expression functions for the transitions
        clear_registry()
        register_inscription(build_registry_key(net.id or 'pnml', 't_generate_pnml', 'guard'), lambda token=None: token and token.get('mode') == 'ideation')
        register_inscription(build_registry_key(net.id or 'pnml', 't_generate_pnml', 'expression'), lambda token=None: {"pnml": "demo"})
        register_inscription(build_registry_key(net.id or 'pnml', 't_apply_selection', 'guard'), lambda token=None: token and token.get('mode') == 'selection')
        register_inscription(build_registry_key(net.id or 'pnml', 't_apply_selection', 'expression'), lambda token=None: {"code": "demo"})

        engine.marking.setdefault('p_ideation', []).append({"mode": "ideation", "ideation": {"goal": "x"}})

        # Now enabled transitions should include t_generate_pnml and not t_apply_selection
        enabled = engine.enabled_transitions()
        self.assertIn("t_generate_pnml", enabled)
        self.assertNotIn("t_apply_selection", enabled)

        # Fire the chosen transition
        fired = engine.step_once()
        self.assertEqual(fired, "t_generate_pnml")

    def test_xor_guard_selection_for_selection_mode(self) -> None:
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        path = os.path.join(root, "examples", "evolve.evolve.yaml")
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
        net, _ = parse_pnml(text)
        engine = PNMLEngine(net)

        from enginepy.inscription_registry import register_inscription, clear_registry
        from enginepy.inscription_registry import build_registry_key
        # Register guards and expression stubs again for this test
        clear_registry()
        register_inscription(build_registry_key(net.id or 'pnml', 't_generate_pnml', 'guard'), lambda token=None: token and token.get('mode') == 'ideation')
        register_inscription(build_registry_key(net.id or 'pnml', 't_generate_pnml', 'expression'), lambda token=None: {"pnml": "demo"})
        register_inscription(build_registry_key(net.id or 'pnml', 't_apply_selection', 'guard'), lambda token=None: token and token.get('mode') == 'selection')
        register_inscription(build_registry_key(net.id or 'pnml', 't_apply_selection', 'expression'), lambda token=None: {"code": "demo"})

        engine.marking.setdefault('p_ideation', []).append({"mode": "selection", "selection": "v1"})

        enabled = engine.enabled_transitions()
        self.assertIn("t_apply_selection", enabled)
        self.assertNotIn("t_generate_pnml", enabled)

        fired = engine.step_once()
        self.assertEqual(fired, "t_apply_selection")


if __name__ == "__main__":
    unittest.main()
