"""Compare exported browser fields with an owner-supplied Shiny CSV offline.

Exit 0 means every available, selected field agrees and there are no missing
fields; it never certifies ecological correctness or scientific parity.
Exit 1 reports differences/missing fields; exit 2 reports invalid inputs/options.
"""

import argparse
import csv
import gzip
import hashlib
import io
import json
import math
import re
import sys
from pathlib import Path

CLASSES = ("1", "2", "3", "X")
SUMMARY = {"EstabFeas": "establishment", "ccissFeas": "maturation",
           "Improve": "improve", "Decline": "decline"}
CLASS_MEASURES = {"baseline", "establishment", "maturation"}
DEFAULT_TOLERANCE = 1e-8
CSV_LIMIT = 5_000_000
JSON_LIMIT = 25_000_000
NOTE = ("Exported-field agreement only. Matching values do not independently verify "
        "the input versions, model settings, ecological interpretation, or deployed Shiny parity.")


def finite(value):
    return type(value) in (int, float) and abs(value) <= 1.7976931348623157e308 and math.isfinite(value)


def text(value, label):
    if not isinstance(value, str) or not value or len(value) > 500:
        raise ValueError(f"{label}: expected nonempty text up to 500 characters")
    return value


def number(value, label):
    if value is None or isinstance(value, str) and value.strip() in ("", "NA", "NaN"):
        return None
    if type(value) is bool:
        raise ValueError(f"{label}: expected a finite number")
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"{label}: expected a finite number") from None
    if not finite(result):
        raise ValueError(f"{label}: expected a finite number")
    return result


def suitability(value, label):
    if value == "X":
        return 4
    result = number(value, label)
    if result is None:
        return None
    if result not in (1, 2, 3, 4, 5):
        raise ValueError(f"{label}: expected source suitability class 1–5 or X")
    return int(min(result, 4))


def proportion(value, label):
    result = number(value, label)
    if result is not None and not 0 <= result <= 1:
        raise ValueError(f"{label}: expected a proportion from zero to one")
    return result


def key(site, series, species, period, measure, vote_class=None):
    return (text(str(site), "Site"), text(series, "Site series"), text(species, "Species"),
            period, measure, vote_class)


def put(records, identity, value):
    if identity in records:
        raise ValueError("Duplicate comparison key: " + json.dumps(identity))
    records[identity] = value


def parse_reference_csv(raw):
    """Preserve original period IDs/values and compare original summaries only."""
    if len(raw.encode("utf-8")) > CSV_LIMIT:
        raise ValueError("Reference CSV exceeds the 5 MB import limit")
    csv.field_size_limit(CSV_LIMIT)
    reader = csv.reader(io.StringIO(raw.lstrip("\ufeff"), newline=""))
    try:
        columns = next(reader)
    except StopIteration:
        raise ValueError("Reference CSV is empty") from None
    if len(set(columns)) != len(columns):
        raise ValueError("Duplicate reference CSV column names")
    if not {"Spp", "SS_NoSpace", "Curr"} <= set(columns):
        raise ValueError("Expected Shiny CSV columns Spp, SS_NoSpace and Curr")
    long = "FuturePeriod" in columns and set(CLASSES) <= set(columns)
    periods = set()
    if not long:
        periods = {match.group(1) for column in columns if (match := re.fullmatch(r"1_([0-9]{4})", column))}
        if not periods:
            raise ValueError("Reference CSV has no supported period vote columns")
    records = {}
    originals = []
    grouped = {}
    for index, values in enumerate(reader, 1):
        if index > 50_000:
            raise ValueError("Reference CSV exceeds 50,000 rows")
        if len(values) != len(columns):
            raise ValueError(f"Reference CSV row {index}: field count does not match header")
        row = dict(zip(columns, values))
        originals.append(row)
        site = row.get("SiteRef") or row.get("SiteNo")
        if not site:
            raise ValueError(f"Reference CSV row {index}: missing SiteRef or SiteNo")
        series, species = text(row["SS_NoSpace"], "Site series"), text(row["Spp"], "Species")
        group = (site, series, species)
        baseline = suitability(row["Curr"], "Curr")
        if group in grouped and (not long or grouped[group] != baseline):
            raise ValueError("Duplicate or inconsistent reference species rows")
        if group not in grouped:
            put(records, key(*group, None, "baseline"), baseline)
            grouped[group] = baseline
            for column, measure in SUMMARY.items():
                value = row.get(column)
                if measure in CLASS_MEASURES:
                    parsed = suitability(value, column)
                else:
                    parsed = number(value, column)
                    if parsed is not None:
                        if not 0 <= parsed <= 100:
                            raise ValueError(f"{column}: expected an original percentage from zero to 100")
                        parsed /= 100
                put(records, key(*group, None, measure), parsed)
        else:
            for column, measure in SUMMARY.items():
                value = row.get(column)
                parsed = suitability(value, column) if measure in CLASS_MEASURES else number(value, column)
                if measure not in CLASS_MEASURES and parsed is not None:
                    parsed /= 100
                if records[key(*group, None, measure)] != parsed:
                    raise ValueError("Inconsistent original summary values across long-form reference rows")
        row_periods = [row["FuturePeriod"]] if long else sorted(periods)
        for period in row_periods:
            if not re.fullmatch(r"[0-9]{4}", period):
                raise ValueError("Reference period IDs must be four digits; no date-range mapping is performed")
            periods.add(period)
            suffix = "" if long else "_" + period
            votes = [proportion(row.get(vote_class + suffix), "Vote") for vote_class in CLASSES]
            novelty = proportion(row.get("NOV" + suffix), "Novelty")
            if all(value is not None for value in votes):
                total = sum(votes) + (novelty or 0)
                if any(votes) and abs(total - 1) > 0.021:
                    raise ValueError("Reference vote proportions do not sum to one")
            for vote_class, value in zip(CLASSES, votes):
                put(records, key(*group, period, "vote", vote_class), value)
            put(records, key(*group, period, "novelty"), novelty)
    if not originals:
        raise ValueError("Reference CSV is empty")
    # The browser's Shiny report retains a global period roster. An absent
    # species-period row is explicit missing evidence, not an omitted field.
    for group in grouped:
        for period in periods:
            for vote_class in CLASSES:
                records.setdefault(key(*group, period, "vote", vote_class), None)
            records.setdefault(key(*group, period, "novelty"), None)
    return {"records": records, "periods": sorted(periods), "format": "historical-raw" if long else "current-export",
            "columns": columns, "originalRows": originals}


def parse_browser(document):
    if not isinstance(document, dict):
        raise ValueError("Browser assessment JSON must be an object")
    metadata = {}
    settings = None
    if document.get("schema") == "cciss-current-analysis-report-v1":
        assessment = document.get("calculation")
        metadata = document.get("provenance") or {}
        settings = document.get("selection")
    elif all(name in document for name in ("siteId", "species", "summaries", "capabilities", "provenance")):
        assessment = document
    else:
        raise ValueError("Expected exported cciss-current-analysis-report-v1 or a current assessment object")
    if not isinstance(assessment, dict):
        raise ValueError("Browser report is missing its numeric calculation object")
    if not isinstance(assessment.get("species"), list) or not isinstance(assessment.get("summaries"), list):
        raise ValueError("Browser calculation must include species and original calculated summaries arrays")
    if not metadata:
        metadata = assessment.get("provenance") or {}
    if not isinstance(metadata, dict):
        raise ValueError("Browser provenance must be an object")
    if settings is not None and not isinstance(settings, dict):
        raise ValueError("Browser selection/settings must be an object")
    site_id = assessment.get("siteId")
    if site_id is None or type(site_id) not in (str, int):
        raise ValueError("Browser calculation needs its exact siteId")
    records = {}
    summaries = {}
    for row in assessment["summaries"]:
        if not isinstance(row, dict):
            raise ValueError("Browser summary rows must be objects")
        species = text(row.get("species"), "Summary species")
        if species in summaries:
            raise ValueError("Duplicate browser species summaries")
        summary = row.get("summary")
        if summary is not None and not isinstance(summary, dict):
            raise ValueError("Browser summary must be an object or null")
        summaries[species] = summary
    periods = set()
    for row in assessment["species"]:
        if not isinstance(row, dict):
            raise ValueError("Browser species rows must be objects")
        group = (row.get("site"), row.get("series"), row.get("species"))
        if group[0] is None:
            raise ValueError("Browser species row needs its exact site ID")
        put(records, key(*group, None, "baseline"), suitability(row.get("current"), "Browser baseline"))
        votes = row.get("votes")
        novelty = row.get("novelty")
        if not isinstance(votes, dict) or not isinstance(novelty, dict):
            raise ValueError("Browser species votes and novelty must be period-keyed objects")
        for period in sorted(set(votes) | set(novelty)):
            if not re.fullmatch(r"[0-9]{4}", period):
                raise ValueError("Browser period IDs must retain four digits")
            periods.add(period)
            values = votes.get(period)
            if values is not None and (not isinstance(values, list) or len(values) != 4):
                raise ValueError("Browser votes must contain four class proportions or null")
            for index, vote_class in enumerate(CLASSES):
                value = proportion(values[index] if values is not None else None, "Browser vote")
                put(records, key(*group, period, "vote", vote_class), value)
            put(records, key(*group, period, "novelty"), proportion(novelty.get(period), "Browser novelty"))
        summary = summaries.get(row["species"])
        for measure in SUMMARY.values():
            value = summary.get(measure) if summary else None
            if measure in CLASS_MEASURES:
                value = suitability(value, "Browser " + measure)
            else:
                value = number(value, "Browser " + measure)
                if value is not None:
                    if not 0 <= value <= 100:
                        raise ValueError("Browser improving/declining summaries must be source percentages")
                    value /= 100
            put(records, key(*group, None, measure), value)
    return {"records": records, "periods": sorted(periods), "metadata": metadata, "settings": settings,
            "siteId": str(site_id), "series": assessment.get("series")}


def compare(browser, reference, tolerance=DEFAULT_TOLERANCE, reference_metadata=None, site=None, series=None,
            reference_site=None, confirm_site_alias=False):
    if not finite(tolerance) or not 0 <= tolerance <= 0.01:
        raise ValueError("Absolute probability tolerance must be between zero and 0.01")
    if reference_metadata is not None and not isinstance(reference_metadata, dict):
        raise ValueError("Reference metadata must be a JSON object")
    if type(confirm_site_alias) is not bool:
        raise ValueError("Site alias confirmation must be an explicit boolean")
    if confirm_site_alias and reference_site is None:
        raise ValueError("Confirming a site alias requires --reference-site")
    reference_records = reference["records"]
    if reference_site is not None:
        reference_records = {identity: value for identity, value in reference_records.items()
                             if identity[0] == reference_site}
        if not reference_records:
            raise ValueError("Selected reference site identifier is not present in the CSV")
    raw_reference_sites = {identity: identity[0] for identity in reference_records}
    alias_applied = False
    if confirm_site_alias:
        browser_site = browser["siteId"]
        if any(identity[0] != browser_site for identity in browser["records"]):
            raise ValueError("Browser species rows do not all belong to its declared siteId")
        aligned = {}
        raw_reference_sites = {}
        for identity, value in reference_records.items():
            mapped = (browser_site,) + identity[1:]
            put(aligned, mapped, value)
            raw_reference_sites[mapped] = identity[0]
        reference_records = aligned
        alias_applied = reference_site != browser_site
    identities = set(browser["records"]) | set(reference_records)
    if site is not None:
        identities = {identity for identity in identities if identity[0] == site}
    if series is not None:
        identities = {identity for identity in identities if identity[1] == series}
    counts = dict.fromkeys(("matched", "withinTolerance", "different", "missingBrowser", "missingReference", "bothMissing"), 0)
    rows = []
    maxima = {}
    for identity in sorted(identities, key=lambda value: json.dumps(value, ensure_ascii=False)):
        actual = browser["records"].get(identity)
        expected = reference_records.get(identity)
        measure = identity[4]
        difference = None
        if actual is None and expected is None:
            status, count = "both-missing", "bothMissing"
        elif actual is None:
            status, count = "browser-missing", "missingBrowser"
        elif expected is None:
            status, count = "reference-missing", "missingReference"
        else:
            difference = actual - expected
            limit = 0 if measure in CLASS_MEASURES else tolerance
            status, count = ("within-tolerance", "withinTolerance") if abs(difference) <= limit else ("different", "different")
            counts["matched"] += 1
            maxima[measure] = max(maxima.get(measure) or 0, abs(difference))
        counts[count] += 1
        maxima.setdefault(measure, None)
        rows.append(dict(zip(("site", "series", "species", "period", "measure", "class"), identity)) |
                    {"key": json.dumps(identity, ensure_ascii=False, separators=(",", ":")),
                     "referenceSite": raw_reference_sites.get(identity),
                     "browser": actual, "reference": expected, "difference": difference, "status": status,
                     "unit": "class" if measure in CLASS_MEASURES else "probability"})
    agreed = counts["withinTolerance"]
    complete = bool(agreed) and agreed == len(rows)
    warnings = [NOTE]
    reference_metadata = reference_metadata or {}
    version_checks = []
    for name in ("datasetVersion", "ccissrCommit", "shinyCommit"):
        a, b = browser["metadata"].get(name), reference_metadata.get(name)
        version_checks.append({"field": name, "browser": a, "reference": b,
                               "status": "missing" if a is None or b is None else "matched" if a == b else "different"})
    a, b = browser.get("settings"), reference_metadata.get("settings")
    version_checks.append({"field": "settings", "browser": a, "reference": b,
                           "status": "missing" if a is None or b is None else "matched" if a == b else "different"})
    context_matches = all(check["status"] == "matched" for check in version_checks)
    if not context_matches:
        warnings.append("Reference input versions/settings are missing or differ; matching field values do not establish matching analysis contexts.")
    if reference_metadata.get("synthetic") is True or browser["metadata"].get("synthetic") is True:
        warnings.append("Synthetic regression inputs are present. This comparison cannot validate a real site or deployed Shiny run.")
    if confirm_site_alias:
        warnings.append("A user-confirmed reference site alias was applied. The site mapping and analysis settings have not been independently verified; site-series identifiers remain exact.")
    if not agreed and not counts["different"]:
        warnings.append("No paired numeric fields are available under the selected exact identifiers.")
    return {"schema": "cciss-shiny-reference-comparison-v1", "comparisonKind": "exported-field-agreement",
            "tolerance": tolerance, "classTolerance": 0, "fieldsAgree": complete,
            "scientificParityVerified": False, "inputContextMatches": context_matches,
            "selection": {"site": site, "series": series}, "counts": counts,
            "alignment": {"browserSite": browser["siteId"], "referenceSite": reference_site,
                          "browserSeries": browser["series"], "referenceSeries": series,
                          "siteMappingConfirmed": confirm_site_alias, "aliasApplied": alias_applied},
            "maxAbsDifferenceByMeasure": maxima, "metadataChecks": version_checks,
            "referenceMetadata": reference_metadata, "browserMetadata": browser["metadata"],
            "browserPeriods": browser["periods"], "referencePeriods": reference["periods"],
            "warnings": warnings, "rows": rows}


def read_bytes(path, limit):
    with (gzip.open(path, "rb") if path.suffix == ".gz" else path.open("rb")) as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"{path.name}: input exceeds {limit:,} bytes after decompression")
    return data


def read_json(data):
    def constant(value):
        raise ValueError("Non-JSON numeric constant: " + value)

    def unique(pairs):
        result = {}
        for name, value in pairs:
            if name in result:
                raise ValueError("Duplicate JSON key: " + name)
            result[name] = value
        return result

    return json.loads(data.decode("utf-8-sig"), parse_constant=constant, object_pairs_hook=unique)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", type=Path, required=True, help="Browser assessment JSON export")
    parser.add_argument("--reference", type=Path, required=True, help="Original Shiny CSV, optionally gzip compressed")
    parser.add_argument("--reference-metadata", type=Path)
    parser.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE)
    parser.add_argument("--site", help="Optional exact site identifier filter; no implicit ID mapping")
    parser.add_argument("--series", help="Optional exact site-series filter")
    parser.add_argument("--reference-site", help="Select an exact original CSV SiteRef/SiteNo")
    parser.add_argument("--confirm-site-alias", action="store_true",
                        help="Explicitly assert the selected reference site is the browser site; never maps series")
    parser.add_argument("--output", type=Path, help="Machine-readable diff JSON; defaults to stdout")
    args = parser.parse_args()
    try:
        paths = [args.browser, args.reference] + ([args.reference_metadata] if args.reference_metadata else [])
        if args.output and args.output.resolve() in {path.resolve() for path in paths}:
            raise ValueError("Output must not overwrite an input")
        actual = read_bytes(args.browser, JSON_LIMIT)
        expected = read_bytes(args.reference, CSV_LIMIT)
        browser = parse_browser(read_json(actual))
        reference = parse_reference_csv(expected.decode("utf-8-sig"))
        metadata = read_json(read_bytes(args.reference_metadata, 1_000_000)) if args.reference_metadata else None
        result = compare(browser, reference, args.tolerance, metadata, args.site, args.series,
                         args.reference_site, args.confirm_site_alias)
        result["inputs"] = {
            "browser": {"filename": args.browser.name, "bytes": len(actual), "sha256": hashlib.sha256(actual).hexdigest()},
            "reference": {"filename": args.reference.name, "bytes": len(expected), "sha256": hashlib.sha256(expected).hexdigest(),
                          "format": reference["format"], "columns": reference["columns"], "rows": len(reference["originalRows"])},
        }
        payload = json.dumps(result, ensure_ascii=False, allow_nan=False, sort_keys=True, indent=2) + "\n"
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(payload, encoding="utf-8")
            print(json.dumps({"fieldsAgree": result["fieldsAgree"], "counts": result["counts"],
                              "output": str(args.output), "scientificParityVerified": False}))
        else:
            print(payload, end="")
    except (OSError, ValueError, TypeError, csv.Error) as error:
        parser.exit(2, f"Cannot compare reference:\n{error}\n")
    return 0 if result["fieldsAgree"] else 1


if __name__ == "__main__":
    sys.exit(main())
