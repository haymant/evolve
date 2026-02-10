import unittest

from enginepy.pnml_validator import validate


class PNMLValidatorNormalizeTests(unittest.TestCase):
    def test_normalize_net_list(self) -> None:
        text = """
pnml:
  net:
    page:
      - id: page1
        place:
          - id: p_start
            name: { text: START }
        transition:
          - id: t1
            name: { text: "noop" }
"""
        ok, msg = validate(text)
        self.assertTrue(ok)
        self.assertIn("ok", msg)


if __name__ == "__main__":
    unittest.main()
