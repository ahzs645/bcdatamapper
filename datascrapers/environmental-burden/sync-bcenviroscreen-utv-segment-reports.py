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
UTV_GEOJSON_PATH = RAW_DIR / "tig-utv-segment-ext.geojson"
PDF_DIR = RAW_DIR / "utv-segment-report-pdfs"
OUTPUT_PATH = RAW_DIR / "tdp-utv-segment-report-aadt.csv"
ERROR_PATH = RAW_DIR / "tdp-utv-segment-report-errors.csv"
IDENTIFY_URL = "https://prdoas6.pub-apps.th.gov.bc.ca/tig-public/UTVSIdentify.do"
REPORT_URL = "https://prdoas6.pub-apps.th.gov.bc.ca/tig-public/UTVSReport.do"


def pdf_text(path):
    return subprocess.check_output(["pdftotext", "-layout", str(path), "-"], text=True, timeout=30, errors="ignore")


def parse_volume_row(text, label):
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if not re.search(r"\b2016\b.*\b2025\b", line):
            continue
        positions = [(match.group(), match.start()) for match in re.finditer(r"20\d{2}", line)]
        for row in lines[index + 1 : index + 8]:
            if not re.match(rf"\s*{label}\b", row):
                continue
            values = {}
            for position_index, (year, start) in enumerate(positions):
                end = positions[position_index + 1][1] if position_index + 1 < len(positions) else len(row)
                chunk = row[start:end].strip()
                match = re.search(r"[-\d][\d,]*", chunk)
                if match:
                    values[int(year)] = int(match.group().replace(",", ""))
            return values
    return {}


def parse_report_text(text):
    return {
        "aadt": parse_volume_row(text, "AADT"),
        "sadt": parse_volume_row(text, "SADT"),
    }


def download_and_parse(feature, force=False):
    properties = feature.get("properties", {})
    segment_number = str(properties.get("SEGMENT_NUMBER") or "").strip()
    if not segment_number:
        return None, {"segment_number": "", "error": "missing segment number"}

    PDF_DIR.mkdir(parents=True, exist_ok=True)
    pdf_path = PDF_DIR / f"{segment_number.replace('/', '_')}.pdf"
    try:
        if force or not pdf_path.exists() or pdf_path.stat().st_size < 1000:
            session = requests.Session()
            identify = session.get(IDENTIFY_URL, params={"SEGMENT_NUMBER": segment_number}, timeout=30)
            identify.raise_for_status()
            response = session.get(REPORT_URL, timeout=60)
            if response.status_code != 200 or not response.content.startswith(b"%PDF"):
                return None, {
                    "segment_number": segment_number,
                    "error": f"http {response.status_code} non-pdf bytes {len(response.content)}",
                }
            pdf_path.write_bytes(response.content)

        with pdf_path.open("rb") as handle:
            if handle.read(4) != b"%PDF":
                return None, {"segment_number": segment_number, "error": "cached response is not a PDF"}

        values = parse_report_text(pdf_text(pdf_path))
        row = {
            "segment_number": segment_number,
            "description": properties.get("DESCRIPTION"),
            "traffic_pattern_type_ext_code": properties.get("TRAFFIC_PATTERN_TYPE_EXT_CODE"),
            "status_type_ext_code": properties.get("STATUS_TYPE_EXT_CODE"),
            "tms_ext_id": properties.get("TMS_EXT_ID"),
            "map_rendering_aadt": properties.get("MAP_RENDERING_AADT"),
            "pdf_bytes": pdf_path.stat().st_size,
        }
        for year in range(2016, 2026):
            row[f"aadt_{year}"] = values["aadt"].get(year)
            row[f"sadt_{year}"] = values["sadt"].get(year)
        return row, None
    except Exception as error:
        return None, {"segment_number": segment_number, "error": repr(error)}


def write_csv(path, rows, headers):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description="Download and parse BC TDP generated UTV segment AADT/SADT PDFs.")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--force", action="store_true", help="Re-download PDFs even when cached.")
    args = parser.parse_args()

    if not UTV_GEOJSON_PATH.exists():
        raise SystemExit(f"Missing {UTV_GEOJSON_PATH}. Run environmental-burden:bc-enviro-screen:traffic-lha once first.")

    features = json.loads(UTV_GEOJSON_PATH.read_text()).get("features", [])
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
            if index % 50 == 0:
                print(f"processed {index} rows {len(rows)} errors {len(errors)} elapsed {time.time() - started:.1f}s", flush=True)

    headers = [
        "segment_number",
        "description",
        "traffic_pattern_type_ext_code",
        "status_type_ext_code",
        "tms_ext_id",
        "map_rendering_aadt",
        "pdf_bytes",
        *[f"aadt_{year}" for year in range(2016, 2026)],
        *[f"sadt_{year}" for year in range(2016, 2026)],
    ]
    rows.sort(key=lambda row: str(row["segment_number"]))
    write_csv(OUTPUT_PATH, rows, headers)
    write_csv(ERROR_PATH, errors, ["segment_number", "error"])

    pdf_size_mb = sum(path.stat().st_size for path in PDF_DIR.glob("*.pdf")) / 1024 / 1024
    rows_2018 = sum(1 for row in rows if row.get("aadt_2018") not in [None, ""])
    print(f"BCEnviroScreen UTV reports: wrote {OUTPUT_PATH.relative_to(SCRIPT_DIR)}")
    print(f"Parsed rows: {len(rows)}; rows with 2018 AADT: {rows_2018}; errors: {len(errors)}; cached PDFs: {pdf_size_mb:.1f} MB")


if __name__ == "__main__":
    main()
