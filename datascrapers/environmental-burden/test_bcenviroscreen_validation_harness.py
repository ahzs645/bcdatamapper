import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("build-bcenviroscreen-validation-harness.py")
SPEC = importlib.util.spec_from_file_location("bcenviroscreen_validation_harness", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

SCORES_MODULE_PATH = Path(__file__).with_name("build-bcenviroscreen-scores.py")
SCORES_SPEC = importlib.util.spec_from_file_location("bcenviroscreen_scores", SCORES_MODULE_PATH)
SCORES_MODULE = importlib.util.module_from_spec(SCORES_SPEC)
SCORES_SPEC.loader.exec_module(SCORES_MODULE)


class CandidateSelectionTests(unittest.TestCase):
    def test_historical_ei_quarter_window_is_registered(self):
        fields = {
            source_field
            for source_id, source_field, _notes in MODULE.INDICATOR_CANDIDATES["employment_insurance_beneficiaries"]
            if source_id == "ei"
        }
        self.assertIn(
            "statcan_ei_2011_12_four_quarter_end_sep_2012_regular_benefits_without_declared_earnings_per_100_population",
            fields,
        )

    def test_housing_coverage_candidate_is_registered(self):
        fields = {
            source_field
            for source_id, source_field, _notes in MODULE.INDICATOR_CANDIDATES["housing_burdened_renters"]
            if source_id == "census_2016"
        }
        self.assertIn("renter_housing_burden_ge50_min_coverage_50_percent", fields)

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

    def test_score_source_override_loads_named_candidate_field(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "candidate.json"
            path.write_text(
                json.dumps(
                    [
                        {
                            "lha_name": "Prince George",
                            "nrcan_current_mills_mines_smelters_oil_gas_count": 16,
                        }
                    ]
                )
            )
            definitions = {
                "industrial_sites": {
                    "path": path,
                    "field": "nrcan_current_mills_mines_smelters_oil_gas_count",
                    "source": "nrcan_industrial.nrcan_current_mills_mines_smelters_oil_gas_count",
                }
            }
            with patch.object(SCORES_MODULE, "INDICATOR_OVERRIDES", definitions):
                overrides = SCORES_MODULE.load_indicator_overrides()
        self.assertEqual(overrides["industrial_sites"]["Prince George"], 16)


if __name__ == "__main__":
    unittest.main()
