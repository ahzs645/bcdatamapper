#!/usr/bin/env python3

import argparse
import concurrent.futures as futures
import csv
import json
import re
import subprocess
import time
from pathlib import Path

import requests


SCRIPT_DIR = Path(__file__).resolve().parent
RAW_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed" / "compact" / "traffic-data-program"
TMS_GEOJSON_PATH = RAW_DIR / "tig-tms-geometry-ext-v.geojson"
PDF_DIR = RAW_DIR / "tms-site-report-pdfs"
OUTPUT_PATH = RAW_DIR / "tdp-tms-site-report-annual-aadt.csv"
ERROR_PATH = RAW_DIR / "tdp-tms-site-report-errors.csv"
REPORT_URL = "https://prdoas6.pub-apps.th.gov.bc.ca/tig-public/Report.do"


def numeric(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_aadt_table(text):
    lines = [line.strip() for line in text.splitlines()]
    try:
        index = lines.index("Average Daily Traffic Volumes") + 1
    except ValueError:
        return {}

    year_pattern = re.compile(r"^20(1[6-9]|2[0-5])$")
    number_pattern = re.compile(r"^[0-9][0-9,]*$")
    values = {}
    while index < len(lines):
        line = lines[index]
        if line.startswith("CAV05:"):
            break
        if not year_pattern.fullmatch(line):
            index += 1
            continue

        year = int(line)
        numbers = []
        lookahead = index + 1
        while lookahead < len(lines):
            candidate = lines[lookahead]
            if candidate.startswith("CAV05:") or year_pattern.fullmatch(candidate):
                break
            if number_pattern.fullmatch(candidate):
                numbers.append(int(candidate.replace(",", "")))
            lookahead += 1
        if numbers:
            values[year] = numbers[0]
        index = lookahead
    return values


def pdf_text(path):
    return subprocess.check_output(["pdftotext", str(path), "-"], text=True, timeout=30, errors="ignore")


def download_and_parse(feature, force=False):
    properties = feature.get("properties", {})
    site_code = properties.get("SITE_CODE")
    pdb_site_id = properties.get("PDB_SITE_ID")
    if not site_code or not pdb_site_id:
        return None, {"site_code": site_code, "pdb_site_id": pdb_site_id, "error": "missing site code or pdb site id"}

    PDF_DIR.mkdir(parents=True, exist_ok=True)
    pdf_path = PDF_DIR / f"{site_code}-{pdb_site_id}.pdf"
    try:
        if force or not pdf_path.exists() or pdf_path.stat().st_size < 1000:
            response = requests.get(REPORT_URL, params={"pdbSiteId": str(pdb_site_id)}, timeout=60)
            if response.status_code != 200 or not response.content:
                return None, {
                    "site_code": site_code,
                    "pdb_site_id": pdb_site_id,
                    "error": f"http {response.status_code} bytes {len(response.content)}",
                }
            pdf_path.write_bytes(response.content)

        with pdf_path.open("rb") as handle:
            if handle.read(4) != b"%PDF":
                return None, {"site_code": site_code, "pdb_site_id": pdb_site_id, "error": "cached response is not a PDF"}

        values = parse_aadt_table(pdf_text(pdf_path))
        coordinates = feature.get("geometry", {}).get("coordinates") or [None, None]
        row = {
            "site_code": site_code,
            "pdb_site_id": pdb_site_id,
            "tms_ext_id": properties.get("TMS_EXT_ID"),
            "utv_segment_ext_id": properties.get("UTV_SEGMENT_EXT_ID"),
            "type_code": properties.get("TYPE_CODE"),
            "type_description": properties.get("TYPE_DESCRIPTION"),
            "status_code": properties.get("STATUS_CODE"),
            "status_description": properties.get("STATUS_DESCRIPTION"),
            "description": properties.get("DESCRIPTION"),
            "lon": coordinates[0],
            "lat": coordinates[1],
        }
        for year in range(2016, 2026):
            row[f"aadt_{year}"] = values.get(year)
        return row, None
    except Exception as error:
        return None, {"site_code": site_code, "pdb_site_id": pdb_site_id, "error": repr(error)}


def write_csv(path, rows, headers):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description="Download and parse BC TDP generated TMS site-report AADT PDFs.")
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--force", action="store_true", help="Re-download PDFs even when cached.")
    args = parser.parse_args()

    if not TMS_GEOJSON_PATH.exists():
        raise SystemExit(f"Missing {TMS_GEOJSON_PATH}. Run environmental-burden:bc-enviro-screen:traffic-lha once first.")

    features = json.loads(TMS_GEOJSON_PATH.read_text()).get("features", [])
    rows = []
    errors = []
    started = time.time()
    with futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_rows = [executor.submit(download_and_parse, feature, args.force) for feature in features]
        for index, future in enumerate(futures.as_completed(future_rows), 1):
            row, error = future.result()
            if row:
                rows.append(row)
            if error:
                errors.append(error)
            if index % 100 == 0:
                print(f"processed {index} rows {len(rows)} errors {len(errors)} elapsed {time.time() - started:.1f}s", flush=True)

    headers = [
        "site_code",
        "pdb_site_id",
        "tms_ext_id",
        "utv_segment_ext_id",
        "type_code",
        "type_description",
        "status_code",
        "status_description",
        "description",
        "lon",
        "lat",
        *[f"aadt_{year}" for year in range(2016, 2026)],
    ]
    rows.sort(key=lambda row: str(row["site_code"]))
    write_csv(OUTPUT_PATH, rows, headers)
    write_csv(ERROR_PATH, errors, ["site_code", "pdb_site_id", "error"])

    pdf_size_mb = sum(path.stat().st_size for path in PDF_DIR.glob("*.pdf")) / 1024 / 1024
    print(f"BCEnviroScreen TMS reports: wrote {OUTPUT_PATH.relative_to(SCRIPT_DIR)}")
    print(f"Parsed rows: {len(rows)}; errors: {len(errors)}; cached PDFs: {pdf_size_mb:.1f} MB")


if __name__ == "__main__":
    main()
