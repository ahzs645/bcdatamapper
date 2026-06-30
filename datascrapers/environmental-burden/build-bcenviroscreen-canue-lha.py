#!/usr/bin/env python3

import csv
import json
import math
import os
import re
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
PGMAPS_ROOT = Path(os.environ.get("PGMAPS_ROOT", SCRIPT_DIR.parents[3])).resolve()
OUTPUT_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-canue-lha"
COMPACT_CANUE_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed" / "compact" / "canue"
SHINY_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "official-shiny-table" / "lha-indicators.csv"
CATALOG_URL = "https://data.map.ahmad.sh/canue/aggregates-v2/canue-bc-aggregates-v2-catalog.json"
TARGET_YEARS = [2012, 2015]
MISSING_SENTINELS = {-1111, -9999, -999}


MONTH_RE = re.compile(
    r"^(?P<dataset>.+)__.*(?P<month>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)_(?P<year>\d{2})$",
    re.IGNORECASE,
)


def read_csv(path):
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def read_json(path):
    return json.loads(path.read_text())


def download_if_missing(url, path):
    if path.exists():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url) as response:
        path.write_bytes(response.read())
    return True


def numeric(value):
    if value is None:
        return None
    try:
        output = float(value)
    except (TypeError, ValueError):
        return None
    if output in MISSING_SENTINELS:
        return None
    if not math.isfinite(output):
        return None
    return output


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


def load_catalog():
    catalog_path = COMPACT_CANUE_DIR / "canue-bc-aggregates-v2-catalog.json"
    download_if_missing(CATALOG_URL, catalog_path)
    return read_json(catalog_path), catalog_path


def load_aggregate(catalog, year):
    expected_path = f"bcHealth/lha/air-quality_{year}_aggregate.json"
    item = next((row for row in catalog["files"] if row.get("path") == expected_path), None)
    if not item:
        raise SystemExit(f"CANUE aggregate not found in catalog: {expected_path}")
    local_path = COMPACT_CANUE_DIR / expected_path
    downloaded = download_if_missing(item["url"], local_path)
    return read_json(local_path), local_path, item, downloaded


def variable_note(variable):
    return f"{variable.get('dataset')}.{variable.get('variable')}"


def build_lha_rows(aggregates):
    by_lha = {}
    variable_notes = {}
    monthly_groups = defaultdict(list)

    for aggregate in aggregates:
        year = aggregate["year"]
        for variable in aggregate["variables"]:
            prop = variable["property"]
            output_field = f"canue_{year}_{prop}"
            variable_notes[output_field] = variable_note(variable)
            match = MONTH_RE.match(prop)
            if match:
                monthly_groups[(year, match.group("dataset").lower())].append(prop)

        for source_row in aggregate["rows"]:
            lha_name = source_row["boundaryName"]
            row = by_lha.setdefault(
                lha_name,
                {
                    "lha_id": source_row["boundaryId"],
                    "lha_name": lha_name,
                },
            )
            for prop, value in source_row.get("values", {}).items():
                row[f"canue_{year}_{prop}"] = numeric(value)

    for (year, dataset), props in monthly_groups.items():
        if len(props) < 2:
            continue
        props = sorted(props)
        field = f"canue_{year}_{dataset}_annual_mean"
        variable_notes[field] = f"derived annual mean from {len(props)} monthly {dataset} variables"
        for row in by_lha.values():
            values = [numeric(row.get(f"canue_{year}_{prop}")) for prop in props]
            values = [value for value in values if value is not None]
            row[field] = round(sum(values) / len(values), 9) if values else None

    return list(sorted(by_lha.values(), key=lambda row: row["lha_name"])), variable_notes


def compare_candidates(shiny_rows, canue_rows, variable_notes):
    shiny = {row["lha_name"]: row for row in shiny_rows}
    canue = {row["lha_name"]: row for row in canue_rows}
    long_rows = []
    summary_rows = []

    for shiny_field in ["pm25", "ozone"]:
        for source_field, notes in variable_notes.items():
            if shiny_field == "pm25" and "pm25" not in source_field.lower():
                continue
            if shiny_field == "ozone" and not any(token in source_field.lower() for token in ["o3", "oz", "ozn"]):
                continue

            rows = []
            for lha_name, shiny_row in shiny.items():
                source_row = canue.get(lha_name)
                if not source_row:
                    continue
                shiny_value = numeric(shiny_row.get(shiny_field))
                rebuilt_value = numeric(source_row.get(source_field))
                if shiny_value is None or rebuilt_value is None:
                    continue
                rows.append(
                    {
                        "lha_name": lha_name,
                        "shiny_field": shiny_field,
                        "source_id": "canue_r2_bcHealth_lha",
                        "source_field": source_field,
                        "shiny_value": shiny_value,
                        "rebuilt_value": rebuilt_value,
                        "difference": round(rebuilt_value - shiny_value, 6),
                        "absolute_difference": round(abs(rebuilt_value - shiny_value), 6),
                        "notes": notes,
                    }
                )
            if not rows:
                continue

            diffs = [row["absolute_difference"] for row in rows]
            xs = [row["shiny_value"] for row in rows]
            ys = [row["rebuilt_value"] for row in rows]
            pg = next((row for row in rows if row["lha_name"] == "Prince George"), None)
            summary_rows.append(
                {
                    "shiny_field": shiny_field,
                    "source_id": "canue_r2_bcHealth_lha",
                    "source_field": source_field,
                    "rows": len(rows),
                    "mean_absolute_difference": round(sum(diffs) / len(diffs), 6),
                    "max_absolute_difference": round(max(diffs), 6),
                    "pearson_r": pearson(xs, ys),
                    "prince_george_shiny": pg["shiny_value"] if pg else None,
                    "prince_george_rebuilt": pg["rebuilt_value"] if pg else None,
                    "prince_george_difference": pg["difference"] if pg else None,
                    "notes": notes,
                }
            )
            long_rows.extend(rows)

    summary_rows.sort(
        key=lambda row: (
            row["shiny_field"],
            row["mean_absolute_difference"],
            -(row["pearson_r"] if row["pearson_r"] is not None else -999),
        )
    )
    return long_rows, summary_rows


def select_best(summary_rows):
    by_field = defaultdict(list)
    for row in summary_rows:
        by_field[row["shiny_field"]].append(row)
    best = []
    for shiny_field, rows in sorted(by_field.items()):
        chosen = dict(rows[0])
        chosen["selection_rank"] = 1
        best.append(chosen)
    return best


def build_best_lha_table(shiny_rows, canue_rows, best_rows):
    canue = {row["lha_name"]: row for row in canue_rows}
    output = []
    for shiny_row in sorted(shiny_rows, key=lambda row: row["lha_name"]):
        lha_name = shiny_row["lha_name"]
        canue_row = canue.get(lha_name, {})
        row = {"lha_name": lha_name}
        for best in best_rows:
            shiny_field = best["shiny_field"]
            source_field = best["source_field"]
            shiny_value = numeric(shiny_row.get(shiny_field))
            rebuilt_value = numeric(canue_row.get(source_field))
            row[f"{shiny_field}_shiny"] = shiny_value
            row[f"{shiny_field}_rebuilt"] = rebuilt_value
            row[f"{shiny_field}_difference"] = (
                round(rebuilt_value - shiny_value, 6)
                if shiny_value is not None and rebuilt_value is not None
                else None
            )
            row[f"{shiny_field}_source"] = f"canue_r2_bcHealth_lha.{source_field}"
        output.append(row)
    return output


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    catalog, catalog_path = load_catalog()
    aggregates = []
    aggregate_manifest = []
    for year in TARGET_YEARS:
        aggregate, local_path, item, downloaded = load_aggregate(catalog, year)
        aggregates.append(aggregate)
        aggregate_manifest.append(
            {
                "year": year,
                "url": item["url"],
                "localPath": str(local_path.relative_to(SCRIPT_DIR)),
                "bytes": item.get("bytes"),
                "variables": len(aggregate.get("variables", [])),
                "boundaryCount": aggregate.get("boundaryCount"),
                "downloaded": downloaded,
            }
        )

    shiny_rows = read_csv(SHINY_PATH)
    canue_rows, variable_notes = build_lha_rows(aggregates)
    long_rows, summary_rows = compare_candidates(shiny_rows, canue_rows, variable_notes)
    best_rows = select_best(summary_rows)
    best_lha_rows = build_best_lha_table(shiny_rows, canue_rows, best_rows)

    write_csv(OUTPUT_DIR / "lha-canue-candidates.csv", canue_rows)
    write_csv(OUTPUT_DIR / "candidate-comparison-long.csv", long_rows)
    write_csv(OUTPUT_DIR / "candidate-comparison-summary.csv", summary_rows)
    write_csv(OUTPUT_DIR / "best-current-mapping.csv", best_rows)
    write_csv(OUTPUT_DIR / "best-current-indicators.csv", best_lha_rows)

    (OUTPUT_DIR / "lha-canue-candidates.json").write_text(json.dumps(canue_rows, indent=2) + "\n")
    (OUTPUT_DIR / "candidate-comparison-summary.json").write_text(json.dumps(summary_rows, indent=2) + "\n")
    (OUTPUT_DIR / "best-current-mapping.json").write_text(json.dumps(best_rows, indent=2) + "\n")
    (OUTPUT_DIR / "best-current-indicators.json").write_text(json.dumps(best_lha_rows, indent=2) + "\n")
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "source": "CANUE R2 public aggregate derivatives",
                "catalogUrl": CATALOG_URL,
                "catalogLocalPath": str(catalog_path.relative_to(SCRIPT_DIR)),
                "shinyTable": str(SHINY_PATH.relative_to(SCRIPT_DIR)),
                "aggregates": aggregate_manifest,
                "outputs": {
                    "lhaCandidates": "lha-canue-candidates.csv",
                    "summary": "candidate-comparison-summary.csv",
                    "bestMapping": "best-current-mapping.csv",
                    "bestIndicators": "best-current-indicators.csv",
                },
                "caveat": "These are existing R2 LHA aggregates. They do not replace the restricted CANUE postal-code source extracts if exact BCEnviroScreen paper-era reproduction is required.",
            },
            indent=2,
        )
        + "\n"
    )
    print(f"BCEnviroScreen CANUE LHA: wrote {OUTPUT_DIR.relative_to(PGMAPS_ROOT)}")


if __name__ == "__main__":
    main()
