"""Independent, explicitly synthetic checks for exact exported-field comparison."""

import copy
import csv
import gzip
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("cciss_reference_comparison", ROOT / "compare-pilot-reference.py")
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


def reference_text():
    return (ROOT / "fixtures/synthetic-current-reference.csv").read_text()


def metadata():
    return json.loads((ROOT / "fixtures/synthetic-current-reference-metadata.json").read_text())


def browser_document():
    # Literal expected votes/summaries. This helper does not import or implement
    # the browser's weighting, overlap, rounding or suitability calculations.
    periods = ("1961", "1991", "2021", "2041", "2061", "2081")
    provenance = {key: value for key, value in metadata().items()
                  if key in ("datasetVersion", "ccissrCommit", "shinyCommit", "synthetic")}
    species = [
        {"site": "990000001", "series": "TESTalpha/01", "species": "TESTa", "current": 1,
         "votes": dict(zip(periods, [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0],
                                    [0, 0.5, 0, 0.5], [0, 0.5, 0, 0.5], [0, 0.5, 0, 0.5]])),
         "novelty": dict.fromkeys(periods, 0)},
        {"site": "990000001", "series": "TESTalpha/01", "species": "TESTb", "current": 2,
         "votes": dict(zip(periods, [[0, 1, 0, 0], [0, 1, 0, 0], [0, 1, 0, 0],
                                    [0.5, 0, 0.5, 0], [0.5, 0, 0.5, 0], [0.5, 0, 0.5, 0]])),
         "novelty": dict.fromkeys(periods, 0)},
    ]
    summaries = [
        {"species": "TESTa", "summary": {"establishment": 1, "maturation": 3, "improve": 25, "decline": 75}},
        {"species": "TESTb", "summary": {"establishment": 2, "maturation": 2, "improve": 62, "decline": 38}},
    ]
    return {"schema": "cciss-current-analysis-report-v1", "sourceFile": "synthetic-current-analysis.json",
            "provenance": provenance, "selection": metadata()["settings"],
            "calculation": {"siteId": 990000001, "bgc": "TESTalpha", "series": "TESTalpha/01",
                            "species": species, "summaries": summaries, "capabilities": {}, "provenance": provenance}}


def csv_rows(text):
    return list(csv.reader(io.StringIO(text)))


def csv_text(rows):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerows(rows)
    return stream.getvalue()


class ReferenceComparisonTests(unittest.TestCase):
    def compare(self, browser=None, text=None, **options):
        return comparison.compare(comparison.parse_browser(browser or browser_document()),
                                  comparison.parse_reference_csv(text or reference_text()), **options)

    def test_hand_checked_fixture_has_exact_field_agreement_without_parity_claim(self):
        result = self.compare(reference_metadata=metadata())
        self.assertTrue(result["fieldsAgree"])
        self.assertFalse(result["scientificParityVerified"])
        self.assertEqual(result["counts"]["matched"], 70)
        self.assertEqual(result["counts"]["withinTolerance"], 70)
        self.assertTrue(result["inputContextMatches"])
        self.assertIn("Synthetic", " ".join(result["warnings"]))
        self.assertEqual(result["maxAbsDifferenceByMeasure"],
                         {key: 0 for key in ("baseline", "establishment", "maturation", "improve", "decline", "vote", "novelty")})

    def test_original_summaries_are_compared_without_recomputing_reference_votes(self):
        rows = csv_rows(reference_text())
        rows[1][rows[0].index("EstabFeas")] = "2"
        result = self.compare(text=csv_text(rows))
        different = [row for row in result["rows"] if row["status"] == "different"]
        self.assertEqual(len(different), 1)
        self.assertEqual(different[0]["measure"], "establishment")
        self.assertEqual(different[0]["reference"], 2)
        self.assertEqual(different[0]["browser"], 1)

    def test_probability_tolerance_is_explicit_and_never_relaxes_classes(self):
        document = browser_document()
        document["calculation"]["species"][0]["votes"]["2041"][1] += 1e-9
        result = self.compare(browser=document)
        self.assertEqual(result["counts"]["withinTolerance"], 70)
        self.assertTrue(result["fieldsAgree"])
        self.assertFalse(self.compare(browser=document, tolerance=0)["fieldsAgree"])
        document["calculation"]["species"][0]["current"] = 2
        self.assertFalse(self.compare(browser=document, tolerance=0.01)["fieldsAgree"])
        for tolerance in (-1, 0.02, float("nan"), True):
            with self.subTest(tolerance=tolerance), self.assertRaises(ValueError):
                self.compare(tolerance=tolerance)

    def test_missing_fields_are_unknown_and_not_zero(self):
        rows = csv_rows(reference_text())
        rows[1][rows[0].index("NOV_2041")] = ""
        rows[1][rows[0].index("ccissFeas")] = ""
        result = self.compare(text=csv_text(rows))
        self.assertEqual(result["counts"]["missingReference"], 2)
        self.assertFalse(result["fieldsAgree"])
        document = browser_document()
        document["calculation"]["species"][0]["novelty"]["2041"] = None
        document["calculation"]["summaries"][0]["summary"]["maturation"] = None
        result = self.compare(browser=document, text=csv_text(rows))
        self.assertEqual(result["counts"]["bothMissing"], 2)
        self.assertFalse(result["fieldsAgree"])

    def test_novelty_scaled_display_votes_are_never_renormalized(self):
        rows = csv_rows(reference_text())
        for name, value in (("1_2041", "0.5"), ("2_2041", "0"), ("3_2041", "0"),
                            ("X_2041", "0"), ("NOV_2041", "0.5")):
            rows[1][rows[0].index(name)] = value
        document = browser_document()
        document["calculation"]["species"][0]["votes"]["2041"] = [0.25, 0, 0, 0.25]
        document["calculation"]["species"][0]["novelty"]["2041"] = 0.5
        result = self.compare(browser=document, text=csv_text(rows))
        high = next(row for row in result["rows"] if row["species"] == "TESTa"
                    and row["period"] == "2041" and row["class"] == "1")
        self.assertEqual(high["difference"], -0.25)
        self.assertEqual(high["status"], "different")

    def test_shuffled_species_rows_align_by_exact_keys_and_site_ids_do_not_alias(self):
        rows = csv_rows(reference_text())
        rows[1:] = reversed(rows[1:])
        self.assertTrue(self.compare(text=csv_text(rows))["fieldsAgree"])
        rows[1][0] = "client label, not site ID"
        result = self.compare(text=csv_text(rows))
        self.assertGreater(result["counts"]["missingBrowser"], 0)
        self.assertGreater(result["counts"]["missingReference"], 0)
        self.assertFalse(result["fieldsAgree"])

    def test_exact_scope_filters_are_explicit_and_empty_scope_never_passes(self):
        self.assertTrue(self.compare(site="990000001", series="TESTalpha/01")["fieldsAgree"])
        empty = self.compare(site="missing-site")
        self.assertEqual(empty["rows"], [])
        self.assertFalse(empty["fieldsAgree"])

    def test_site_alias_requires_explicit_confirmation_and_never_maps_series(self):
        rows = csv_rows(reference_text())
        for row in rows[1:]:
            row[0] = "Owner's selected SiteRef label"
        result = self.compare(text=csv_text(rows), reference_site="Owner's selected SiteRef label")
        self.assertFalse(result["fieldsAgree"])
        result = self.compare(text=csv_text(rows), reference_site="Owner's selected SiteRef label",
                              confirm_site_alias=True)
        self.assertTrue(result["fieldsAgree"])
        self.assertTrue(result["alignment"]["aliasApplied"])
        self.assertTrue(all(row["referenceSite"] == "Owner's selected SiteRef label" for row in result["rows"]))
        self.assertFalse(result["scientificParityVerified"])
        for row in rows[1:]:
            row[1] = "different-series"
        self.assertFalse(self.compare(text=csv_text(rows), reference_site="Owner's selected SiteRef label",
                                      confirm_site_alias=True)["fieldsAgree"])
        with self.assertRaisesRegex(ValueError, "requires --reference-site"):
            self.compare(confirm_site_alias=True)

    def test_published_historical_csv_retains_actual_periods_and_original_values(self):
        raw = gzip.decompress((ROOT / "output/report-examples/williams-lake-raw.csv.gz").read_bytes()).decode()
        reference = comparison.parse_reference_csv(raw)
        self.assertEqual(reference["format"], "historical-raw")
        self.assertEqual(reference["periods"], ["1975", "2000", "2025", "2055", "2085"])
        self.assertEqual(reference["records"][("4812311", "IDFxm/01", "Ac", "2055", "vote", "3")], 0.03)
        self.assertIsNone(reference["records"][("4812311", "IDFxm/01", "Ac", "2055", "novelty", None)])
        result = comparison.compare(comparison.parse_browser(browser_document()), reference)
        self.assertFalse(result["fieldsAgree"])
        self.assertEqual(result["counts"]["matched"], 0)

    def test_corrupt_duplicate_and_invalid_summary_inputs_are_rejected(self):
        rows = csv_rows(reference_text())
        with self.assertRaisesRegex(ValueError, "Duplicate or inconsistent"):
            comparison.parse_reference_csv(csv_text(rows + [rows[1]]))
        duplicate_header = copy.deepcopy(rows)
        duplicate_header[0][-1] = duplicate_header[0][-2]
        with self.assertRaisesRegex(ValueError, "Duplicate reference CSV column"):
            comparison.parse_reference_csv(csv_text(duplicate_header))
        for column, value in (("Improve", "101"), ("1_2021", "1.5"), ("Curr", "TRUE")):
            malformed = copy.deepcopy(rows)
            malformed[1][malformed[0].index(column)] = value
            with self.subTest(column=column, value=value), self.assertRaises(ValueError):
                comparison.parse_reference_csv(csv_text(malformed))

    def test_settings_and_version_metadata_are_reported_separately_from_values(self):
        result = self.compare()
        self.assertTrue(result["fieldsAgree"])
        self.assertFalse(result["inputContextMatches"])
        changed = metadata()
        changed["settings"]["noveltyCutoff"] = 5
        result = self.compare(reference_metadata=changed)
        self.assertTrue(result["fieldsAgree"])
        self.assertFalse(result["inputContextMatches"])
        self.assertFalse(result["scientificParityVerified"])

    def test_source_unsuitable_aliases_compare_as_one_class_without_changing_original_rows(self):
        rows = csv_rows(reference_text())
        rows[1][rows[0].index("Curr")] = "X"
        document = browser_document()
        document["calculation"]["species"][0]["current"] = 5
        reference = comparison.parse_reference_csv(csv_text(rows))
        result = comparison.compare(comparison.parse_browser(document), reference)
        self.assertTrue(result["fieldsAgree"])
        self.assertEqual(reference["originalRows"][0]["Curr"], "X")

    def test_cli_machine_readable_diff_and_exit_codes(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            browser = directory / "browser.json"
            browser.write_text(json.dumps(browser_document()))
            output = directory / "diff.json"
            command = [sys.executable, str(ROOT / "compare-pilot-reference.py"),
                       "--browser", str(browser), "--reference", str(ROOT / "fixtures/synthetic-current-reference.csv"),
                       "--reference-metadata", str(ROOT / "fixtures/synthetic-current-reference-metadata.json"),
                       "--output", str(output)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(output.read_text())
            self.assertEqual(report["inputs"]["reference"]["rows"], 2)
            self.assertEqual(len(report["inputs"]["browser"]["sha256"]), 64)
            document = browser_document()
            document["calculation"]["summaries"][0]["summary"]["establishment"] = 2
            browser.write_text(json.dumps(document))
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 1)
            self.assertEqual(subprocess.run(command + ["--tolerance", "0.5"], capture_output=True).returncode, 2)


if __name__ == "__main__":
    unittest.main()
