"""Regression coverage for the public Power BI row compression used by the pilot."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("inventory", Path(__file__).with_name("inventory-state-of-north.py"))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class DecodeRows(unittest.TestCase):
    def test_dictionary_inline_repeat_null_and_datetime(self):
        data = {"dsr": {"DS": [{"IC": True, "ValueDicts": {"D0": ["Cariboo"]}, "PH": [{"DM0": [
            {"S": [{"N": "G0", "T": 1, "DN": "D0"}, {"N": "G1", "T": 3}, {"N": "G2", "T": 7}],
             "C": [0, 1483228800000], "Ø": 2},
            {"C": [12.5], "R": 5},
            {"C": ["North Central", 0], "R": 4},
            {"C": [], "R": 7},
        ]}]}]}}
        rows, complete = inventory.decode_rows(data, ["region", "value", "date"])
        self.assertEqual(rows, [
            {"region": "Cariboo", "value": None, "date": "2017-01-01T00:00:00Z"},
            {"region": "Cariboo", "value": 12.5, "date": "2017-01-01T00:00:00Z"},
            {"region": "North Central", "value": 0, "date": "2017-01-01T00:00:00Z"},
            {"region": "North Central", "value": 0, "date": "2017-01-01T00:00:00Z"},
        ])
        self.assertTrue(complete)
        data["dsr"]["DS"][0]["DLEx"] = [{"N": "L0"}]
        self.assertFalse(inventory.decode_rows(data, ["region", "value", "date"])[1])

    def test_rejects_nested_or_new_encoding_instead_of_silent_corruption(self):
        data = {"dsr": {"DS": [{"PH": [{"DM0": [{"DM1": []}]}]}]}}
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            inventory.decode_rows(data, ["region"])


if __name__ == "__main__":
    unittest.main()
