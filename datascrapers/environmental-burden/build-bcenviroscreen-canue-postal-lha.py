#!/usr/bin/env python3

import json
import subprocess
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
VENDOR_ROOT = SCRIPT_DIR.parents[1]
PGMAPS_ROOT = VENDOR_ROOT.parent.parent
SOURCE_DIR = Path(
    "/Users/ahmadjalil/Library/CloudStorage/GoogleDrive-ahzs645@gmail.com/"
    "My Drive/University/Research/Grad/Data/PGMaps/BCEnviroScreen/canue-source-zips"
)
CATALOG = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed" / "compact" / "canue" / "canue-bc-grid-v2-app-catalog.json"
PLAN = VENDOR_ROOT / "docs" / "canue-map-layer-plan-bc.json"
OUTPUT_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed" / "compact" / "canue-postal-aggregates"
POSTAL_AGGREGATOR = VENDOR_ROOT / "datascrapers" / "canue" / "v2" / "build-canue-v2-postal-boundary-aggregates.py"
TARGET_YEARS = [2012, 2015]
SOURCE_GROUPS = {
    "pm25": ["pm25dal_a", "pm25dalb_a", "pm25dalc_a"],
    "ozone": ["o3chg_a", "aqozn_mn", "aqozn_8h"],
}
TARGET_DATASETS = {dataset for datasets in SOURCE_GROUPS.values() for dataset in datasets}


def collect_required_archives():
    plan = json.loads(PLAN.read_text())
    required = {}

    def walk(value):
        if isinstance(value, dict):
            dataset_id = value.get("datasetId")
            years = set(value.get("years") or [])
            archives = value.get("sourceArchives") or []
            if dataset_id in TARGET_DATASETS and years.intersection(TARGET_YEARS):
                required[dataset_id] = archives
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(plan)
    return required


def check_sources():
    required = collect_required_archives()
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    missing_groups = {}
    available = {
        dataset_id: sorted(SOURCE_DIR.glob(f"{dataset_id}_*.zip"))
        for dataset_id in required
    }
    for group_name, datasets in SOURCE_GROUPS.items():
        if not any(available.get(dataset_id) for dataset_id in datasets):
            missing_groups[group_name] = {
                dataset_id: required.get(dataset_id, [])
                for dataset_id in datasets
                if dataset_id in required
            }
    return missing_groups


def run_year(year):
    cmd = [
        sys.executable,
        str(POSTAL_AGGREGATOR),
        "--catalog",
        str(CATALOG),
        "--plan",
        str(PLAN),
        "--source-dir",
        str(SOURCE_DIR),
        "--output-dir",
        str(OUTPUT_DIR),
        "--family",
        "air-quality",
        "--year",
        str(year),
        "--source",
        "bcHealth",
        "--level",
        "lha",
        "--continue-on-error",
    ]
    subprocess.run(cmd, cwd=PGMAPS_ROOT, check=True)


def main():
    missing = check_sources()
    if missing:
        print("Missing CANUE source ZIPs in:", SOURCE_DIR)
        print("Add at least one matching ZIP for each source group. Example expected names:")
        for group_name, datasets in sorted(missing.items()):
            print(f"- {group_name}:")
            for dataset_id, archives in sorted(datasets.items()):
                print(f"  - {dataset_id}_*.zip")
                for archive in archives[:3]:
                    print(f"    example: {archive}")
        raise SystemExit(2)

    for year in TARGET_YEARS:
        run_year(year)
    print(f"BCEnviroScreen CANUE postal LHA aggregates wrote {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
