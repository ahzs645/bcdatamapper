#!/usr/bin/env python3
"""Build candidate LHA water-quality exceedance indicators from EMS Parquet."""

from __future__ import annotations

import csv
import json
import math
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import polars as pl
from shapely.geometry import Point, shape
from shapely.validation import make_valid


SCRIPT_DIR = Path(__file__).resolve().parent
PGMAPS_ROOT = Path(os.environ.get("PGMAPS_ROOT", SCRIPT_DIR.parents[3])).resolve()
RAW_SEED_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed"
PARQUET_DIR = RAW_SEED_DIR / "large" / "bc-environmental-monitoring-system-results" / "parquet"
OUTPUT_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-ems-lha"
LHA_PATH = PGMAPS_ROOT / "public" / "data" / "boundaries" / "BCMoH" / "local_health_areas.json"
SHINY_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "official-shiny-table" / "lha-indicators.csv"

PARQUET_FILES = [
    PARQUET_DIR / "bcenviroscreen-water-parameters-historic.parquet",
    PARQUET_DIR / "bcenviroscreen-water-parameters-current.parquet",
]

WINDOWS = {
    "2014_2017": (2014, 2017),
    "2015_2018": (2015, 2018),
    "2016_2019": (2016, 2019),
    "2017_2020": (2017, 2020),
    "2018_2021": (2018, 2021),
    "2019_2022": (2019, 2022),
    "2021_2024": (2021, 2024),
}

FILTERS = {
    "all_samples": None,
    "freshwater": lambda lf: lf.filter(pl.col("sample_state_code") == "FW"),
    "freshwater_regular": lambda lf: lf.filter((pl.col("sample_state_code") == "FW") & (pl.col("sample_class_code") == "REG")),
    "official_water_states": lambda lf: lf.filter(pl.col("sample_state_code").is_in(["FW", "GW", "SW", "DW"])),
    "official_water_states_regular": lambda lf: lf.filter(
        pl.col("sample_state_code").is_in(["FW", "GW", "SW", "DW"]) & (pl.col("sample_class_code") == "REG")
    ),
    "official_surface_groundwater_locations": lambda lf: lf.filter(
        pl.col("location_type").is_in(["13", "21", "27", "33", "38", "45", "D7", "D8"])
    ),
    "official_surface_groundwater_locations_regular": lambda lf: lf.filter(
        pl.col("location_type").is_in(["13", "21", "27", "33", "38", "45", "D7", "D8"])
        & (pl.col("sample_class_code") == "REG")
    ),
    "lakes_only": lambda lf: lf.filter(pl.col("location_type") == "13"),
    "rivers_lakes": lambda lf: lf.filter(pl.col("location_type").is_in(["13", "21"])),
    "ambient_freshwater_regular": lambda lf: lf.filter(
        (pl.col("sample_state_code") == "FW")
        & (pl.col("sample_class_code") == "REG")
        & pl.col("location_purpose").is_in(["TREND", "BACKGROUND", "NONE OF THE ABOVE"])
    ),
}

# BC source drinking water guideline thresholds. Units are EMS decoded unit_label.
THRESHOLD_RULES = [
    {"indicator_group": "lead", "parameter_code": "PB-T", "unit_label": "mg/L", "threshold": 0.005, "threshold_basis": "Lead total MAC"},
    {"indicator_group": "mercury", "parameter_code": "HG-T", "unit_label": "mg/L", "threshold": 0.001, "threshold_basis": "Mercury total MAC"},
    {"indicator_group": "nitrate", "parameter_code": "1109", "unit_label": "mg/L", "threshold": 10.0, "threshold_basis": "Nitrate/nitrite as N MAC proxy"},
    {"indicator_group": "nitrate", "parameter_code": "1110", "unit_label": "mg/L", "threshold": 10.0, "threshold_basis": "Nitrate-N MAC"},
    {"indicator_group": "nitrate", "parameter_code": "1111", "unit_label": "mg/L", "threshold": 1.0, "threshold_basis": "Nitrite-N MAC"},
    {"indicator_group": "phosphorus", "parameter_code": "P--T", "unit_label": "mg/L", "threshold": 0.01, "threshold_basis": "Total phosphorus AO for lakes"},
    {"indicator_group": "total_organic_carbon", "parameter_code": "0103", "unit_label": "mg/L", "threshold": 4.0, "threshold_basis": "TOC MAC"},
]

PAPER_THRESHOLD_RULES = [
    {"indicator_group": "lead", "parameter_code": "PB-T", "unit_label": "mg/L", "threshold": 0.005, "threshold_basis": "Paper Table 1: Total Lead >0.005 mg/L"},
    {"indicator_group": "e_coli", "parameter_code": "0147", "unit_label": "CFU/100mL", "threshold": 10.0, "threshold_basis": "Paper Table 1: E. coli >10/100 mL"},
    {"indicator_group": "e_coli", "parameter_code": "0147", "unit_label": "MPN/100mL", "threshold": 10.0, "threshold_basis": "Paper Table 1: E. coli >10/100 mL"},
    {"indicator_group": "nitrate", "parameter_code": "1110", "unit_label": "mg/L", "threshold": 45.0, "threshold_basis": "Paper Table 1: NO3 dissolved >45 mg/L"},
    {"indicator_group": "mercury", "parameter_code": "HG-D", "unit_label": "mg/L", "threshold": 0.001, "threshold_basis": "Paper Table 1: Mercury-all measures >0.001 mg/L"},
    {"indicator_group": "mercury", "parameter_code": "HG-T", "unit_label": "mg/L", "threshold": 0.001, "threshold_basis": "Paper Table 1: Mercury-all measures >0.001 mg/L"},
    {"indicator_group": "phosphorus", "parameter_code": "P--T", "unit_label": "mg/L", "threshold": 0.01, "threshold_basis": "Paper Table 1: Total Phosphorus >0.01 mg/L"},
    {"indicator_group": "total_organic_carbon", "parameter_code": "0103", "unit_label": "mg/L", "threshold": 4.0, "threshold_basis": "Paper Table 1: Total Organic Carbon >4 mg/L"},
]

ECOLI_CODES = {"0147"}
VALID_ECOLI_UNITS = {"CFU/100mL", "MPN/100mL"}
QA_KEEP = {"B", "C", None}
PAPER_QA_MODES = {
    "qa_bc": {"B", "C", None},
    "qa_no_f": {"B", "C", "D", None},
}


def load_lhas() -> list[dict[str, object]]:
    collection = json.loads(LHA_PATH.read_text())
    lhas = []
    for feature in collection["features"]:
        props = feature["properties"]
        geom = shape(feature["geometry"])
        if not geom.is_valid:
            geom = make_valid(geom)
        lhas.append(
            {
                "lha_code": str(props.get("LOCAL_HLTH_AREA_CODE", "")).zfill(3),
                "lha_name": props.get("LOCAL_HLTH_AREA_NAME", ""),
                "hsda_code": props.get("HLTH_SERVICE_DLVR_AREA_CODE", ""),
                "hsda_name": props.get("HLTH_SERVICE_DLVR_AREA_NAME", ""),
                "ha_code": props.get("HLTH_AUTHORITY_CODE", ""),
                "ha_name": props.get("HLTH_AUTHORITY_NAME", ""),
                "geometry": geom,
            }
        )
    return lhas


def bounds_intersect(left, right) -> bool:
    return not (left[2] < right[0] or left[0] > right[2] or left[3] < right[1] or left[1] > right[3])


def assign_stations_to_lha(lhas: list[dict[str, object]]) -> pl.DataFrame:
    lf = pl.scan_parquet([str(path) for path in PARQUET_FILES])
    stations = (
        lf.select(["ems_id", "latitude", "longitude"])
        .drop_nulls(["ems_id", "latitude", "longitude"])
        .unique(subset=["ems_id", "latitude", "longitude"])
        .collect()
        .to_dicts()
    )
    assigned = []
    for station in stations:
        point = Point(station["longitude"], station["latitude"])
        lha_match = None
        for lha in lhas:
            geom = lha["geometry"]
            if not bounds_intersect(geom.bounds, point.bounds):
                continue
            if geom.covers(point):
                lha_match = lha
                break
        if lha_match:
            assigned.append(
                {
                    "ems_id": station["ems_id"],
                    "latitude": station["latitude"],
                    "longitude": station["longitude"],
                    "lha_code": lha_match["lha_code"],
                    "lha_name": lha_match["lha_name"],
                }
            )
    return pl.DataFrame(assigned)


def base_results(station_lha: pl.DataFrame) -> pl.LazyFrame:
    threshold_df = pl.DataFrame(THRESHOLD_RULES).lazy()
    lf = pl.scan_parquet([str(path) for path in PARQUET_FILES])
    return (
        lf.join(station_lha.lazy().select(["ems_id", "lha_code", "lha_name"]), on="ems_id", how="inner")
        .filter(pl.col("collection_year").is_not_null())
        .filter(pl.col("result_numeric").is_not_null())
        .filter(pl.col("qa_index_code").is_in(list(QA_KEEP)))
        .join(threshold_df, on=["indicator_group", "parameter_code", "unit_label"], how="inner")
        .with_columns((pl.col("result_numeric") > pl.col("threshold")).alias("exceeded"))
    )


def paper_base_results(station_lha: pl.DataFrame, qa_keep: set[str | None]) -> pl.LazyFrame:
    threshold_df = pl.DataFrame(PAPER_THRESHOLD_RULES).lazy()
    lf = pl.scan_parquet([str(path) for path in PARQUET_FILES])
    return (
        lf.join(station_lha.lazy().select(["ems_id", "lha_code", "lha_name"]), on="ems_id", how="inner")
        .filter(pl.col("collection_year").is_not_null())
        .filter(pl.col("result_numeric").is_not_null())
        .filter(pl.col("qa_index_code").is_in(list(qa_keep)))
        .join(threshold_df, on=["indicator_group", "parameter_code", "unit_label"], how="inner")
        .with_columns((pl.col("result_numeric") > pl.col("threshold")).alias("exceeded"))
    )


def ecoli_station_exceedances(station_lha: pl.DataFrame) -> pl.LazyFrame:
    lf = pl.scan_parquet([str(path) for path in PARQUET_FILES])
    return (
        lf.join(station_lha.lazy().select(["ems_id", "lha_code", "lha_name"]), on="ems_id", how="inner")
        .filter(pl.col("collection_year").is_not_null())
        .filter(pl.col("result_numeric").is_not_null())
        .filter(pl.col("qa_index_code").is_in(list(QA_KEEP)))
        .filter(pl.col("parameter_code").is_in(list(ECOLI_CODES)))
        .filter(pl.col("unit_label").is_in(list(VALID_ECOLI_UNITS)))
    )


def apply_filter(lf: pl.LazyFrame, filter_name: str) -> pl.LazyFrame:
    fn = FILTERS[filter_name]
    return lf if fn is None else fn(lf)


def candidate_rows(station_lha: pl.DataFrame, lhas: list[dict[str, object]]) -> list[dict[str, object]]:
    base = base_results(station_lha)
    paper_bases = {qa_name: paper_base_results(station_lha, qa_keep) for qa_name, qa_keep in PAPER_QA_MODES.items()}
    ecoli_base = ecoli_station_exceedances(station_lha)
    all_rows = []
    lha_names = {lha["lha_name"] for lha in lhas}

    for window_name, (start_year, end_year) in WINDOWS.items():
        for filter_name in FILTERS:
            for qa_name, paper_base in paper_bases.items():
                paper_lf = apply_filter(paper_base, filter_name).filter(pl.col("collection_year").is_between(start_year, end_year))
                paper_station_share = (
                    paper_lf.group_by(["lha_name", "ems_id"])
                    .agg([pl.len().alias("eligible_result_rows"), pl.col("exceeded").max().alias("station_exceeded")])
                    .group_by("lha_name")
                    .agg(
                        [
                            pl.len().alias("eligible_station_rows"),
                            pl.col("station_exceeded").sum().alias("exceeded_station_rows"),
                        ]
                    )
                    .with_columns((pl.col("exceeded_station_rows") / pl.col("eligible_station_rows")).alias("candidate_value"))
                    .collect()
                    .to_dicts()
                )
                all_rows.extend(
                    {
                        "lha_name": row["lha_name"],
                        "candidate": f"{window_name}_{filter_name}_{qa_name}_paper_sample_location_any_exceedance_share",
                        **row,
                    }
                    for row in paper_station_share
                )

            lf = apply_filter(base, filter_name).filter(pl.col("collection_year").is_between(start_year, end_year))
            result_share = (
                lf.group_by(["lha_name"])
                .agg(
                    [
                        pl.len().alias("eligible_result_rows"),
                        pl.col("exceeded").sum().alias("exceeded_result_rows"),
                        pl.col("indicator_group").n_unique().alias("tested_indicator_groups"),
                    ]
                )
                .with_columns((pl.col("exceeded_result_rows") / pl.col("eligible_result_rows")).alias("candidate_value"))
                .collect()
                .to_dicts()
            )
            all_rows.extend(
                {
                    "lha_name": row["lha_name"],
                    "candidate": f"{window_name}_{filter_name}_result_exceedance_share",
                    **row,
                }
                for row in result_share
            )

            site_parameter_share = (
                lf.group_by(["lha_name", "ems_id", "indicator_group"])
                .agg([pl.len().alias("eligible_result_rows"), pl.col("exceeded").max().alias("station_parameter_exceeded")])
                .group_by("lha_name")
                .agg(
                    [
                        pl.len().alias("eligible_station_parameter_rows"),
                        pl.col("station_parameter_exceeded").sum().alias("exceeded_station_parameter_rows"),
                    ]
                )
                .with_columns((pl.col("exceeded_station_parameter_rows") / pl.col("eligible_station_parameter_rows")).alias("candidate_value"))
                .collect()
                .to_dicts()
            )
            all_rows.extend(
                {
                    "lha_name": row["lha_name"],
                    "candidate": f"{window_name}_{filter_name}_station_parameter_any_share",
                    **row,
                }
                for row in site_parameter_share
            )

            parameter_share = (
                lf.group_by(["lha_name", "indicator_group"])
                .agg([pl.len().alias("eligible_result_rows"), pl.col("exceeded").max().alias("indicator_exceeded")])
                .group_by("lha_name")
                .agg([pl.len().alias("tested_indicator_groups"), pl.col("indicator_exceeded").sum().alias("exceeded_indicator_groups")])
                .with_columns((pl.col("exceeded_indicator_groups") / pl.lit(6)).alias("candidate_value"))
                .collect()
                .to_dicts()
            )
            all_rows.extend(
                {
                    "lha_name": row["lha_name"],
                    "candidate": f"{window_name}_{filter_name}_six_indicator_any_share",
                    **row,
                }
                for row in parameter_share
            )

            ecoli_lf = apply_filter(ecoli_base, filter_name).filter(pl.col("collection_year").is_between(start_year, end_year))
            ecoli_p90 = (
                ecoli_lf.group_by(["lha_name", "ems_id"])
                .agg([pl.len().alias("ecoli_samples"), pl.col("result_numeric").quantile(0.9, interpolation="nearest").alias("ecoli_p90")])
                .filter(pl.col("ecoli_samples") >= 5)
                .with_columns((pl.col("ecoli_p90") > 10).alias("station_parameter_exceeded"))
                .group_by("lha_name")
                .agg([pl.len().alias("eligible_station_parameter_rows"), pl.col("station_parameter_exceeded").sum().alias("exceeded_station_parameter_rows")])
                .with_columns((pl.col("exceeded_station_parameter_rows") / pl.col("eligible_station_parameter_rows")).alias("candidate_value"))
                .collect()
                .to_dicts()
            )
            all_rows.extend(
                {
                    "lha_name": row["lha_name"],
                    "candidate": f"{window_name}_{filter_name}_ecoli_station_p90_share",
                    **row,
                }
                for row in ecoli_p90
            )

    # Make missing LHAs explicit in candidate exports only after comparison.
    rows = [row for row in all_rows if row["lha_name"] in lha_names]
    keys = [(str(row["lha_name"]), str(row["candidate"])) for row in rows]
    if len(keys) != len(set(keys)):
        duplicate_count = len(keys) - len(set(keys))
        raise RuntimeError(f"EMS candidate output contains {duplicate_count} duplicate LHA/candidate rows")
    return rows


def read_shiny() -> dict[str, float]:
    values = {}
    with SHINY_PATH.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            try:
                values[row["lha_name"]] = float(row["water_quality_exceedances"])
            except (TypeError, ValueError):
                pass
    return values


def pearson(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 2:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx <= 0 or vy <= 0:
        return None
    return round(cov / math.sqrt(vx * vy), 6)


def compare_to_shiny(rows: list[dict[str, object]]) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    shiny = read_shiny()
    long_rows = []
    for row in rows:
        shiny_value = shiny.get(str(row["lha_name"]))
        if shiny_value is None:
            continue
        rebuilt = float(row["candidate_value"])
        rounded = round(rebuilt, 1)
        long_rows.append(
            {
                "lha_name": row["lha_name"],
                "candidate": row["candidate"],
                "shiny_value": shiny_value,
                "rebuilt_value": rebuilt,
                "rebuilt_value_rounded_1dp": rounded,
                "difference": rebuilt - shiny_value,
                "absolute_difference": abs(rebuilt - shiny_value),
                "rounded_difference": rounded - shiny_value,
                "rounded_absolute_difference": abs(rounded - shiny_value),
            }
        )

    grouped = defaultdict(list)
    for row in long_rows:
        grouped[row["candidate"]].append(row)

    summaries = []
    for candidate, candidate_rows_ in grouped.items():
        rows_with_values = [row for row in candidate_rows_ if row["rebuilt_value"] is not None]
        if not rows_with_values:
            continue
        summaries.append(
            {
                "candidate": candidate,
                "rows": len(rows_with_values),
                "mean_absolute_difference": round(sum(row["absolute_difference"] for row in rows_with_values) / len(rows_with_values), 6),
                "rounded_mean_absolute_difference": round(
                    sum(row["rounded_absolute_difference"] for row in rows_with_values) / len(rows_with_values), 6
                ),
                "max_absolute_difference": round(max(row["absolute_difference"] for row in rows_with_values), 6),
                "pearson_r": pearson(
                    [row["shiny_value"] for row in rows_with_values],
                    [row["rebuilt_value"] for row in rows_with_values],
                ),
            }
        )
    summaries.sort(key=lambda row: (row["rounded_mean_absolute_difference"], -(row["pearson_r"] or -999), row["candidate"]))
    return long_rows, summaries


def write_csv(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    headers = []
    for row in rows:
        for key in row:
            if key not in headers:
                headers.append(key)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    for path in PARQUET_FILES:
        if not path.exists():
            raise SystemExit(f"Missing EMS Parquet input: {path}")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    lhas = load_lhas()
    station_lha = assign_stations_to_lha(lhas)
    station_lha.write_csv(OUTPUT_DIR / "ems-station-lha-crosswalk.csv")

    rows = candidate_rows(station_lha, lhas)
    comparison_long, comparison_summary = compare_to_shiny(rows)

    write_csv(OUTPUT_DIR / "lha-water-quality-exceedance-candidates.csv", rows)
    write_csv(OUTPUT_DIR / "shiny-comparison-long.csv", comparison_long)
    write_csv(OUTPUT_DIR / "shiny-comparison-summary.csv", comparison_summary)
    (OUTPUT_DIR / "shiny-comparison-summary.json").write_text(json.dumps(comparison_summary, indent=2) + "\n", encoding="utf-8")
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "sourceParquetFiles": [str(path.relative_to(SCRIPT_DIR)) for path in PARQUET_FILES],
                "lhaBoundary": str(LHA_PATH.relative_to(PGMAPS_ROOT)),
                "validationTarget": str(SHINY_PATH.relative_to(SCRIPT_DIR)),
                "stationAssignments": station_lha.height,
                "windows": WINDOWS,
                "thresholdRules": THRESHOLD_RULES,
                "paperThresholdRules": PAPER_THRESHOLD_RULES,
                "paperQaModes": {key: sorted(value for value in values if value is not None) + (["null"] if None in values else []) for key, values in PAPER_QA_MODES.items()},
                "notes": [
                    "This is a validation harness for EMS water exceedance formulas, not a final confirmed BCEnviroScreen calculation.",
                    "Paper candidates use the article Table 1 definition: percent of EMS sample locations in each LHA with any exceedance of listed thresholds.",
                    "E. coli candidates use either result-level shares through general candidates or a station-level 90th percentile candidate with at least five samples.",
                    "Total phosphorus guideline is a lake aesthetic objective; the EMS result file does not by itself identify lake applicability, so phosphorus candidates are provisional.",
                    "QA filter currently keeps B, C, and null QA rows and excludes D/F rows.",
                ],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"BCEnviroScreen EMS LHA rebuild: wrote {OUTPUT_DIR.relative_to(PGMAPS_ROOT)}")


if __name__ == "__main__":
    main()
