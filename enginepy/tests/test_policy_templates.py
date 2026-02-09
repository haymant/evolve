import os
import unittest

from enginepy.policy import first_version
from enginepy.templates import registry


class PolicyTemplateTests(unittest.TestCase):
    def test_registry_loads_templates(self) -> None:
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        templates = registry.load_templates(os.path.join(root, "templates"))
        self.assertIn("validate_schema", templates)

    def test_policy_prefers_template(self) -> None:
        templates = {"t": {"id": "t", "node_type": "validate"}}
        decision = first_version.choose_mode({"type": "validate"}, templates)
        self.assertEqual(decision["mode"], "deterministic")

    def test_policy_defaults_to_async(self) -> None:
        decision = first_version.choose_mode({"type": "unknown"}, {})
        self.assertEqual(decision["mode"], "async")

    def test_policy_inserts_validation_transition(self) -> None:
        pnml_text = "execMode: async"
        updated = first_version.ensure_deterministic_pnml(pnml_text)
        self.assertIn("execMode: sync", updated)


if __name__ == "__main__":
    unittest.main()
