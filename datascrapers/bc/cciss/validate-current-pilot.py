"""Structural checks for an owner-supplied CCISS pilot, without database access.

These checks do not certify ecological correctness, model versions, or parity
with Shiny. Null prediction/novelty members are retained as missing.
"""

import argparse
import json
import math
import re
from pathlib import Path

DIMENSION_KEYS = ("gcm_id", "scenario_id", "futureperiod_id", "run_id")
SECTIONS = ("future", "observed", "novelty", "attribution", "siteGeometry")


def integer(value):
    return type(value) is int and abs(value) <= 9_007_199_254_740_991


def finite(value):
    return (type(value) in (int, float)
            and abs(value) <= 1.7976931348623157e308
            and math.isfinite(value))


def source_period(value):
    """SQL integer years and their exact text form are the same source ID."""
    if finite(value) and abs(value) <= 9_007_199_254_740_991 and value == int(value):
        value = str(int(value))
    return value if isinstance(value, str) and re.fullmatch(r"[0-9]{4}", value) else None


def polygon_coordinates(coordinates):
    if not isinstance(coordinates, list) or not coordinates:
        return False
    for ring in coordinates:
        if not isinstance(ring, list) or len(ring) < 4:
            return False
        for point in ring:
            if not isinstance(point, list) or len(point) not in (2, 3):
                return False
            if not all(finite(value) for value in point):
                return False
            if not -180 <= point[0] <= 180 or not -90 <= point[1] <= 90:
                return False
        if ring[0] != ring[-1]:
            return False
    return True


def valid_geometry(geometry):
    if not isinstance(geometry, dict):
        return False
    coordinates = geometry.get("coordinates")
    if geometry.get("type") == "Polygon":
        return polygon_coordinates(coordinates)
    if geometry.get("type") == "MultiPolygon":
        return (
            isinstance(coordinates, list)
            and bool(coordinates)
            and all(polygon_coordinates(polygon) for polygon in coordinates)
        )
    return False


def object_rows(document, key, errors):
    rows = document.get(key)
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        errors.append(f"{key}: expected an array of objects")
        return []
    return rows


def validate(document):
    errors = []
    if not isinstance(document, dict):
        return ["Expected a JSON object"]
    if document.get("schema") != "cciss-current-pilot-v1":
        errors.append("Unexpected schema")
    if document.get("requestValid") is not True:
        errors.append("Export request was not valid")
    if "synthetic" in document and type(document["synthetic"]) is not bool:
        errors.append("Pilot synthetic marker must be boolean")
    ids = document.get("requestedSites")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 25 or not all(map(integer, ids)):
        errors.append("Expected 1–25 integer requested site IDs")
        return errors
    if len(set(ids)) != len(ids):
        errors.append("Duplicate requested site IDs")
    wanted = set(ids)

    dimensions = object_rows(document, "dimensions", errors)
    if not dimensions:
        errors.append("Missing model dimensions")
    ordinals = [row.get("array_ordinal") for row in dimensions]
    if not all(map(integer, ordinals)) or ordinals != list(range(1, len(dimensions) + 1)):
        errors.append("Non-contiguous array ordinals")
    keys = [tuple(row.get(key) for key in DIMENSION_KEYS) for row in dimensions]
    if any(not all(map(integer, key)) for key in keys):
        errors.append("Missing or duplicate dimension IDs")
    elif len(set(keys)) != len(keys):
        errors.append("Missing or duplicate dimension IDs")
    elif keys != sorted(keys):
        errors.append("Dimensions do not preserve source array ordering")
    for row in dimensions:
        if "futureperiod" in row:
            period = source_period(row["futureperiod"])
            if period is None:
                errors.append("Future periods must retain four-digit source IDs")
            elif period in ("1961", "1991"):
                errors.append("Future dimensions cannot reuse baseline or observed period IDs")

    codes = object_rows(document, "bgcCodes", errors)
    code_ids = [row.get("bgc_id") for row in codes]
    if not codes or not all(map(integer, code_ids)) or len(set(code_ids)) != len(codes):
        errors.append("Invalid BGC codebook")
    valid_codes = {code for code in code_ids if integer(code)}

    sections = {}
    for section in SECTIONS:
        rows = object_rows(document, section, errors)
        sections[section] = rows
        got = [row.get("siteno") for row in rows]
        if not all(map(integer, got)) or set(got) != wanted or len(got) != len(wanted):
            errors.append(f"{section}: missing, duplicate or unexpected sites")
    for row in sections["future"]:
        values = row.get("bgc_id")
        if not isinstance(values, list) or len(values) != len(dimensions):
            errors.append("Future array length does not match dimensions")
            continue
        if any(value is not None and (not integer(value) or value not in valid_codes) for value in values):
            errors.append("Unknown BGC code in future array")
    for row in sections["novelty"]:
        values = row.get("novelty")
        if not isinstance(values, list) or len(values) != len(dimensions):
            errors.append("Novelty array length does not match dimensions")
        elif any(value is not None and (not finite(value) or value < 0) for value in values):
            errors.append("Novelty members must be finite nonnegative numbers or null")
    for row in sections["siteGeometry"]:
        if not valid_geometry(row.get("geometry")):
            errors.append("Missing or invalid WGS84 polygon for site lookup")

    # Validate the SQL receipt when present, without requiring it from older
    # pilots. Never trust receipts instead of checking the actual arrays.
    if "arrayValidation" in document:
        receipts = object_rows(document, "arrayValidation", errors)
        got = [row.get("siteno") for row in receipts]
        if not all(map(integer, got)) or set(got) != wanted or len(got) != len(wanted):
            errors.append("arrayValidation: missing, duplicate or unexpected sites")
        for row in receipts:
            if any(not integer(row.get(key)) or row[key] != len(dimensions)
                   for key in ("bgcArrayLength", "noveltyArrayLength", "dimensionCount")):
                errors.append("Array validation receipt disagrees with dimensions")
    return list(dict.fromkeys(errors))


def read_json(path):
    def invalid_constant(value):
        raise ValueError(f"Non-JSON numeric constant: {value}")

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result

    return json.loads(path.read_text(encoding="utf-8-sig"), parse_constant=invalid_constant,
                      object_pairs_hook=unique_object)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    args = parser.parse_args()
    try:
        errors = validate(read_json(args.file))
    except (OSError, ValueError) as error:
        errors = [str(error)]
    print(json.dumps({
        "structurallyValid": not errors,
        "errors": errors,
        "note": "Passing this structural gate does not confirm deployed version or ecological correctness.",
    }, indent=2))
    raise SystemExit(1 if errors else 0)
