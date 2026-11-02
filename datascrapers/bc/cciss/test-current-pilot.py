"""Dependency-free pilot handoff tests; synthetic values are never planning data."""

import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validator = load_module("cciss_validator_test", "validate-current-pilot.py")
packer = load_module("cciss_packer_test", "pack-current-pilot.py")


def fixture(name="pilot"):
    return json.loads((ROOT / "fixtures" / f"synthetic-current-{name}.json").read_text())


class PilotValidationTests(unittest.TestCase):
    def test_artificial_fixture_is_valid_and_marked(self):
        pilot = fixture()
        self.assertEqual(validator.validate(pilot), [])
        self.assertTrue(pilot["synthetic"])
        self.assertEqual(len(pilot["dimensions"]), 32)
        self.assertEqual(len(pilot["future"]), 2)

    def test_bad_container_shapes_return_errors_instead_of_crashing(self):
        for value in (None, [], "not a document", 7):
            with self.subTest(value=value):
                self.assertTrue(validator.validate(value))
        for key in ("dimensions", "bgcCodes", *validator.SECTIONS):
            for value in ({}, [None], ["not an object"], None):
                pilot = fixture()
                pilot[key] = value
                with self.subTest(key=key, value=value):
                    self.assertTrue(validator.validate(pilot))

    def test_site_identifiers_are_unique_and_browser_safe(self):
        for ids in ([990000001, 990000001], [True], ["990000001"], [2**53], []):
            pilot = fixture()
            pilot["requestedSites"] = ids
            with self.subTest(ids=ids):
                self.assertTrue(validator.validate(pilot))

    def test_numeric_source_years_are_exact_ids_not_legacy_date_ranges(self):
        for value in (2021, 2021.0, "2021"):
            pilot = fixture()
            pilot["dimensions"][0]["futureperiod"] = value
            with self.subTest(value=value):
                self.assertEqual(validator.validate(pilot), [])
                bundle = packer.pack(pilot, fixture("provenance"))
                self.assertEqual(bundle["pilot"]["dimensions"][0]["futureperiod"], value)
        for value in (True, 2021.5, "2021_2040", "2021–2040", 1961, "1991"):
            pilot = fixture()
            pilot["dimensions"][0]["futureperiod"] = value
            with self.subTest(value=value):
                self.assertTrue(validator.validate(pilot))

    def test_array_order_and_codes_are_preserved(self):
        pilot = fixture()
        pilot["dimensions"][0]["array_ordinal"] = 2
        self.assertIn("Non-contiguous array ordinals", validator.validate(pilot))
        pilot = fixture()
        # Contiguous ordinals alone cannot establish that the source ordering
        # survived an arbitrary permutation of member records.
        pilot["dimensions"][0], pilot["dimensions"][1] = pilot["dimensions"][1], pilot["dimensions"][0]
        for index, member in enumerate(pilot["dimensions"], 1):
            member["array_ordinal"] = index
        self.assertIn("Dimensions do not preserve source array ordering", validator.validate(pilot))
        for bad_code in (True, "1", 99, {"bad": 1}):
            pilot = fixture()
            pilot["future"][0]["bgc_id"][0] = bad_code
            with self.subTest(bad_code=bad_code):
                self.assertIn("Unknown BGC code in future array", validator.validate(pilot))

    def test_missing_arrays_stay_distinct_from_invalid_values(self):
        pilot = fixture()
        pilot["future"][0]["bgc_id"][0] = None
        pilot["novelty"][0]["novelty"][0] = None
        self.assertEqual(validator.validate(pilot), [])
        for bad in (float("nan"), float("inf"), -1, True, "10"):
            pilot["novelty"][0]["novelty"][0] = bad
            with self.subTest(bad=bad):
                self.assertTrue(validator.validate(pilot))
        pilot = fixture()
        pilot["future"][0]["bgc_id"].pop()
        self.assertIn("Future array length does not match dimensions", validator.validate(pilot))

    def test_geometry_requires_closed_finite_wgs84_rings(self):
        pilot = fixture()
        original = copy.deepcopy(pilot["siteGeometry"][0]["geometry"])
        invalid = [None, {"type": "Point", "coordinates": [0, 0]},
                   {"type": "Polygon", "coordinates": [[]]}]
        for value in (181, float("nan"), True):
            malformed = copy.deepcopy(original)
            malformed["coordinates"][0][1][0] = value
            invalid.append(malformed)
        unclosed = copy.deepcopy(original)
        unclosed["coordinates"][0][-1] = [0, 0.5]
        invalid.append(unclosed)
        for geometry in invalid:
            pilot["siteGeometry"][0]["geometry"] = geometry
            with self.subTest(geometry=geometry):
                self.assertTrue(validator.validate(pilot))

    def test_sql_receipt_is_checked_against_real_dimensions(self):
        pilot = fixture()
        pilot["arrayValidation"] = [{"siteno": site, "dimensionCount": 32,
                                      "bgcArrayLength": 32, "noveltyArrayLength": 32}
                                     for site in pilot["requestedSites"]]
        self.assertEqual(validator.validate(pilot), [])
        pilot["arrayValidation"][0]["bgcArrayLength"] = 31
        self.assertIn("Array validation receipt disagrees with dimensions", validator.validate(pilot))


class PilotPackagingTests(unittest.TestCase):
    def test_repacking_keeps_every_model_member_and_exact_bytes(self):
        pilot, provenance, ecology = fixture(), fixture("provenance"), fixture("ecology")
        original = copy.deepcopy((pilot, provenance, ecology))
        bundle = packer.pack(pilot, provenance, ecology)
        self.assertEqual(bundle["pilot"]["dimensions"], pilot["dimensions"])
        self.assertEqual(bundle["pilot"]["future"], pilot["future"])
        self.assertEqual(bundle["ecology"], ecology)
        self.assertEqual((pilot, provenance, ecology), original)
        expected = (ROOT / "fixtures" / "synthetic-current-analysis.json").read_bytes()
        self.assertEqual(packer.encode(bundle), expected)
        self.assertEqual(packer.encode(bundle), packer.encode(packer.pack(*original)))

    def test_raw_pilot_can_be_packaged_without_ecology(self):
        bundle = packer.pack(fixture(), fixture("provenance"))
        self.assertNotIn("ecology", bundle)
        self.assertEqual(bundle["schema"], "cciss-current-analysis-v1")

    def test_version_match_cannot_be_assumed_and_synthetic_marker_survives(self):
        provenance = fixture("provenance")
        del provenance["versionMatched"]
        with self.assertRaisesRegex(ValueError, "explicit boolean"):
            packer.pack(fixture(), provenance)
        provenance["versionMatched"] = False
        provenance["synthetic"] = False
        bundle = packer.pack(fixture(), provenance, fixture("ecology"))
        self.assertFalse(bundle["provenance"]["versionMatched"])
        self.assertTrue(bundle["provenance"]["synthetic"])
        del provenance["ccissrCommit"]
        self.assertNotIn("ccissrCommit", packer.pack(fixture(), provenance)["provenance"])
        provenance["versionMatched"] = True
        with self.assertRaisesRegex(ValueError, "ccissrCommit"):
            packer.pack(fixture(), provenance)

    def test_known_new_suitability_schema_is_not_aliased(self):
        ecology = fixture("ecology")
        ecology["tables"]["S1"] = [{"bgc": "TESTalpha", "ss_nospace": "TESTalpha/01",
                                     "spp": "TESTa", "newfeas": 1, "outrange": False}]
        with self.assertRaisesRegex(ValueError, "missing exact source columns"):
            packer.pack(fixture(), fixture("provenance"), ecology)

    def test_source_labels_and_cartesian_order_cannot_be_inferred(self):
        pilot = fixture()
        pilot["dimensions"][0]["futureperiod"] = "2021_2040"
        with self.assertRaisesRegex(ValueError, "four-digit source"):
            packer.pack(pilot, fixture("provenance"))
        pilot = fixture()
        for row in pilot["dimensions"]:
            if row["gcm_id"] == 2:
                row["gcm"] = "TESTmodel1"
        with self.assertRaisesRegex(ValueError, "conflicting gcm"):
            packer.pack(pilot, fixture("provenance"))
        pilot = fixture()
        del pilot["observed"][0]["bgc_pred"]
        with self.assertRaisesRegex(ValueError, "original bgc_pred"):
            packer.pack(pilot, fixture("provenance"))

    def test_ecology_ratings_and_flags_require_explicit_types(self):
        for key, value in (("Feasible", True), ("Feasible", "1"), ("Feasible", 6), ("OHR", "FALSE")):
            ecology = fixture("ecology")
            ecology["tables"]["S1"][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                packer.pack(fixture(), fixture("provenance"), ecology)

    def test_integer_valued_r_numbers_and_identical_rows_are_preserved(self):
        ecology = fixture("ecology")
        ecology["tables"]["S1"][0]["Feasible"] = 1.0
        ecology["tables"]["S1"].append(copy.deepcopy(ecology["tables"]["S1"][0]))
        bundle = packer.pack(fixture(), fixture("provenance"), ecology)
        self.assertEqual(bundle["ecology"], ecology)

    def test_conflicting_ecological_attribution_and_ratings_are_rejected(self):
        ecology = fixture("ecology")
        duplicate = copy.deepcopy(ecology["tables"]["S1"][0])
        duplicate["Feasible"] = 3
        ecology["tables"]["S1"].append(duplicate)
        with self.assertRaisesRegex(ValueError, "conflicting species suitability"):
            packer.pack(fixture(), fixture("provenance"), ecology)
        ecology = fixture("ecology")
        ecology["tables"]["E1"][1]["BGC"] = "DIFFERENT"
        with self.assertRaisesRegex(ValueError, "conflicting ecological attribution"):
            packer.pack(fixture(), fixture("provenance"), ecology)

    def test_cli_is_deterministic_and_does_not_overwrite_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "bundle.json"
            command = [sys.executable, str(ROOT / "pack-current-pilot.py"),
                       "--pilot", str(ROOT / "fixtures/synthetic-current-pilot.json"),
                       "--provenance", str(ROOT / "fixtures/synthetic-current-provenance.json"),
                       "--ecology", str(ROOT / "fixtures/synthetic-current-ecology.json"),
                       "--output", str(output)]
            first = subprocess.run(command, capture_output=True, text=True, check=True)
            payload = output.read_bytes()
            second = subprocess.run(command, capture_output=True, text=True, check=True)
            self.assertEqual(payload, output.read_bytes())
            self.assertEqual(first.stdout, second.stdout)
            self.assertTrue(json.loads(first.stdout)["synthetic"])
            command[-1] = command[3]
            rejected = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("must not overwrite", rejected.stderr)

    def test_non_json_constants_and_duplicate_json_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "bad.json"
            file.write_text('{"value":NaN}')
            with self.assertRaises(ValueError):
                validator.read_json(file)
            file.write_text('{"value":1,"value":2}')
            with self.assertRaisesRegex(ValueError, "Duplicate JSON key"):
                validator.read_json(file)


if __name__ == "__main__":
    unittest.main()
