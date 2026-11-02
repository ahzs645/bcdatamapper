"""Pack authorized pilot data for the browser, without contacting a database.

Input labels, arrays, ordinals and ecological values are preserved. A version
match is the provider's explicit assertion, not something this packer certifies.
The known public development S1 schema is intentionally not guessed/aliased.
"""

import argparse
import copy
import hashlib
import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("cciss_pilot_validator", ROOT / "validate-current-pilot.py")
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


def nonempty(value):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= 500


def validate_browser_pilot(pilot):
    """Check the explicit source columns consumed by the browser contract."""
    errors = []
    dimensions = pilot["dimensions"]
    if len(dimensions) > 50_000:
        errors.append("Model dimensions exceed the browser's 50,000-member pilot limit")
    labels = {name: {} for name in ("gcm", "scenario", "futureperiod", "run")}
    for index, row in enumerate(dimensions, 1):
        for name, id_column in zip(labels, validator.DIMENSION_KEYS):
            label = row.get(name)
            if name == "futureperiod":
                label = validator.source_period(label)
            if not nonempty(label):
                errors.append(f"Dimension {index}: missing string source label {name}")
                continue
            seen = labels[name]
            dimension_id = row[id_column]
            if (dimension_id in seen and seen[dimension_id] != label
                    or label in seen.values() and seen.get(dimension_id) != label):
                errors.append(f"Dimension {index}: conflicting {name} ID/label mapping")
            seen[dimension_id] = label
        period = validator.source_period(row.get("futureperiod"))
        if period is None:
            errors.append(f"Dimension {index}: retain the four-digit source futureperiod ID")
    cartesian_size = 1
    for mapping in labels.values():
        cartesian_size *= len(mapping)
    if cartesian_size != len(dimensions):
        errors.append("Dimensions must preserve the complete source Cartesian index")
    for name, maximum in (("gcm", 128), ("scenario", 32), ("futureperiod", 64), ("run", 256)):
        if len(labels[name]) > maximum:
            errors.append(f"Pilot exceeds the browser's {maximum} {name} choices")
    if len(pilot["bgcCodes"]) > 10_000:
        errors.append("BGC codebook exceeds the browser's 10,000-row limit")
    for row in pilot["bgcCodes"]:
        if not nonempty(row.get("bgc")):
            errors.append("BGC codebook needs its original bgc string labels")
    for row in pilot["attribution"]:
        if not nonempty(row.get("bgc")):
            errors.append("Attribution needs its original bgc string column")
    for row in pilot["observed"]:
        if "bgc_pred" not in row or row["bgc_pred"] is not None and not nonempty(row["bgc_pred"]):
            errors.append("Observations need the original bgc_pred column (string or null)")
    return list(dict.fromkeys(errors))


def validate_provenance(provenance):
    if not isinstance(provenance, dict):
        return ["Provenance must be a JSON object"]
    errors = []
    for key in ("datasetVersion", "source"):
        if not nonempty(provenance.get(key)):
            errors.append(f"Provenance needs an explicit {key}")
    for key in ("ccissrCommit", "shinyCommit"):
        if key in provenance or key == "ccissrCommit" and provenance.get("versionMatched") is True:
            value = provenance.get(key)
            if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", value):
                errors.append(f"Provenance {key} must be a full 40-character commit")
    if type(provenance.get("versionMatched")) is not bool:
        errors.append("Provenance needs an explicit boolean versionMatched assertion")
    if "synthetic" in provenance and type(provenance["synthetic"]) is not bool:
        errors.append("Provenance synthetic marker must be boolean")
    return errors


def validate_ecology(ecology):
    if not isinstance(ecology, dict) or ecology.get("schema") != "cciss-ecology-v1":
        return ["Expected cciss-ecology-v1 ecological attachment"]
    tables = ecology.get("tables")
    if not isinstance(tables, dict):
        return ["Ecology tables must be an object of named row arrays"]
    errors = []
    attribution = {}
    suitability = {}
    for name in ("E1", "E1_Phase", "S1"):
        rows = tables.get(name)
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            errors.append(f"{name}: expected an array of objects")
            continue
        if name != "E1_Phase" and not rows:
            errors.append(f"{name}: table cannot be empty")
        if len(rows) > 200_000:
            errors.append(f"{name}: exceeds the browser's 200,000-row table limit")
        required = ("BGC", "SS_NoSpace", "Spp", "Feasible") if name == "S1" else (
            "BGC", "SS_NoSpace", "Edatopic", "SpecialCode"
        )
        if name == "E1_Phase":
            required += ("MainUnit",)
        for number, row in enumerate(rows, 1):
            if any(key not in row for key in required):
                errors.append(f"{name} row {number}: missing exact source columns {', '.join(required)}")
                continue
            strings = ("BGC", "SS_NoSpace", "Spp") if name == "S1" else (
                "BGC", "SS_NoSpace", "Edatopic"
            )
            if name == "E1_Phase":
                strings += ("MainUnit",)
            if any(not nonempty(row[key]) for key in strings):
                errors.append(f"{name} row {number}: empty or non-string source label")
            if name == "S1":
                if not validator.finite(row["Feasible"]) or row["Feasible"] not in (1, 2, 3, 4, 5):
                    errors.append(f"S1 row {number}: Feasible must be an integer rating 1–5")
                if "OHR" in row and type(row["OHR"]) is not bool:
                    errors.append(f"S1 row {number}: OHR must be boolean when supplied")
                if (nonempty(row["SS_NoSpace"]) and nonempty(row["Spp"])
                        and ("OHR" not in row or type(row["OHR"]) is bool)):
                    key = (row["SS_NoSpace"], row["Spp"], row.get("OHR"))
                    if key in suitability and suitability[key] != row["Feasible"]:
                        errors.append(f"S1 row {number}: conflicting species suitability rows")
                    suitability[key] = row["Feasible"]
            elif row["SpecialCode"] is not None and not nonempty(row["SpecialCode"]):
                errors.append(f"{name} row {number}: SpecialCode must be a nonempty string or null")
            elif nonempty(row["SS_NoSpace"]):
                key = row["SS_NoSpace"]
                value = (row["BGC"], row["SpecialCode"])
                if key in attribution and attribution[key] != value:
                    errors.append(f"{name} row {number}: conflicting ecological attribution")
                attribution[key] = value
    return errors


def pack(pilot, provenance, ecology=None):
    pilot_errors = validator.validate(pilot)
    errors = pilot_errors + validate_provenance(provenance)
    if not pilot_errors:
        errors += validate_browser_pilot(pilot)
    if ecology is not None:
        errors += validate_ecology(ecology)
    if errors:
        raise ValueError("\n".join(errors))
    provenance = copy.deepcopy(provenance)
    if pilot.get("synthetic") is True:
        provenance["synthetic"] = True
    bundle = {
        "schema": "cciss-current-analysis-v1",
        "pilot": copy.deepcopy(pilot),
        "provenance": provenance,
    }
    if ecology is not None:
        bundle["ecology"] = copy.deepcopy(ecology)
    return bundle


def encode(bundle):
    # Stable key order and no timestamp injection: identical input yields the
    # same bytes. Array order is scientifically significant and never sorted.
    return (json.dumps(bundle, ensure_ascii=False, sort_keys=True, allow_nan=False,
                       separators=(",", ":")) + "\n").encode("utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pilot", type=Path, required=True)
    parser.add_argument("--provenance", type=Path, required=True)
    parser.add_argument("--ecology", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        inputs = [args.pilot, args.provenance] + ([args.ecology] if args.ecology else [])
        if args.output.resolve() in {path.resolve() for path in inputs}:
            raise ValueError("Output must not overwrite an input file")
        pilot = validator.read_json(args.pilot)
        provenance = validator.read_json(args.provenance)
        ecology = validator.read_json(args.ecology) if args.ecology else None
        bundle = pack(pilot, provenance, ecology)
        payload = encode(bundle)
        if len(payload) > 25_000_000:
            raise ValueError("Bundle exceeds the browser's 25 MB pilot limit; request a smaller pilot")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(payload)
    except (OSError, ValueError, TypeError) as error:
        parser.exit(1, f"Cannot package pilot:\n{error}\n")
    print(json.dumps({
        "schema": bundle["schema"],
        "sites": len(pilot["requestedSites"]),
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "synthetic": bundle["provenance"].get("synthetic", False),
        "ecologicalAttachment": ecology is not None,
        "providerAssertsVersionMatch": provenance["versionMatched"],
        "note": "Structural packaging does not establish ecological correctness or Shiny parity.",
    }))


if __name__ == "__main__":
    main()
