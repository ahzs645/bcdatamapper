#!/usr/bin/env python3

"""Rebuild BCEnviroScreen component and overall scores from LHA indicators.

The paper describes a percentile-rank workflow. This script keeps that score
math separate from source-specific GIS/census rebuilds so we can validate two
things independently:

- whether the score formula reproduces the Shiny score table from Shiny raw
  indicator columns; and
- how much the current raw rebuild changes the final scores when substituted
  into the same formula.
"""

import csv
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-scores"
SHINY_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "official-shiny-table" / "lha-indicators.csv"
BEST_CURRENT_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-validation" / "best-current-indicators.csv"


COMPONENTS = {
    "exposures": [
        "future_precipitation",
        "future_temperature",
        "ozone",
        "pm25",
        "traffic_density",
        "water_quality_exceedances",
    ],
    "environmental_effects": [
        "disturbed_landscape",
        "industrial_sites",
        "linear_footprint",
        "remediation_sites",
        "wildfire_burn_area",
    ],
    "sensitive_populations": [
        "all_causes_of_cancer",
        "copd",
        "diabetes_mellitus",
        "hypertension",
        "low_birth_weight",
    ],
    "socioeconomic_factors": [
        "employment_insurance_beneficiaries",
        "housing_burdened_renters",
        "linguistic_isolation",
        "low_education",
        "low_income",
    ],
}

RAW_INDICATORS = [field for fields in COMPONENTS.values() for field in fields]
SCORE_FIELDS = [
    "exposures",
    "environmental_effects",
    "sensitive_populations",
    "socioeconomic_factors",
    "landscape_burden_score",
    "population_characteristics_score",
    "overall_score",
]


def numeric(value):
    if value is None or value == "":
        return None
    try:
        if isinstance(value, str) and value.strip().lower() in {"na", "nan", "null"}:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def read_csv(path):
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("")
        return
    headers = []
    for row in rows:
        for key in row:
            if key not in headers:
                headers.append(key)
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True))


def pearson(xs, ys):
    if len(xs) < 2:
        return None
    mx = sum(xs) / len(xs)
    my = sum(ys) / len(ys)
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx <= 0 or vy <= 0:
        return None
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return round(cov / math.sqrt(vx * vy), 6)


def load_shiny_raw():
    rows = []
    for source_row in read_csv(SHINY_PATH):
        row = {"lha_name": source_row["lha_name"]}
        for field in RAW_INDICATORS + SCORE_FIELDS:
            row[field] = numeric(source_row.get(field))
        rows.append(row)
    return rows


def load_best_current_hybrid():
    """Use rebuilt indicators where available, with Shiny values as explicit gaps.

    This is not a fully raw rebuild yet. It is a bridge table that lets us
    measure the score impact of the indicators already rebuilt while retaining
    the Shiny benchmark for climate, health, traffic density, disturbed
    landscape, and employment insurance.
    """

    shiny_rows = {row["lha_name"]: row for row in load_shiny_raw()}
    best_rows = {row["lha_name"]: row for row in read_csv(BEST_CURRENT_PATH)}
    rows = []
    for lha_name, shiny_row in shiny_rows.items():
        row = {"lha_name": lha_name}
        best_row = best_rows.get(lha_name, {})
        for field in RAW_INDICATORS:
            rebuilt_value = numeric(best_row.get(f"{field}_rebuilt"))
            if rebuilt_value is not None:
                row[field] = rebuilt_value
                row[f"{field}_input_source"] = best_row.get(f"{field}_source", "rebuilt")
            else:
                row[field] = shiny_row.get(field)
                row[f"{field}_input_source"] = "shiny_gap"
        for field in SCORE_FIELDS:
            row[f"{field}_shiny"] = shiny_row.get(field)
        rows.append(row)
    return rows


def percentile_rank_scores(rows, field):
    values = []
    zero_indexes = set()
    for index, row in enumerate(rows):
        value = numeric(row.get(field))
        if value is None:
            continue
        if abs(value) < 1e-12:
            zero_indexes.add(index)
            continue
        values.append((value, index))

    values.sort(key=lambda item: item[0])
    count = len(values)
    scores = {}
    position = 0
    while position < count:
        end = position + 1
        while end < count and values[end][0] == values[position][0]:
            end += 1
        average_rank = (position + 1 + end) / 2
        percentile = average_rank / count if count else None
        for _value, index in values[position:end]:
            scores[index] = percentile
        position = end

    for index in zero_indexes:
        scores[index] = 0
    return scores


def mean_present(values):
    present = [value for value in values if value is not None]
    if not present:
        return None
    return sum(present) / len(present)


def scale_to_10(values):
    max_value = max(value for value in values if value is not None)
    return [value / max_value * 10 if value is not None and max_value else None for value in values]


def calculate_scores(rows):
    indicator_scores = {
        field: percentile_rank_scores(rows, field)
        for field in RAW_INDICATORS
    }

    output_rows = []
    component_values = {component: [] for component in COMPONENTS}
    for index, source_row in enumerate(rows):
        row = {"lha_name": source_row["lha_name"]}
        for field in RAW_INDICATORS:
            row[field] = source_row.get(field)
            source_key = f"{field}_input_source"
            if source_key in source_row:
                row[source_key] = source_row[source_key]
            row[f"{field}_percentile"] = indicator_scores[field].get(index)
        for component, fields in COMPONENTS.items():
            value = mean_present([row.get(f"{field}_percentile") for field in fields])
            row[component] = value
            component_values[component].append(value)
        output_rows.append(row)

    population_unscaled = [
        mean_present([row["sensitive_populations"], row["socioeconomic_factors"]])
        for row in output_rows
    ]
    landscape_unscaled = [
        (row["exposures"] + 0.5 * row["environmental_effects"]) / 1.5
        if row["exposures"] is not None and row["environmental_effects"] is not None
        else None
        for row in output_rows
    ]
    population_scaled = scale_to_10(population_unscaled)
    landscape_scaled = scale_to_10(landscape_unscaled)

    for index, row in enumerate(output_rows):
        row["population_characteristics_score"] = population_scaled[index]
        row["landscape_burden_score"] = landscape_scaled[index]
        row["overall_score"] = (
            population_scaled[index] * landscape_scaled[index]
            if population_scaled[index] is not None and landscape_scaled[index] is not None
            else None
        )
    return output_rows


def compare_to_shiny(calculated_rows):
    shiny_rows = {row["lha_name"]: row for row in load_shiny_raw()}
    long_rows = []
    for row in calculated_rows:
        shiny_row = shiny_rows[row["lha_name"]]
        for field in SCORE_FIELDS:
            shiny_value = shiny_row.get(field)
            rebuilt_value = row.get(field)
            if shiny_value is None or rebuilt_value is None:
                continue
            long_rows.append(
                {
                    "lha_name": row["lha_name"],
                    "score_field": field,
                    "shiny_value": shiny_value,
                    "rebuilt_value": round(rebuilt_value, 6),
                    "difference": round(rebuilt_value - shiny_value, 6),
                    "absolute_difference": round(abs(rebuilt_value - shiny_value), 6),
                }
            )

    summary_rows = []
    for field in SCORE_FIELDS:
        field_rows = [row for row in long_rows if row["score_field"] == field]
        if not field_rows:
            continue
        diffs = [row["absolute_difference"] for row in field_rows]
        xs = [row["shiny_value"] for row in field_rows]
        ys = [row["rebuilt_value"] for row in field_rows]
        pg = next((row for row in field_rows if row["lha_name"] == "Prince George"), None)
        summary_rows.append(
            {
                "score_field": field,
                "rows": len(field_rows),
                "mean_absolute_difference": round(sum(diffs) / len(diffs), 6),
                "max_absolute_difference": round(max(diffs), 6),
                "pearson_r": pearson(xs, ys),
                "prince_george_shiny": pg["shiny_value"] if pg else None,
                "prince_george_rebuilt": pg["rebuilt_value"] if pg else None,
                "prince_george_difference": pg["difference"] if pg else None,
            }
        )
    return long_rows, summary_rows


def round_score_rows(rows):
    rounded = []
    for row in rows:
        out = {}
        for key, value in row.items():
            out[key] = round(value, 6) if isinstance(value, float) else value
        rounded.append(out)
    return rounded


def main():
    mode = os.environ.get("BCENVIROSCREEN_SCORE_MODE", "both")
    datasets = []
    if mode in {"official", "both"}:
        datasets.append(("official-inputs", load_shiny_raw()))
    if mode in {"hybrid", "both"}:
        datasets.append(("hybrid-best-current-with-shiny-gaps", load_best_current_hybrid()))

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "score_method": "rank percentile among non-zero values; true zeros score 0; component means exclude missing; environmental effects weighted by 0.5 in landscape burden; landscape and population characteristics scaled to 10; final score is product",
        "datasets": [],
    }

    for dataset_name, input_rows in datasets:
        calculated_rows = round_score_rows(calculate_scores(input_rows))
        long_rows, summary_rows = compare_to_shiny(calculated_rows)
        dataset_dir = OUTPUT_DIR / dataset_name
        write_csv(dataset_dir / "lha-score-rebuild.csv", calculated_rows)
        write_json(dataset_dir / "lha-score-rebuild.json", calculated_rows)
        write_csv(dataset_dir / "score-comparison-long.csv", long_rows)
        write_csv(dataset_dir / "score-comparison-summary.csv", summary_rows)
        write_json(dataset_dir / "score-comparison-summary.json", summary_rows)
        manifest["datasets"].append(
            {
                "name": dataset_name,
                "rows": len(calculated_rows),
                "output_dir": str(dataset_dir.relative_to(OUTPUT_DIR.parent)),
            }
        )

    write_json(OUTPUT_DIR / "manifest.json", manifest)
    print(f"BCEnviroScreen score rebuild: wrote {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
