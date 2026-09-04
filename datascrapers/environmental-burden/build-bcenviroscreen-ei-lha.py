#!/usr/bin/env python3

import csv
import io
import json
import os
import re
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
PGMAPS_ROOT = Path(os.environ.get("PGMAPS_ROOT", SCRIPT_DIR.parents[3])).resolve()
OUTPUT_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "rebuilt-ei-lha"
EI_ZIP_PATH = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed" / "compact" / "statcan-ei" / "14100323-eng.zip"
CENSUS_INCOME_SOURCES_ZIP_PATH = (
    SCRIPT_DIR
    / "output"
    / "bc-enviro-screen"
    / "raw-rebuild-seed"
    / "compact"
    / "statcan-census-income-sources"
    / "98-400-X2016119.zip"
)
CENSUS_BASE = SCRIPT_DIR.parent / "census" / "output" / "bcenviroscreen-census-lha"
DA_CROSSWALK_PATH = CENSUS_BASE / "2016" / "da-to-lha-crosswalk.csv"
DA_RECORDS_PATH = CENSUS_BASE / "raw" / "CA16_bc_da_selected_records.json"
CENSUS_LHA_PATH = CENSUS_BASE / "2016" / "lha-socioeconomic.json"
PHSA_BASE = SCRIPT_DIR.parent / "health" / "phsa-community-health" / "output"
PHSA_CHSA_LHA_CROSSWALK = PHSA_BASE / "chsa-lha-crosswalk.csv"
PHSA_DOWNLOADS_DIR = PHSA_BASE / "downloads"


BENEFIT_DETAILS = [
    "All types of income benefits",
    "Regular benefits",
    "Regular benefits without declared earnings",
]
ANNUAL_YEARS = ["2014", "2015", "2016", "2017", "2018"]
HISTORICAL_PERIODS = {
    # Island Health's archived LHA profiles describe a four-quarter average
    # from December 2011 through September 2012. Keep it separate from the
    # annual candidates so the provenance is explicit.
    "2011_12_four_quarter_end_sep_2012": ["2011-12", "2012-03", "2012-06", "2012-09"],
}
HISTORICAL_DATES = {date for dates in HISTORICAL_PERIODS.values() for date in dates}
CENSUS_INCOME_SOURCE_MEMBERS = {
    "17": "ei_benefits",
    "18": "ei_regular_benefits",
    "19": "ei_other_benefits",
    "9": "government_transfers",
    "26": "social_assistance_benefits",
}


def safe_key(value):
    return (
        value.lower()
        .replace("+", "plus")
        .replace("&", "and")
        .replace("/", "_")
        .replace(" ", "_")
        .replace("-", "_")
    )


def slug_key(value):
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


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
            "cd_population_share": round(cd_populations[primary_cd] / total_population, 6) if total_population else None,
            "da_count_in_cd": da_count_by_lha_cd[lha_name][primary_cd],
            "da_count_total": sum(da_count_by_lha_cd[lha_name].values()),
        }
    return crosswalk


def load_lha_csd_weights():
    da_records = {row["geo_uid"]: row for row in json.loads(DA_RECORDS_PATH.read_text())}
    weights = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))

    for row in read_csv(DA_CROSSWALK_PATH):
        geo_uid = row["geo_uid"]
        record = da_records.get(geo_uid, {})
        lha_name = row["lha_name"]
        csd_code = geo_uid[:7]
        weights[lha_name][csd_code]["population"] += record.get("population") or 0
        weights[lha_name][csd_code]["age_15plus"] += record.get("low_education_15plus_denominator") or 0
    return weights


def load_cd_denominators():
    denominators = defaultdict(lambda: defaultdict(float))
    for row in json.loads(DA_RECORDS_PATH.read_text()):
        cd_code = row["geo_uid"][:4]
        denominators[cd_code]["population"] += row.get("population") or 0
        denominators[cd_code]["labour_force"] += row.get("labour_force_denominator") or 0
        denominators[cd_code]["age_15plus"] += row.get("low_education_15plus_denominator") or 0
    return denominators


def load_lha_denominators():
    denominators = {}
    for row in json.loads(CENSUS_LHA_PATH.read_text()):
        denominators[row["lha_name"]] = {
            "population": row.get("population_sum"),
            "labour_force": row.get("unemployment_denominator"),
            "age_15plus": row.get("low_education_15plus_denominator"),
        }
    return denominators


def load_cd_ei_counts():
    if not EI_ZIP_PATH.exists():
        raise FileNotFoundError(f"Missing StatCan EI ZIP: {EI_ZIP_PATH}")

    monthly = defaultdict(list)
    cd_names = {}
    with zipfile.ZipFile(EI_ZIP_PATH) as archive:
        with archive.open("14100323.csv") as raw:
            text = (line.decode("utf-8-sig", errors="replace") for line in raw)
            reader = csv.DictReader(text)
            for row in reader:
                dguid = row.get("DGUID", "")
                if not dguid.startswith("2016A000359"):
                    continue
                cd_code = dguid[-4:]
                if not cd_code.startswith("59"):
                    continue
                if row.get("Sex") != "Both sexes" or row.get("Age group") != "15 years and over":
                    continue
                detail = row.get("Beneficiary detail")
                if detail not in BENEFIT_DETAILS:
                    continue
                value = numeric(row.get("VALUE"))
                if value is None:
                    continue
                ref_date = row["REF_DATE"]
                year = ref_date[:4]
                if year not in ANNUAL_YEARS and ref_date not in HISTORICAL_DATES:
                    continue
                cd_names[cd_code] = row.get("GEO", "")
                monthly[(cd_code, ref_date, detail)].append(value)

    periods = {}
    cd_codes = {key[0] for key in monthly}
    for cd_code in cd_codes:
        for year in ANNUAL_YEARS:
            for detail in BENEFIT_DETAILS:
                values = [
                    value
                    for (candidate_cd, ref_date, candidate_detail), rows in monthly.items()
                    if candidate_cd == cd_code and candidate_detail == detail and ref_date.startswith(f"{year}-")
                    for value in rows
                ]
                if values:
                    periods[(cd_code, year, detail)] = sum(values) / len(values)
        for period_key, ref_dates in HISTORICAL_PERIODS.items():
            for detail in BENEFIT_DETAILS:
                values = [
                    value
                    for ref_date in ref_dates
                    for value in monthly.get((cd_code, ref_date, detail), [])
                ]
                if len(values) == len(ref_dates):
                    periods[(cd_code, period_key, detail)] = sum(values) / len(values)
    return periods, cd_names


def load_csd_census_income_sources():
    if not CENSUS_INCOME_SOURCES_ZIP_PATH.exists():
        return {}, {}

    rows = defaultdict(dict)
    labels = {}
    with zipfile.ZipFile(CENSUS_INCOME_SOURCES_ZIP_PATH) as archive:
        csv_name = next(name for name in archive.namelist() if name.lower().endswith(".csv") and "_data" in name.lower())
        with archive.open(csv_name) as raw:
            text = (line.decode("utf-8-sig", errors="replace") for line in raw)
            reader = csv.DictReader(text)
            for row in reader:
                geo_code = (row.get("GEO_CODE (POR)") or "").strip()
                if not geo_code.startswith("59") or len(geo_code) != 7:
                    continue
                member = (row.get("Member ID: Income sources and taxes (34)") or "").strip()
                source_key = CENSUS_INCOME_SOURCE_MEMBERS.get(member)
                if not source_key:
                    continue
                label = row.get("DIM: Income sources and taxes (34)") or source_key
                labels[source_key] = label
                rows[geo_code]["csd_name"] = row.get("GEO_NAME", "")
                rows[geo_code][f"statcan_census_2016_{source_key}_total_age_15plus"] = numeric(
                    row.get("Dim: Income statistics (4): Member ID: [1]: Total - Population aged 15 years and over")
                )
                rows[geo_code][f"statcan_census_2016_{source_key}_with_amount"] = numeric(
                    row.get("Dim: Income statistics (4): Member ID: [2]: With an amount")
                )
                rows[geo_code][f"statcan_census_2016_{source_key}_percent_with_amount"] = numeric(
                    row.get("Dim: Income statistics (4): Member ID: [3]: Percentage with an amount (%)")
                )
                rows[geo_code][f"statcan_census_2016_{source_key}_median_amount"] = numeric(
                    row.get("Dim: Income statistics (4): Member ID: [4]: Median amount ($) (Note: 35)")
                )
    return rows, labels


def decode_csv_bytes(raw):
    if raw.startswith(b"\xff\xfe") or raw[:200].count(b"\x00") > 40:
        return raw.decode("utf-16le", errors="replace").replace("\ufeff", "")
    return raw.decode("utf-8-sig", errors="replace")


def load_phsa_chsa_social_lha_candidates():
    if not PHSA_CHSA_LHA_CROSSWALK.exists() or not PHSA_DOWNLOADS_DIR.exists():
        return {}, []

    chsa_to_lha = []
    for row in read_csv(PHSA_CHSA_LHA_CROSSWALK):
        chsa_to_lha.append(
            {
                "chsa_code": row["chsa_code"],
                "lha_name": row["lha_name"],
                "weight": numeric(row.get("chsa_population_weight_in_lha")) or 0,
            }
        )

    values_by_chsa = defaultdict(dict)
    labels = {}
    for path in sorted(PHSA_DOWNLOADS_DIR.glob("CHSA_*_social-and-economic-factors.csv")):
        text = decode_csv_bytes(path.read_bytes())
        for row in csv.DictReader(io.StringIO(text)):
            chsa_code = (row.get("Jurisdiction Code") or "").strip()
            indicator_name = (row.get("Indicator Name") or "").strip()
            year = (row.get("Year(s)") or "").strip()
            value = numeric(row.get("Indicator Value"))
            if not chsa_code or not indicator_name or not year or value is None:
                continue
            field = f"phsa_chsa_social_{slug_key(indicator_name)}_{slug_key(year)}"
            values_by_chsa[chsa_code][field] = value
            labels[field] = {
                "indicatorName": indicator_name,
                "year": year,
                "unit": row.get("Unit"),
                "dataSource": row.get("Data Source"),
            }

    numerator_by_lha = defaultdict(lambda: defaultdict(float))
    weight_by_lha = defaultdict(lambda: defaultdict(float))
    for row in chsa_to_lha:
        values = values_by_chsa.get(row["chsa_code"], {})
        for field, value in values.items():
            numerator_by_lha[row["lha_name"]][field] += value * row["weight"]
            weight_by_lha[row["lha_name"]][field] += row["weight"]

    output = {}
    for lha_name, fields in numerator_by_lha.items():
        output[lha_name] = {}
        for field, numerator in fields.items():
            weight = weight_by_lha[lha_name][field]
            output[lha_name][field] = round(numerator / weight, 6) if weight else None
    return output, labels


def build_rows():
    crosswalk = load_lha_cd_crosswalk()
    lha_csd_weights = load_lha_csd_weights()
    denominators = load_cd_denominators()
    lha_denominators = load_lha_denominators()
    annual_counts, cd_names = load_cd_ei_counts()
    csd_income_sources, census_labels = load_csd_census_income_sources()
    phsa_social, phsa_social_labels = load_phsa_chsa_social_lha_candidates()

    rows = []
    for lha_name, cw in sorted(crosswalk.items()):
        cd_code = cw["cd_code"]
        row = {
            "lha_name": lha_name,
            "cd_code": cd_code,
            "cd_name": cd_names.get(cd_code, ""),
            "cd_population_share": cw["cd_population_share"],
            "da_count_in_cd": cw["da_count_in_cd"],
            "da_count_total": cw["da_count_total"],
        }
        for year in ANNUAL_YEARS:
            for detail in BENEFIT_DETAILS:
                detail_key = safe_key(detail)
                count = annual_counts.get((cd_code, year, detail))
                row[f"statcan_ei_{year}_{detail_key}_annual_avg_count"] = round(count, 6) if count is not None else None
                for denom_name, denom_value in denominators.get(cd_code, {}).items():
                    field = f"statcan_ei_{year}_{detail_key}_per_100_{denom_name}"
                    row[field] = round(count / denom_value * 100, 6) if count is not None and denom_value else None
        for period_key in HISTORICAL_PERIODS:
            for detail in BENEFIT_DETAILS:
                detail_key = safe_key(detail)
                count = annual_counts.get((cd_code, period_key, detail))
                row[f"statcan_ei_{period_key}_{detail_key}_avg_count"] = round(count, 6) if count is not None else None
                for denom_name, denom_value in denominators.get(cd_code, {}).items():
                    field = f"statcan_ei_{period_key}_{detail_key}_per_100_{denom_name}"
                    row[field] = round(count / denom_value * 100, 6) if count is not None and denom_value else None

        for source_key in CENSUS_INCOME_SOURCE_MEMBERS.values():
            numerator = 0.0
            denominator = 0.0
            median_numerator = 0.0
            median_weight = 0.0
            csd_count = 0
            for csd_code, weight_row in lha_csd_weights.get(lha_name, {}).items():
                source = csd_income_sources.get(csd_code, {})
                percent = source.get(f"statcan_census_2016_{source_key}_percent_with_amount")
                if percent is None:
                    continue
                weight = weight_row.get("age_15plus") or weight_row.get("population") or 0
                numerator += weight * percent / 100
                denominator += weight
                median = source.get(f"statcan_census_2016_{source_key}_median_amount")
                if median is not None:
                    median_numerator += weight * median
                    median_weight += weight
                csd_count += 1
            row[f"statcan_census_2016_{source_key}_percent_with_amount_csd_weighted"] = (
                round(numerator / denominator * 100, 6) if denominator else None
            )
            row[f"statcan_census_2016_{source_key}_estimated_with_amount_csd_weighted"] = round(numerator, 6) if denominator else None
            row[f"statcan_census_2016_{source_key}_median_amount_csd_weighted"] = (
                round(median_numerator / median_weight, 6) if median_weight else None
            )
            row[f"statcan_census_2016_{source_key}_csd_count"] = csd_count
            for denom_name, denom_value in lha_denominators.get(lha_name, {}).items():
                field = f"statcan_census_2016_{source_key}_estimated_with_amount_per_100_{denom_name}_csd_weighted"
                row[field] = round(numerator / denom_value * 100, 6) if denominator and denom_value else None
        row.update(phsa_social.get(lha_name, {}))
        rows.append(row)
    return rows, census_labels, phsa_social_labels


def main():
    rows, census_labels, phsa_social_labels = build_rows()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    write_csv(OUTPUT_DIR / "lha-employment-insurance-candidates.csv", rows)
    (OUTPUT_DIR / "lha-employment-insurance-candidates.json").write_text(json.dumps(rows, indent=2) + "\n")
    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "source": {
                    "monthlyEiTable": "Statistics Canada 14-10-0323-01, Employment insurance beneficiaries by census division, monthly, unadjusted for seasonality",
                    "monthlyEiUrl": "https://www150.statcan.gc.ca/n1/tbl/csv/14100323-eng.zip",
                    "monthlyEiLocalZip": str(EI_ZIP_PATH.relative_to(SCRIPT_DIR)),
                    "censusIncomeSourcesTable": "Statistics Canada 2016 Census 98-400-X2016119, Income Sources and Taxes (34) and Income Statistics (4) for CD/CSD",
                    "censusIncomeSourcesUrl": "https://www12.statcan.gc.ca/census-recensement/2016/dp-pd/dt-td/CompDataDownload.cfm?LANG=E&PID=110261&OFT=CSV",
                    "censusIncomeSourcesLocalZip": str(CENSUS_INCOME_SOURCES_ZIP_PATH.relative_to(SCRIPT_DIR))
                    if CENSUS_INCOME_SOURCES_ZIP_PATH.exists()
                    else None,
                },
                "method": "Annual average monthly EI beneficiaries for BC Census Divisions, both sexes, age 15 years and over, plus the documented four-quarter December 2011 through September 2012 historical window; joined to LHAs by primary 2016 Census Division from the DA-to-LHA crosswalk; candidate rates divide by 2016 CD population, labour force, and age-15-plus denominators. Also tests 2016 Census income-source CSD percentages, weighted to LHA by DA age-15-plus denominators from the DA-to-LHA crosswalk.",
                "benefitDetails": BENEFIT_DETAILS,
                "annualYears": ANNUAL_YEARS,
                "historicalPeriods": HISTORICAL_PERIODS,
                "censusIncomeSourceMembers": CENSUS_INCOME_SOURCE_MEMBERS,
                "censusIncomeSourceLabels": census_labels,
                "phsaChsaSocialSource": "PHSA Community Health Atlas CHSA Social & economic factors CSV downloads, population-weighted to LHA using the CHSA-to-LHA crosswalk",
                "phsaChsaSocialLabels": phsa_social_labels,
                "outputs": {
                    "candidatesCsv": "lha-employment-insurance-candidates.csv",
                },
            },
            indent=2,
        )
        + "\n"
    )
    print(f"BCEnviroScreen EI LHA candidates: wrote {OUTPUT_DIR.relative_to(PGMAPS_ROOT)}")


if __name__ == "__main__":
    main()
