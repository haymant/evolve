import json
import os
import unittest

from enginepy.trace import collector
from enginepy.evaluator_interface import Evaluator
from enginepy import pnml_updater


class TraceEvaluatorUpdaterTests(unittest.TestCase):
    def test_collector_normalizes(self) -> None:
        run_result = {
            "run_id": "run-1",
            "stdout": "ok",
            "stderr": "",
            "exit_code": 0,
            "start_time": 1,
            "end_time": 2,
        }
        trace = collector.collect(run_result, transition_id="t1")
        self.assertEqual(trace["run_id"], "run-1")
        self.assertEqual(trace["transition_results"][0]["transitionId"], "t1")

    def test_evaluator_no_update(self) -> None:
        trace = {"run_id": "run-1", "transition_results": []}
        result = Evaluator().evaluate(trace)
        self.assertEqual(result.action, "no_update")

    def test_updater_replaces_async_transition(self) -> None:
        root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        path = os.path.join(root, "samples", "pnml", "with_async.yaml")
        pnml_text = open(path, "r", encoding="utf-8").read()
        updated = pnml_updater.apply(pnml_text, {"action": "suggest_update"})
        self.assertIn("execMode: sync", updated)


if __name__ == "__main__":
    unittest.main()
