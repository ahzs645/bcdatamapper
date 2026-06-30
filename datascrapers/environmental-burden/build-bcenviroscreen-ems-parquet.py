#!/usr/bin/env python3
"""Normalize EMS water-quality CSVs into project-focused Parquet files.

The EMS result CSVs are large and row-wise. For BC EnviroScreen rebuilding we
only need a narrow set of fields and candidate parameter codes for water
exceedances. This script keeps raw CSVs untouched and writes compressed Parquet
under the Google Drive-backed large data directory.
"""

from __future__ import annotations

import csv
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import polars as pl


SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed"
LARGE_EMS_DIR = OUTPUT_DIR / "large" / "bc-environmental-monitoring-system-results"
COMPACT_EMS_DIR = OUTPUT_DIR / "compact" / "bc-environmental-monitoring-system-results"
PARAMETER_DICTIONARY = (
    OUTPUT_DIR
    / "compact"
    / "catalog-resources"
    / "bc-environmental-monitoring-system-results"
    / "ems-parameter-dictionary.csv"
)

SOURCE_FILES = {
    "current": LARGE_EMS_DIR / "ems-sample-results-current-csv.csv",
    "historic": LARGE_EMS_DIR / "ems-sample-results-historic-csv.csv",
}

FIELD_ALIASES = {
    "ems_id": ["EMS_ID"],
    "monitoring_location": ["MONITORING_LOCATION"],
    "latitude": ["LATITUDE"],
    "longitude": ["LONGITUDE"],
    "location_type": ["LOCATION_TYPE"],
    "collection_start_raw": ["COLLECTION_START_DATE", "COLLECTION_START"],
    "collection_end_raw": ["COLLECTION_END_DATE", "COLLECTION_END"],
    "location_purpose": ["LOCATION_PURPOSE"],
    "permit": ["PERMIT"],
    "permit_relationship": ["PERMIT_RELATIONSHIP"],
    "discharge_to": ["DISCHARGE_TO", "DISCHARGE"],
    "requisition_id": ["REQUISITION_ID"],
    "sampling_agency_code": ["SAMPLING_AGENCY_CODE", "SAMPLING_AGENCY"],
    "analyzing_agency_code": ["ANALYZING_AGENCY_CODE", "ANALYZING_AGENCY"],
    "collection_method_code": ["COLLECTION_METHOD_CODE", "COLLECTION_METHOD"],
    "sample_class_code": ["SAMPLE_CLASS_CODE", "SAMPLE_CLASS"],
    "sample_state_code": ["SAMPLE_STATE_CODE", "SAMPLE_STATE"],
    "sample_description_code": ["SAMPLE_DESCRIPTION_CODE", "SAMPLE_DESCRIPTOR"],
    "parameter_code": ["PARAMETER_CODE"],
    "parameter_name_source": ["PARAMETER"],
    "analytical_method_code": ["ANALYTICAL_METHOD_CODE"],
    "analytical_method_source": ["ANALYTICAL_METHOD"],
    "result_letter": ["RESULT_LETTER"],
    "result_numeric": ["RESULT_NUMERIC", "RESULT"],
    "unit": ["UNIT"],
    "method_detection_limit": ["METHOD_DETECTION_LIMIT"],
    "mdl_unit": ["MDL_UNIT"],
    "qa_index_code": ["QA_INDEX_CODE"],
    "upper_depth": ["UPPER_DEPTH"],
    "lower_depth": ["LOWER_DEPTH"],
}

# Broad first-pass candidate codes. These preserve source rows for later
# threshold/method filtering rather than trying to decide guideline logic here.
TARGET_PARAMETER_CODES = {
    "lead": ["PB-D", "PB-T"],
    "e_coli": ["0147"],
    "nitrate": ["1109", "1110", "1111"],
    "mercury": ["HG-D", "HG-T"],
    "phosphorus": ["0118", "1118", "P--D", "P--T"],
    "total_organic_carbon": ["0103", "TOC63U"],
}

STRING_COLUMNS = [
    "source_file",
    "ems_id",
    "monitoring_location",
    "location_type",
    "collection_start_raw",
    "collection_end_raw",
    "location_purpose",
    "permit",
    "permit_relationship",
    "discharge_to",
    "requisition_id",
    "sampling_agency_code",
    "analyzing_agency_code",
    "collection_method_code",
    "sample_class_code",
    "sample_state_code",
    "sample_description_code",
    "parameter_code",
    "parameter_name_source",
    "analytical_method_code",
    "analytical_method_source",
    "result_letter",
    "unit",
    "mdl_unit",
    "qa_index_code",
]


def ensure_inputs() -> None:
    missing = [str(path) for path in [PARAMETER_DICTIONARY, *SOURCE_FILES.values()] if not path.exists()]
    if missing:
        raise SystemExit("Missing EMS input files:\n" + "\n".join(missing))


def read_parameter_dictionary() -> list[dict[str, str]]:
    with PARAMETER_DICTIONARY.open(newline="", encoding="latin-1") as handle:
        return list(csv.DictReader(handle))


def build_candidate_metadata(rows: Iterable[dict[str, str]]) -> list[dict[str, object]]:
    by_code: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        by_code[row.get("Parameter Code", "")].append(row)

    records: list[dict[str, object]] = []
    for group, codes in TARGET_PARAMETER_CODES.items():
        for code in codes:
            matches = by_code.get(code, [])
            parameter_counts = Counter(row.get("Parameter", "") for row in matches)
            unit_counts = Counter(row.get("Unit", "") for row in matches)
            method_codes = sorted({row.get("Analytical Method Code", "") for row in matches if row.get("Analytical Method Code", "")})
            records.append(
                {
                    "indicator_group": group,
                    "parameter_code": code,
                    "parameter": parameter_counts.most_common(1)[0][0] if parameter_counts else "",
                    "units": sorted(unit for unit in unit_counts if unit),
                    "method_count": len(method_codes),
                    "analytical_method_codes": method_codes,
                }
            )
    return records


def metadata_frames(candidate_rows: list[dict[str, object]], dictionary_rows: list[dict[str, str]]) -> tuple[pl.LazyFrame, pl.LazyFrame]:
    code_records = [
        {
            "parameter_code": str(row["parameter_code"]),
            "indicator_group": str(row["indicator_group"]),
            "parameter_name": str(row["parameter"]),
        }
        for row in candidate_rows
    ]

    unit_records_by_code: dict[str, str] = {}
    for row in dictionary_rows:
        code = row.get("Unit Code", "")
        unit = row.get("Unit", "")
        if code and unit and code not in unit_records_by_code:
            unit_records_by_code[code] = unit
    unit_records = [{"unit_code": code, "unit_label": unit} for code, unit in sorted(unit_records_by_code.items())]

    return pl.DataFrame(code_records).lazy(), pl.DataFrame(unit_records).lazy()


def optional_expr(columns: set[str], aliases: list[str], output_name: str) -> pl.Expr:
    for alias in aliases:
        if alias in columns:
            return pl.col(alias).cast(pl.Utf8).alias(output_name)
    return pl.lit(None, dtype=pl.Utf8).alias(output_name)


def scan_source(path: Path, source_name: str) -> pl.LazyFrame:
    raw = pl.scan_csv(
        path,
        infer_schema_length=0,
        ignore_errors=True,
        null_values=[""],
        encoding="utf8-lossy",
    )
    columns = set(raw.collect_schema().names())
    selected = [pl.lit(source_name).alias("source_file")]
    selected.extend(optional_expr(columns, aliases, output_name) for output_name, aliases in FIELD_ALIASES.items())

    lf = raw.select(selected).with_columns(
        [
            pl.col("latitude").cast(pl.Float64, strict=False),
            pl.col("longitude").cast(pl.Float64, strict=False),
            pl.col("result_numeric").cast(pl.Float64, strict=False),
            pl.col("method_detection_limit").cast(pl.Float64, strict=False),
            pl.col("upper_depth").cast(pl.Float64, strict=False),
            pl.col("lower_depth").cast(pl.Float64, strict=False),
            pl.col("collection_start_raw").str.slice(0, 4).cast(pl.Int16, strict=False).alias("collection_year"),
            pl.col("collection_start_raw")
            .str.strptime(pl.Datetime, format="%Y%m%d%H%M%S", strict=False)
            .alias("collection_start_datetime"),
            pl.col("collection_end_raw")
            .str.strptime(pl.Datetime, format="%Y%m%d%H%M%S", strict=False)
            .alias("collection_end_datetime"),
        ]
    )
    return lf


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    ensure_inputs()
    parquet_dir = LARGE_EMS_DIR / "parquet"
    parquet_dir.mkdir(parents=True, exist_ok=True)
    COMPACT_EMS_DIR.mkdir(parents=True, exist_ok=True)

    dictionary_rows = read_parameter_dictionary()
    candidate_rows = build_candidate_metadata(dictionary_rows)
    candidate_codes = sorted({code for codes in TARGET_PARAMETER_CODES.values() for code in codes})
    code_metadata, unit_metadata = metadata_frames(candidate_rows, dictionary_rows)

    candidate_json = COMPACT_EMS_DIR / "bcenviroscreen-water-parameter-candidates.json"
    candidate_csv = COMPACT_EMS_DIR / "bcenviroscreen-water-parameter-candidates.csv"
    candidate_json.write_text(json.dumps(candidate_rows, indent=2) + "\n", encoding="utf-8")
    write_csv(candidate_csv, candidate_rows)

    summary_rows: list[dict[str, object]] = []
    for source_name, source_path in SOURCE_FILES.items():
        print(f"Processing EMS {source_name}: {source_path}")
        lf = scan_source(source_path, source_name)
        filtered = (
            lf.filter(pl.col("parameter_code").is_in(candidate_codes))
            .join(code_metadata, on="parameter_code", how="left")
            .join(unit_metadata, left_on="unit", right_on="unit_code", how="left")
        )
        out_path = parquet_dir / f"bcenviroscreen-water-parameters-{source_name}.parquet"
        filtered.sink_parquet(out_path, compression="zstd")

        stats = (
            pl.scan_parquet(out_path)
            .group_by(["source_file", "indicator_group", "parameter_code", "parameter_name", "unit", "unit_label"])
            .agg(
                [
                    pl.len().alias("rows"),
                    pl.col("collection_year").min().alias("min_collection_year"),
                    pl.col("collection_year").max().alias("max_collection_year"),
                    pl.col("result_numeric").null_count().alias("null_result_numeric_rows"),
                ]
            )
            .sort(["source_file", "parameter_code", "unit"])
            .collect()
        )
        summary_rows.extend(stats.to_dicts())
        size_mb = out_path.stat().st_size / 1024 / 1024
        print(f"Wrote {out_path} ({size_mb:.1f} MB)")

    summary = {
        "builtAt": datetime.now(timezone.utc).isoformat(),
        "sourceFiles": {name: str(path.relative_to(SCRIPT_DIR)) for name, path in SOURCE_FILES.items()},
        "parquetDirectory": str(parquet_dir.relative_to(SCRIPT_DIR)),
        "candidateParameterCodes": TARGET_PARAMETER_CODES,
        "notes": [
            "Parquet outputs are filtered to broad BC EnviroScreen water-exceedance candidate parameter codes.",
            "Threshold, unit, sample-medium, QA, and 4-year-window filtering are intentionally downstream steps.",
            "Large Parquet files live in the Google Drive-backed large folder and should not be copied to public data.",
        ],
        "parameterSummaries": summary_rows,
    }
    summary_json = COMPACT_EMS_DIR / "bcenviroscreen-water-parameter-parquet-summary.json"
    summary_csv = COMPACT_EMS_DIR / "bcenviroscreen-water-parameter-parquet-summary.csv"
    summary_json.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    write_csv(summary_csv, summary_rows)
    print(f"Wrote {summary_json}")


if __name__ == "__main__":
    main()
