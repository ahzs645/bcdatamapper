#!/usr/bin/env python3

"""Build a deterministic, calculation-ready BC EnviroScreen release.

The heavy acquisition and candidate-selection stages stay separate. This
builder consumes the normalized hybrid score table, validates its scientific
contract, joins stable LHA codes, and emits only compact public artifacts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
VENDOR_ROOT = SCRIPT_DIR.parents[1]
PGMAPS_ROOT = Path(os.environ.get("PGMAPS_ROOT", SCRIPT_DIR.parents[3])).resolve()
PACKAGE_DIR = SCRIPT_DIR / "bcenviroscreen"
DEFAULT_SCORE_INPUT = (
    SCRIPT_DIR
    / "output"
    / "bc-enviro-screen"
    / "rebuilt-scores"
    / "hybrid-best-current-with-shiny-gaps"
    / "lha-score-rebuild.json"
)
DEFAULT_VALIDATION_INPUT = (
    SCRIPT_DIR
    / "output"
    / "bc-enviro-screen"
    / "rebuilt-scores"
    / "hybrid-best-current-with-shiny-gaps"
    / "score-comparison-summary.json"
)
DEFAULT_BOUNDARY_INPUT = PGMAPS_ROOT / "public" / "data" / "boundaries" / "BCMoH" / "local_health_areas.json"
DEFAULT_OUTPUT_ROOT = SCRIPT_DIR / "output" / "bc-enviro-screen" / "release"
PUBLIC_BASE = "https://data.map.ahmad.sh/environmental-burden/bc-enviro-screen"
PREFERRED_HYPERTENSION_FIELD = (
    "phsa_general_health_hypertension_age_standardized_incidence_rate_per_1000_population_20plus_yrs_"
    "fy_2015_2016_per_1000_population"
)
SCORE_FIELDS = [
    "exposures",
    "environmental_effects",
    "sensitive_populations",
    "socioeconomic_factors",
    "landscape_burden_score",
    "population_characteristics_score",
    "overall_score",
]


def read_json(path: Path):
    if not path.exists():
        raise SystemExit(f"Required input is missing: {path}")
    return json.loads(path.read_text())


def canonical_bytes(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_bytes(value))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_name(value: str) -> str:
    return "".join(character.lower() for character in value.strip() if character.isalnum())


def load_boundary_codes(path: Path) -> dict[str, dict[str, str]]:
    collection = read_json(path)
    features = collection.get("features", [])
    if len(features) != 89:
        raise SystemExit(f"Expected 89 LHA boundary features, found {len(features)}")
    result = {}
    for feature in features:
        properties = feature.get("properties") or {}
        name = str(properties.get("LOCAL_HLTH_AREA_NAME") or "").strip()
        code = str(properties.get("LOCAL_HLTH_AREA_CODE") or "").strip()
        if not name or not code:
            raise SystemExit("Boundary feature is missing LOCAL_HLTH_AREA_NAME or LOCAL_HLTH_AREA_CODE")
        key = normalize_name(name)
        if key in result:
            raise SystemExit(f"Duplicate normalized boundary name: {name}")
        result[key] = {"lha_code": code, "lha_name": name}
    return result


def git_commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(VENDOR_ROOT), "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def parse_generated_at(value: str | None) -> str:
    if value:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    elif os.environ.get("SOURCE_DATE_EPOCH"):
        parsed = datetime.fromtimestamp(int(os.environ["SOURCE_DATE_EPOCH"]), timezone.utc)
    else:
        parsed = datetime.now(timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def source_status(default_status: str, source_key: str | None, missing: bool) -> str:
    if missing:
        return "missing"
    if not source_key or "shiny" in source_key.lower():
        return "benchmark-gap"
    return default_status


def build_release(args: argparse.Namespace) -> tuple[Path, dict]:
    generated_at = parse_generated_at(args.generated_at)
    score_rows = read_json(args.score_input)
    definitions_document = read_json(args.indicators)
    source_selection = read_json(args.source_selection)
    selected_sources = source_selection.get("selected", {})
    definitions = definitions_document.get("indicators", [])
    if len(definitions) != 21:
        raise SystemExit(f"Expected 21 indicator definitions, found {len(definitions)}")
    indicator_keys = [definition["key"] for definition in definitions]
    if len(set(indicator_keys)) != 21:
        raise SystemExit("Indicator keys must be unique")
    if len(score_rows) != 89:
        raise SystemExit(f"Expected 89 normalized LHA rows, found {len(score_rows)}")

    boundary_by_name = load_boundary_codes(args.boundary)
    lha_rows = []
    score_output_rows = []
    seen_codes = set()
    source_keys_by_indicator = {key: set() for key in indicator_keys}
    benchmark_gap_indicators = set()

    for source_row in sorted(score_rows, key=lambda row: normalize_name(str(row.get("lha_name", "")))):
        source_name = str(source_row.get("lha_name") or "").strip()
        boundary = boundary_by_name.get(normalize_name(source_name))
        if not boundary:
            raise SystemExit(f"Could not join score row to LHA boundary by name: {source_name!r}")
        code = boundary["lha_code"]
        if code in seen_codes:
            raise SystemExit(f"Duplicate LHA code after boundary join: {code}")
        seen_codes.add(code)

        indicators = {}
        for definition in definitions:
            key = definition["key"]
            value = source_row.get(key)
            percentile = source_row.get(f"{key}_percentile")
            source_key = source_row.get(f"{key}_input_source")
            missing = value is None
            status = source_status(definition["sourceStatus"], source_key, missing)
            expected_source = selected_sources.get(key)
            if source_key and status not in {"benchmark-gap", "missing"} and expected_source and source_key != expected_source:
                raise SystemExit(
                    f"Selected source mismatch for {key} in {source_name}: expected {expected_source}, found {source_key}"
                )
            if status == "benchmark-gap":
                benchmark_gap_indicators.add(key)
            if source_key:
                source_keys_by_indicator[key].add(str(source_key))
            indicators[key] = {
                "value": value,
                "percentile": percentile,
                "sourceKey": source_key,
                "sourceStatus": status,
                "missing": missing,
            }

        hypertension_source = str(indicators["hypertension"].get("sourceKey") or "")
        if PREFERRED_HYPERTENSION_FIELD not in hypertension_source:
            raise SystemExit(
                "Hypertension must use the total-population FY2015/16 incidence field; "
                f"found {hypertension_source or 'no source key'} for {source_name}"
            )

        lha_rows.append({**boundary, "indicators": indicators})
        scores = {field: source_row.get(field) for field in SCORE_FIELDS}
        score_output_rows.append({**boundary, **scores})

    if len(seen_codes) != 89:
        raise SystemExit(f"Expected 89 unique LHA codes, found {len(seen_codes)}")

    scientific_payload = {
        "methodVersion": "bcenviroscreen-reconstruction-v1",
        "definitions": definitions,
        "sourceSelection": source_selection,
        "lhaRows": lha_rows,
        "scores": score_output_rows,
    }
    release_hash = sha256_bytes(canonical_bytes(scientific_payload))[:12]
    release_date = generated_at[:10]
    release_id = args.release_id or f"v{release_date}-{release_hash}"
    release_dir = args.output_root / release_id

    components = {}
    for definition in definitions:
        components.setdefault(definition["component"], []).append(definition["key"])
    index_definition = {
        "schemaVersion": 1,
        "releaseId": release_id,
        "indexId": "bc-enviro-screen-reconstruction",
        "label": "BC EnviroScreen Reconstruction",
        "status": "hybrid-reconstruction",
        "scoreRange": [0, 100],
        "comparisonUniverse": "all-89-bc-lhas",
        "ranking": {
            "method": "one-based-percentile-rank",
            "ties": "average",
            "zeroValue": 0,
            "missing": "exclude-from-component-mean",
        },
        "components": {
            "exposures": {"weight": 1, "indicators": components["exposures"]},
            "environmental_effects": {"weight": 0.5, "indicators": components["environmental_effects"]},
            "sensitive_populations": {"weight": 1, "indicators": components["sensitive_populations"]},
            "socioeconomic_factors": {"weight": 1, "indicators": components["socioeconomic_factors"]},
        },
        "formula": {
            "population": "mean(sensitive_populations, socioeconomic_factors), scaled to max 10",
            "landscape": "weighted_mean(exposures, environmental_effects), scaled to max 10",
            "overall": "population_characteristics_score * landscape_burden_score",
        },
    }
    indicator_definitions = {
        "schemaVersion": 1,
        "releaseId": release_id,
        "indicators": [
            {
                **definition,
                "direction": "higher-is-greater-burden",
                "defaultWeight": 1,
                "sourceKeys": sorted(source_keys_by_indicator[definition["key"]]),
            }
            for definition in definitions
        ],
    }
    lha_indicators = {"schemaVersion": 1, "releaseId": release_id, "rows": lha_rows}
    lha_scores = {"schemaVersion": 1, "releaseId": release_id, "rows": score_output_rows}
    provenance = {
        "schemaVersion": 1,
        "releaseId": release_id,
        "bcdatamapperCommit": git_commit(),
        "normalizedScoreInput": str(args.score_input),
        "indicatorSources": {
            key: sorted(source_keys) for key, source_keys in sorted(source_keys_by_indicator.items())
        },
        "sourceSelection": source_selection,
        "note": "Large acquisition inputs remain outside this public release; source keys identify the selected normalized candidates.",
    }
    upstream_validation = read_json(args.validation_input) if args.validation_input.exists() else []
    validation = {
        "schemaVersion": 1,
        "releaseId": release_id,
        "checks": {
            "lhaRowCount": 89,
            "uniqueLhaCodeCount": 89,
            "indicatorCount": 21,
            "preferredHypertensionField": PREFERRED_HYPERTENSION_FIELD,
            "preferredHypertensionFieldPresent": True,
        },
        "benchmarkGapIndicators": sorted(benchmark_gap_indicators),
        "upstreamScoreComparison": upstream_validation,
    }

    payloads = {
        "index-definition.json": index_definition,
        "indicator-definitions.json": indicator_definitions,
        "lha-indicators.json": lha_indicators,
        "lha-scores.json": lha_scores,
        "source-provenance.json": provenance,
        "validation-summary.json": validation,
    }
    for filename, value in payloads.items():
        write_json(release_dir / filename, value)

    file_entries = []
    for filename in sorted(payloads):
        path = release_dir / filename
        row_count = len(payloads[filename].get("rows", [])) if isinstance(payloads[filename], dict) else None
        file_entries.append(
            {
                "filename": filename,
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
                "contentType": "application/json; charset=utf-8",
                "rowCount": row_count,
                "publicUrl": f"{PUBLIC_BASE}/releases/{release_id}/{filename}",
            }
        )

    manifest = {
        "schemaVersion": 1,
        "releaseId": release_id,
        "methodVersion": "bcenviroscreen-reconstruction-v1",
        "generatedAt": generated_at,
        "generatedBy": "build-bcenviroscreen-release.py",
        "bcdatamapperCommit": git_commit(),
        "boundary": {
            "source": "BC Ministry of Health",
            "level": "lha",
            "rowCount": 89,
            "joinKey": "lha_code",
        },
        "comparisonUniverse": "all-89-bc-lhas",
        "status": "hybrid-reconstruction",
        "indicatorKeys": indicator_keys,
        "componentAssignments": components,
        "files": file_entries,
        "validation": validation["checks"],
        "caveats": [
            "Research reconstruction; not an official Province of British Columbia or paper-author product.",
            f"Benchmark-derived gaps: {', '.join(sorted(benchmark_gap_indicators)) or 'none'}.",
            "Source equivalence and geographic coverage are separate quality dimensions.",
        ],
    }
    write_json(release_dir / "manifest.json", manifest)

    release_files = {entry["filename"].removesuffix(".json"): entry["publicUrl"] for entry in file_entries}
    latest = {
        "schemaVersion": 1,
        "releaseId": release_id,
        "status": manifest["status"],
        "manifestUrl": f"{PUBLIC_BASE}/releases/{release_id}/manifest.json",
        "files": release_files,
    }
    catalog = {
        "schemaVersion": 1,
        "latestReleaseId": release_id,
        "releases": [
            {
                "releaseId": release_id,
                "generatedAt": generated_at,
                "status": manifest["status"],
                "manifestUrl": latest["manifestUrl"],
            }
        ],
    }
    write_json(args.output_root / "latest.json", latest)
    write_json(args.output_root / "catalog.json", catalog)
    return release_dir, manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--score-input", type=Path, default=DEFAULT_SCORE_INPUT)
    parser.add_argument("--validation-input", type=Path, default=DEFAULT_VALIDATION_INPUT)
    parser.add_argument("--boundary", type=Path, default=DEFAULT_BOUNDARY_INPUT)
    parser.add_argument("--indicators", type=Path, default=PACKAGE_DIR / "config" / "indicators.json")
    parser.add_argument(
        "--source-selection",
        type=Path,
        default=PACKAGE_DIR / "config" / "source-selection.json",
    )
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--generated-at", help="Fixed ISO timestamp for reproducible builds")
    parser.add_argument("--release-id", help="Override the content-derived release id")
    return parser.parse_args()


def main() -> None:
    release_dir, manifest = build_release(parse_args())
    print(f"BC EnviroScreen release: {manifest['releaseId']}")
    print(f"Wrote {release_dir}")


if __name__ == "__main__":
    main()
