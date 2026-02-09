import os
import unittest

from enginepy.trace import collector
from enginepy import pnml_updater


class EvaluateAndPromoteIntegrationTests(unittest.TestCase):
    def test_evaluate_and_promote(self) -> None:
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        pnml_path = os.path.join(root, "samples", "pnml", "with_async.yaml")
        pnml_text = open(pnml_path, "r", encoding="utf-8").read()
        run_result = {
            "run_id": "run-1",
            "stdout": "ok",
            "stderr": "",
            "exit_code": 0,
            "start_time": 1,
            "end_time": 2,
        }
        trace = collector.collect(run_result, transition_id="t_async")
        updated = pnml_updater.apply(pnml_text, {"action": "suggest_update", "ideation_spec": {"goal": "x"}})
        self.assertIn("execMode: sync", updated)


if __name__ == "__main__":
    unittest.main()
