#!/usr/bin/env python3

import csv
import json
import os
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
PGMAPS_ROOT = Path(os.environ.get("PGMAPS_ROOT", SCRIPT_DIR.parents[3])).resolve()
VENDOR_ROOT = SCRIPT_DIR.parents[2]
OUTPUT_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "cd-attributed-targets"
SHINY_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "official-shiny-table" / "lha-indicators.csv"
CENSUS_BASE = SCRIPT_DIR.parent / "census" / "output" / "bcenviroscreen-census-lha"
DA_CROSSWALK_PATH = CENSUS_BASE / "2016" / "da-to-lha-crosswalk.csv"
DA_RECORDS_PATH = CENSUS_BASE / "raw" / "CA16_bc_da_selected_records.json"


TARGET_FIELDS = ["traffic_density", "future_temperature", "future_precipitation"]


def read_csv(path):
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def numeric(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def load_lha_cd_crosswalk():
    da_records = {row["geo_uid"]: row for row in json.loads(DA_RECORDS_PATH.read_text())}
    population_by_lha_cd = defaultdict(lambda: defaultdict(float))
    da_count_by_lha_cd = defaultdict(lambda: defaultdict(int))

    for row in read_csv(DA_CROSSWALK_PATH):
        geo_uid = row["geo_uid"]
        cd_code = geo_uid[:4]
        record = da_records.get(geo_uid, {})
        population_by_lha_cd[row["lha_name"]][cd_code] += record.get("population") or 0
        da_count_by_lha_cd[row["lha_name"]][cd_code] += 1

    crosswalk = {}
    for lha_name, cd_populations in population_by_lha_cd.items():
        primary_cd = max(cd_populations, key=cd_populations.get)
        total_population = sum(cd_populations.values())
        crosswalk[lha_name] = {
            "lha_name": lha_name,
            "cd_code": primary_cd,
            "cd_population_assigned": round(cd_populations[primary_cd], 3),
            "lha_population_assigned": round(total_population, 3),
            "cd_population_share": round(cd_populations[primary_cd] / total_population, 6) if total_population else None,
            "da_count_in_cd": da_count_by_lha_cd[lha_name][primary_cd],
            "da_count_total": sum(da_count_by_lha_cd[lha_name].values()),
        }
    return crosswalk


def build_targets():
    shiny_rows = read_csv(SHINY_PATH)
    crosswalk = load_lha_cd_crosswalk()
    lha_rows = []
    grouped = defaultdict(list)

    for shiny_row in shiny_rows:
        lha_name = shiny_row["lha_name"]
        cw = crosswalk.get(lha_name)
        if not cw:
            continue
        row = dict(cw)
        for field in TARGET_FIELDS:
            row[field] = numeric(shiny_row.get(field))
        lha_rows.append(row)
        grouped[row["cd_code"]].append(row)

    cd_rows = []
    value_groups = defaultdict(list)
    for cd_code, rows in sorted(grouped.items()):
        output = {
            "cd_code": cd_code,
            "lha_count": len(rows),
            "lha_names": "; ".join(sorted(row["lha_name"] for row in rows)),
        }
        for field in TARGET_FIELDS:
            values = sorted({row[field] for row in rows if row[field] is not None})
            output[field] = values[0] if len(values) == 1 else None
            output[f"{field}_unique_values"] = "; ".join(str(value).rstrip("0").rstrip(".") for value in values)
            output[f"{field}_unique_count"] = len(values)
        cd_rows.append(output)

        for row in rows:
            key = tuple(row[field] for field in TARGET_FIELDS)
            value_groups[key].append(row)

    value_group_rows = []
    for index, (values, rows) in enumerate(sorted(value_groups.items(), key=lambda item: (str(item[0]), item[1][0]["cd_code"])), start=1):
        output = {
            "target_group_id": f"target_group_{index:02d}",
            "cd_codes": "; ".join(sorted({row["cd_code"] for row in rows})),
            "lha_count": len(rows),
            "lha_names": "; ".join(sorted(row["lha_name"] for row in rows)),
        }
        for field, value in zip(TARGET_FIELDS, values):
            output[field] = value
        value_group_rows.append(output)
    return lha_rows, cd_rows, value_group_rows


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


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    lha_rows, cd_rows, value_group_rows = build_targets()
    write_csv(OUTPUT_DIR / "lha-cd-attributed-targets.csv", lha_rows)
    write_csv(OUTPUT_DIR / "cd-attributed-targets.csv", cd_rows)
    write_csv(OUTPUT_DIR / "source-value-groups.csv", value_group_rows)
    (OUTPUT_DIR / "lha-cd-attributed-targets.json").write_text(json.dumps(lha_rows, indent=2) + "\n")
    (OUTPUT_DIR / "cd-attributed-targets.json").write_text(json.dumps(cd_rows, indent=2) + "\n")
    (OUTPUT_DIR / "source-value-groups.json").write_text(json.dumps(value_group_rows, indent=2) + "\n")
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "method": "Infer Census-Division-level target values from the official Shiny LHA table and 2016 DA-to-LHA/CD membership. This is a benchmark extraction, not an independent raw source.",
                "inputs": {
                    "shinyTable": str(SHINY_PATH.relative_to(SCRIPT_DIR)),
                    "daToLhaCrosswalk": str(DA_CROSSWALK_PATH.relative_to(VENDOR_ROOT)),
                    "daSelectedRecords": str(DA_RECORDS_PATH.relative_to(VENDOR_ROOT)),
                },
                "targetFields": TARGET_FIELDS,
                "outputs": {
                    "lhaTargetsCsv": "lha-cd-attributed-targets.csv",
                    "cdTargetsCsv": "cd-attributed-targets.csv",
                    "sourceValueGroupsCsv": "source-value-groups.csv",
                },
            },
            indent=2,
        )
        + "\n"
    )
    print(f"BCEnviroScreen CD attributed targets: wrote {OUTPUT_DIR.relative_to(PGMAPS_ROOT)}")


if __name__ == "__main__":
    main()
