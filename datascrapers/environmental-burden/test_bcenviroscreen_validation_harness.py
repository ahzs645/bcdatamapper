import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("build-bcenviroscreen-validation-harness.py")
SPEC = importlib.util.spec_from_file_location("bcenviroscreen_validation_harness", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CandidateSelectionTests(unittest.TestCase):
    def test_total_population_hypertension_wins_over_better_fitting_male_series(self):
        total_field = next(iter(MODULE.PREFERRED_CANDIDATE_FIELDS["hypertension"]))
        rows = [
            {
                "shiny_field": "hypertension",
                "source_id": "health",
                "source_field": total_field,
                "rows": 89,
                "mean_absolute_difference": 5.0,
                "pearson_r": 0.8,
            },
            {
                "shiny_field": "hypertension",
                "source_id": "health",
                "source_field": total_field + "_male",
                "rows": 89,
                "mean_absolute_difference": 0.1,
                "pearson_r": 0.99,
            },
        ]
        chosen = MODULE.choose_best(rows)
        self.assertEqual(chosen[0]["source_field"], total_field)


if __name__ == "__main__":
    unittest.main()
