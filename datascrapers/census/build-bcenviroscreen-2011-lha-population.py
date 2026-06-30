#!/usr/bin/env python3

import csv
import io
import json
import os
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import requests


SCRIPT_DIR = Path(__file__).resolve().parent
PGMAPS_ROOT = Path(os.environ.get("PGMAPS_ROOT", SCRIPT_DIR.parents[3])).resolve()
OUTPUT_DIR = SCRIPT_DIR / "output" / "bcenviroscreen-census-lha"
RAW_DIR = OUTPUT_DIR / "raw"
OUT_DIR = OUTPUT_DIR / "2011"
CROSSWALK_2016 = OUTPUT_DIR / "2016" / "da-to-lha-crosswalk.csv"
CENSUSMAPPER_BASE = "https://censusmapper.ca/api/v1"
DEFAULT_API_KEY = "CensusMapper_c36f7ab0a43132b3d0b8e83538c4de57"
POP_VECTOR = "v_CA11F_1"


def parse_args(argv):
    args = {"overwrite": "false", "delay": "0.35"}
    index = 0
    while index < len(argv):
        token = argv[index]
        if token.startswith("--"):
            key = token[2:]
            if index + 1 < len(argv) and not argv[index + 1].startswith("--"):
                args[key] = argv[index + 1]
                index += 2
            else:
                args[key] = "true"
                index += 1
        else:
            index += 1
    return args


def numeric(value):
    if value is None:
        return None
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
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


def post_csv(endpoint, payload):
    response = requests.post(endpoint, data=payload, timeout=60)
    if not response.ok:
        raise RuntimeError(f"CensusMapper {response.status_code}: {response.text[:300]}")
    return list(csv.DictReader(io.StringIO(response.text)))


def censusmapper_payload(api_key, level, regions):
    return {
        "api_key": api_key,
        "dataset": "CA11",
        "level": level,
        "regions": json.dumps(regions),
        "vectors": json.dumps([POP_VECTOR]),
        "geo_hierarchy": "true",
    }


def fetch_bc_cds(api_key, overwrite=False):
    cache_path = RAW_DIR / "CA11_bc_cd_population.csv"
    if cache_path.exists() and not overwrite:
        return read_csv(cache_path)
    rows = post_csv(
        f"{CENSUSMAPPER_BASE}/data.csv",
        censusmapper_payload(api_key, "CD", {"PR": ["59"]}),
    )
    write_csv(cache_path, rows)
    return rows


def fetch_da_population_by_cd(api_key, cd_uid, overwrite=False):
    cache_path = RAW_DIR / "CA11_da_population_by_cd" / f"{cd_uid}.csv"
    if cache_path.exists() and not overwrite:
        return read_csv(cache_path)
    rows = post_csv(
        f"{CENSUSMAPPER_BASE}/data.csv",
        censusmapper_payload(api_key, "DA", {"CD": [cd_uid]}),
    )
    write_csv(cache_path, rows)
    return rows


def fetch_csd_population_by_cd(api_key, cd_uid, overwrite=False):
    cache_path = RAW_DIR / "CA11_csd_population_by_cd" / f"{cd_uid}.csv"
    if cache_path.exists() and not overwrite:
        return read_csv(cache_path)
    rows = post_csv(
        f"{CENSUSMAPPER_BASE}/data.csv",
        censusmapper_payload(api_key, "CSD", {"CD": [cd_uid]}),
    )
    write_csv(cache_path, rows)
    return rows


def fetch_da_population_by_csd(api_key, csd_uid, overwrite=False):
    cache_path = RAW_DIR / "CA11_da_population_by_csd" / f"{csd_uid}.csv"
    if cache_path.exists() and not overwrite:
        return read_csv(cache_path)
    rows = post_csv(
        f"{CENSUSMAPPER_BASE}/data.csv",
        censusmapper_payload(api_key, "DA", {"CSD": [csd_uid]}),
    )
    write_csv(cache_path, rows)
    return rows


def population_value(row):
    for key in row:
        if key.startswith(f"{POP_VECTOR}:"):
            return numeric(row.get(key))
    return numeric(row.get("Population "))


def build_lha_population(api_key, overwrite=False, delay=0.35):
    crosswalk_rows = read_csv(CROSSWALK_2016)
    da_to_lha = {row["geo_uid"]: row for row in crosswalk_rows}
    lha_rows = {}
    for row in crosswalk_rows:
        lha_rows.setdefault(
            row["lha_code"],
            {
                "lha_code": row["lha_code"],
                "lha_name": row["lha_name"],
                "hsda_code": row["hsda_code"],
                "hsda_name": row["hsda_name"],
                "ha_code": row["ha_code"],
                "ha_name": row["ha_name"],
                "census_year": 2011,
                "dataset": "CA11",
                "da_count_2011_population": 0,
                "population_sum": 0,
            },
        )

    cds = fetch_bc_cds(api_key, overwrite=overwrite)
    da_rows = []
    unmatched = []
    skipped_regions = []
    seen_da = set()
    for cd in cds:
        cd_uid = cd["GeoUID"]
        print(f"2011 CensusMapper DA population: CD {cd_uid}", flush=True)
        try:
            cd_da_rows = fetch_da_population_by_cd(api_key, cd_uid, overwrite=overwrite)
        except RuntimeError as error:
            if "exceeds API limit" not in str(error):
                raise
            print(f"2011 CensusMapper DA population: CD {cd_uid} too large; falling back to CSD chunks", flush=True)
            cd_da_rows = []
            try:
                csd_rows = fetch_csd_population_by_cd(api_key, cd_uid, overwrite=overwrite)
            except RuntimeError as cd_error:
                skipped_regions.append(
                    {
                        "level": "CD",
                        "geo_uid": cd_uid,
                        "parent_cd_uid": "",
                        "region_name": cd.get("Region Name"),
                        "population": numeric(cd.get("Population ")),
                        "error": str(cd_error),
                    }
                )
                csd_rows = []
            for csd in csd_rows:
                csd_uid = csd["GeoUID"]
                print(f"  CSD {csd_uid}", flush=True)
                try:
                    cd_da_rows.extend(fetch_da_population_by_csd(api_key, csd_uid, overwrite=overwrite))
                except RuntimeError as csd_error:
                    skipped_regions.append(
                        {
                            "level": "CSD",
                            "geo_uid": csd_uid,
                            "parent_cd_uid": cd_uid,
                            "region_name": csd.get("Region Name"),
                            "population": numeric(csd.get("Population ")),
                            "error": str(csd_error),
                        }
                    )
                time.sleep(delay)
        for row in cd_da_rows:
            geo_uid = row["GeoUID"]
            if geo_uid in seen_da:
                continue
            seen_da.add(geo_uid)
            pop = population_value(row)
            da_rows.append({"geo_uid": geo_uid, "population": pop, "cd_uid": cd_uid})
            assignment = da_to_lha.get(geo_uid)
            if not assignment:
                unmatched.append({"geo_uid": geo_uid, "population": pop, "cd_uid": cd_uid})
                continue
            lha = lha_rows[assignment["lha_code"]]
            lha["da_count_2011_population"] += 1
            lha["population_sum"] += pop or 0
        time.sleep(delay)

    rows = [lha_rows[key] for key in sorted(lha_rows)]
    return rows, da_rows, unmatched, skipped_regions, cds


def main():
    args = parse_args(os.sys.argv[1:])
    overwrite = args.get("overwrite") == "true"
    delay = float(args.get("delay", "0.35"))
    api_key = os.environ.get("CM_API_KEY") or args.get("api-key") or DEFAULT_API_KEY
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    rows, da_rows, unmatched, skipped_regions, cds = build_lha_population(api_key, overwrite=overwrite, delay=delay)
    write_csv(OUT_DIR / "lha-population.csv", rows)
    (OUT_DIR / "lha-population.json").write_text(json.dumps(rows, indent=2) + "\n")
    write_csv(OUT_DIR / "da-population.csv", da_rows)
    write_csv(OUT_DIR / "unmatched-da-population.csv", unmatched)
    write_csv(OUT_DIR / "skipped-regions.csv", skipped_regions)
    (OUT_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "source": "CensusMapper 2011 Census DA population, joined to the existing 2016 DA-to-LHA crosswalk by DAUID",
                "dataset": "CA11",
                "populationVector": POP_VECTOR,
                "cdCount": len(cds),
                "daRows": len(da_rows),
                "matchedDaRows": len(da_rows) - len(unmatched),
                "unmatchedDaRows": len(unmatched),
                "skippedRegionRows": len(skipped_regions),
                "skippedRegionPopulation": sum((row.get("population") or 0) for row in skipped_regions),
                "crosswalk": str(CROSSWALK_2016.relative_to(PGMAPS_ROOT)),
                "note": "This is a pragmatic 2011-population denominator for PHSA cancer validation. It reuses the 2016 DA-to-LHA crosswalk, so DA boundary changes between 2011 and 2016 are reported as unmatched.",
            },
            indent=2,
        )
        + "\n"
    )
    print(f"BCEnviroScreen 2011 LHA population: wrote {OUT_DIR.relative_to(PGMAPS_ROOT)}")


if __name__ == "__main__":
    main()
