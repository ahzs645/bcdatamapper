#!/usr/bin/env python3

import csv
import io
import json
import os
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
PGMAPS_ROOT = Path(os.environ.get("PGMAPS_ROOT", SCRIPT_DIR.parents[3])).resolve()
VENDOR_ROOT = SCRIPT_DIR.parents[1]
PHSA_DIR = VENDOR_ROOT / "datascrapers" / "health" / "phsa-community-health" / "output" / "downloads"
CHSA_LHA_CROSSWALK = VENDOR_ROOT / "datascrapers" / "health" / "phsa-community-health" / "output" / "chsa-lha-crosswalk.csv"
SHINY_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed" / "compact" / "benchmark" / "official-shiny-lha-indicators.csv"
CENSUS_BASE = VENDOR_ROOT / "datascrapers" / "census" / "output" / "bcenviroscreen-census-lha"
OUTPUT_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-health-lha"


def decode_csv(path):
    data = path.read_bytes()
    sample = data[: min(len(data), 200)]
    if data.startswith(b"\xff\xfe") or sample.count(b"\x00") > len(sample) / 4:
        return data.decode("utf-16le").lstrip("\ufeff")
    if data.startswith(b"\xfe\xff"):
        raise ValueError(f"Unsupported UTF-16BE CSV: {path}")
    return data.decode("utf-8-sig")


def read_csv(path):
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def read_json(path):
    return json.loads(path.read_text())


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


def slug(value):
    text = str(value).lower()
    text = text.replace("+", "plus")
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return re.sub(r"_+", "_", text).strip("_")


def year_slug(value):
    text = str(value).strip()
    text = text.replace("FY ", "fy_")
    text = text.replace(".", "_")
    text = re.sub(r"[^A-Za-z0-9]+", "_", text)
    return re.sub(r"_+", "_", text).strip("_").lower()


def lha_name_from_phsa(value):
    if not value:
        return None
    return re.sub(r"\s+LHA$", "", value.strip())


def chsa_name_from_phsa(value):
    if not value:
        return None
    return re.sub(r"\s+CHSA$", "", value.strip())


def load_shiny_lhas():
    return {row["lha_name"] for row in read_csv(SHINY_PATH)}


def load_census_population(year):
    path = CENSUS_BASE / str(year) / ("lha-population.json" if int(year) == 2011 else "lha-socioeconomic.json")
    if not path.exists():
        return {}
    rows = read_json(path)
    return {row["lha_name"]: numeric(row.get("population_sum")) for row in rows}


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


def iter_phsa_rows():
    for path in sorted(PHSA_DIR.glob("LHA_*.csv")):
        topic = path.stem.rsplit("_", 1)[1]
        reader = csv.DictReader(io.StringIO(decode_csv(path)))
        for row in reader:
            indicator = row.get("Indicator Name")
            if not indicator or indicator.startswith("Downloaded from"):
                continue
            value = numeric(row.get("Indicator Value"))
            if value is None:
                continue
            yield {
                "path": path,
                "topic": topic,
                "indicator": indicator,
                "jurisdiction_code": row.get("Jurisdiction Code"),
                "lha_name": lha_name_from_phsa(row.get("Jurisdiction Name")),
                "year": row.get("Year(s)"),
                "sex": row.get("Sex") or "Total",
                "value": value,
                "unit": row.get("Unit"),
                "data_source": row.get("Data Source"),
            }


def load_chsa_lha_crosswalk():
    if not CHSA_LHA_CROSSWALK.exists():
        return {}
    mapping = defaultdict(list)
    for row in read_csv(CHSA_LHA_CROSSWALK):
        weight = numeric(row.get("chsa_population_weight_in_lha"))
        if weight is None:
            continue
        mapping[row["chsa_name"]].append(
            {
                "lha_name": row["lha_name"],
                "weight": weight,
            }
        )
    return mapping


def iter_chsa_rows():
    for path in sorted(PHSA_DIR.glob("CHSA_*.csv")):
        topic = path.stem.rsplit("_", 1)[1]
        reader = csv.DictReader(io.StringIO(decode_csv(path)))
        for row in reader:
            indicator = row.get("Indicator Name")
            if not indicator or indicator.startswith("Downloaded from"):
                continue
            value = numeric(row.get("Indicator Value"))
            if value is None:
                continue
            yield {
                "path": path,
                "topic": topic,
                "indicator": indicator,
                "jurisdiction_code": row.get("Jurisdiction Code"),
                "chsa_name": chsa_name_from_phsa(row.get("Jurisdiction Name")),
                "year": row.get("Year(s)"),
                "sex": row.get("Sex") or "Total",
                "value": value,
                "unit": row.get("Unit"),
                "data_source": row.get("Data Source"),
            }


def build_rows():
    shiny_lhas = load_shiny_lhas()
    chsa_lha_crosswalk = load_chsa_lha_crosswalk()
    population_2011 = load_census_population(2011)
    population_2016 = load_census_population(2016)
    population_2021 = load_census_population(2021)

    wide = {lha: {"lha_name": lha} for lha in sorted(shiny_lhas)}
    source_rows = []
    chsa_weighted = defaultdict(lambda: defaultdict(float))
    chsa_weight_sums = defaultdict(lambda: defaultdict(float))
    cancer_counts = defaultdict(lambda: defaultdict(float))

    for row in iter_phsa_rows():
        lha_name = row["lha_name"]
        if lha_name not in shiny_lhas:
            continue
        indicator_slug = slug(row["indicator"])
        year = year_slug(row["year"])
        sex = slug(row["sex"])
        unit = slug(row["unit"])
        topic = slug(row["topic"])
        value = row["value"]

        source_rows.append(row)

        if "cancer" in indicator_slug:
            if row["sex"] in {"Male", "Female"}:
                cancer_counts[(lha_name, year)][row["sex"]] += value
            field = f"phsa_{topic}_{indicator_slug}_{year}_{sex}_{unit}"
        else:
            field = f"phsa_{topic}_{indicator_slug}_{year}_{unit}"
            if row["sex"] != "Total":
                field = f"phsa_{topic}_{indicator_slug}_{year}_{sex}_{unit}"
        wide[lha_name][field] = value

    for row in iter_chsa_rows():
        mappings = chsa_lha_crosswalk.get(row["chsa_name"], [])
        if not mappings:
            continue
        indicator_slug = slug(row["indicator"])
        year = year_slug(row["year"])
        sex = slug(row["sex"])
        unit = slug(row["unit"])
        topic = slug(row["topic"])
        if row["sex"] != "Total":
            field = f"phsa_chsa_to_lha_{topic}_{indicator_slug}_{year}_{sex}_{unit}"
        else:
            field = f"phsa_chsa_to_lha_{topic}_{indicator_slug}_{year}_{unit}"
        for mapping in mappings:
            lha_name = mapping["lha_name"]
            if lha_name not in shiny_lhas:
                continue
            weight = mapping["weight"]
            chsa_weighted[lha_name][field] += row["value"] * weight
            chsa_weight_sums[lha_name][field] += weight

    for lha_name, fields in chsa_weighted.items():
        for field, weighted_sum in fields.items():
            weight_sum = chsa_weight_sums[lha_name][field]
            if weight_sum:
                wide[lha_name][field] = round(weighted_sum / weight_sum, 6)

    for (lha_name, year), by_sex in cancer_counts.items():
        total = by_sex.get("Male", 0) + by_sex.get("Female", 0)
        wide[lha_name][f"phsa_cancer_all_cause_cancer_incident_cases_all_ages_{year}_total_count"] = total
        pop_2011 = population_2011.get(lha_name)
        pop_2016 = population_2016.get(lha_name)
        pop_2021 = population_2021.get(lha_name)
        if pop_2011:
            wide[lha_name][f"phsa_cancer_all_cause_cancer_incident_cases_all_ages_{year}_total_per_1000_pop2011"] = round(total / pop_2011 * 1000, 6)
        if pop_2016:
            wide[lha_name][f"phsa_cancer_all_cause_cancer_incident_cases_all_ages_{year}_total_per_1000_pop2016"] = round(total / pop_2016 * 1000, 6)
        if pop_2021:
            wide[lha_name][f"phsa_cancer_all_cause_cancer_incident_cases_all_ages_{year}_total_per_1000_pop2021"] = round(total / pop_2021 * 1000, 6)

    add_hypertension_rolling_candidates(wide)

    return list(wide.values()), source_rows


def add_hypertension_rolling_candidates(wide):
    prefix = "phsa_general_health_hypertension_age_standardized_incidence_rate_per_1000_population_20plus_yrs"
    suffix = "per_1000_population"
    sexes = {
        "total": "",
        "male": "_male",
        "female": "_female",
    }
    for lha_name, row in wide.items():
        for sex, sex_suffix in sexes.items():
            for start_year in range(2001, 2021):
                for window_size in range(2, 9):
                    end_year = start_year + window_size
                    if end_year > 2022:
                        continue
                    window = [
                        f"{prefix}_fy_{year}_{year + 1}{sex_suffix}_{suffix}"
                        for year in range(start_year, end_year)
                    ]
                    values = [numeric(row.get(field)) for field in window]
                    if any(value is None for value in values):
                        continue
                    out_field = f"{prefix}_fy_{start_year}_{end_year}_{sex}_rolling_mean_{len(window)}y_{suffix}"
                    row[out_field] = round(sum(values) / len(values), 6)


def main():
    rows, source_rows = build_rows()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    write_csv(OUTPUT_DIR / "lha-health-candidates.csv", rows)
    (OUTPUT_DIR / "lha-health-candidates.json").write_text(json.dumps(rows, indent=2) + "\n")
    write_csv(OUTPUT_DIR / "source-rows.csv", source_rows)
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "source": "PHSA Community Health Atlas GetTheData LHA CSV downloads",
                "sourceDirectory": str(PHSA_DIR.relative_to(PGMAPS_ROOT)),
                "shinyBenchmark": str(SHINY_PATH.relative_to(PGMAPS_ROOT)),
                "notes": [
                    "Cancer public LHA download provides sex-specific 2008-2012 case counts; per-1000 candidates use rebuilt Census LHA population denominators as diagnostics.",
                    "Chronic disease and low-birth-weight rows are carried through as year-specific candidate columns for validation against the Shiny table.",
                    "CHSA chronic-disease rows are also population-weighted up to LHA using the staged CHSA-to-LHA crosswalk as additional diagnostic candidates.",
                ],
                "rowCount": len(rows),
                "sourceRowCount": len(source_rows),
            },
            indent=2,
        )
        + "\n"
    )
    print(f"BCEnviroScreen PHSA health candidates: wrote {OUTPUT_DIR.relative_to(PGMAPS_ROOT)}")


if __name__ == "__main__":
    main()
