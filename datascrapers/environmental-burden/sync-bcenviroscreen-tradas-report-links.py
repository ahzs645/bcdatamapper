#!/usr/bin/env python3

import argparse
import concurrent.futures as futures
import csv
import itertools
import re
import time
from pathlib import Path
from urllib.parse import unquote, urljoin, urlparse

import requests
from bs4 import BeautifulSoup


SCRIPT_DIR = Path(__file__).resolve().parent
RAW_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed" / "compact" / "traffic-data-program"
TMS_AADT_PATH = RAW_DIR / "tdp-tms-site-report-annual-aadt.csv"
OUTPUT_PATH = RAW_DIR / "tdp-tradas-report-links.csv"
ERROR_PATH = RAW_DIR / "tdp-tradas-report-link-errors.csv"
TRADAS_URL = "https://tradas.th.gov.bc.ca/tradas.asp"


def clean_text(value):
    return re.sub(r"\s+", " ", value or "").strip()


def load_sites():
    if not TMS_AADT_PATH.exists():
        raise SystemExit(f"Missing {TMS_AADT_PATH}. Run the TMS report sync first.")

    with TMS_AADT_PATH.open() as handle:
        rows = list(csv.DictReader(handle))
    return [row for row in rows if row.get("site_code")]


def select_options(soup, name, skip_values):
    select = soup.find("select", attrs={"name": name})
    if not select:
        return []
    values = []
    for option in select.find_all("option"):
        value = str(option.get("value") or "").strip()
        if value and value not in skip_values:
            values.append(value)
    return values


def extract_station_title(soup):
    text = clean_text(soup.get_text(" "))
    match = re.search(r"Traffic Data For:\s*(.+?)\s+Data Type", text, flags=re.I)
    return clean_text(match.group(1)) if match else ""


def parse_report_url(loc, link, requested):
    parsed = urlparse(link)
    path = unquote(parsed.path)
    filename = Path(path).name
    match = re.search(r"/AllYears/(\d{4})/(\d{2})/([^/]+)/", path)
    date_match = re.search(r" on (\d{2})-(\d{2})-(\d{4})\.(pdf|xls)$", filename, flags=re.I)
    extension_match = re.search(r"\.([A-Za-z0-9]+)$", filename)
    return {
        "site_code": loc,
        "report_type": match.group(3) if match else "",
        "report_year": match.group(1) if match else (date_match.group(3) if date_match else ""),
        "report_month": match.group(2) if match else (date_match.group(1) if date_match else ""),
        "report_day": date_match.group(2) if date_match else "",
        "extension": extension_match.group(1).lower() if extension_match else "",
        "requested_type": requested.get("stype", ""),
        "requested_year": requested.get("syear", ""),
        "requested_month": requested.get("smon", ""),
        "requested_day": requested.get("sday", ""),
        "url": link,
    }


def report_links_from_soup(base_url, soup):
    links = []
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"]
        if "/reports/" in href or href.startswith("reports/"):
            links.append(urljoin(base_url, href))
    return links


def request_report_links(session, loc, payload):
    response = session.post(TRADAS_URL, params={"loc": loc}, data={"loc": loc, **payload}, timeout=30)
    response.raise_for_status()
    return report_links_from_soup(response.url, BeautifulSoup(response.text, "html.parser"))


def build_payloads(types, years, months, days, full_combinations):
    payloads = []
    for stype, year in itertools.product(types, years):
        payloads.append({"stype": stype, "syear": year, "smon": "0", "sday": "0"})
        if full_combinations:
            for month, day in itertools.product(months, days):
                payloads.append({"stype": stype, "syear": year, "smon": month, "sday": day})
    seen = set()
    unique = []
    for payload in payloads:
        key = tuple(sorted(payload.items()))
        if key in seen:
            continue
        seen.add(key)
        unique.append(payload)
    return unique


def scrape_site(site, full_combinations=False):
    loc = site["site_code"]
    session = requests.Session()
    try:
        response = session.get(TRADAS_URL, params={"loc": loc}, timeout=30)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        title = extract_station_title(soup)
        types = select_options(soup, "stype", {"undefined"})
        years = select_options(soup, "syear", {"0"})
        months = select_options(soup, "smon", {"0"})
        days = select_options(soup, "sday", {"0"})
        if not types or not years:
            return [], {
                "site_code": loc,
                "error": "missing report type/year options",
                "http_status": response.status_code,
            }

        rows_by_url = {}
        for link in report_links_from_soup(response.url, soup):
            rows_by_url[link] = parse_report_url(loc, link, {})

        for payload in build_payloads(types, years, months, days, full_combinations):
            for link in request_report_links(session, loc, payload):
                rows_by_url.setdefault(link, parse_report_url(loc, link, payload))
            time.sleep(0.03)

        rows = []
        for row in rows_by_url.values():
            row.update(
                {
                    "station_title": title,
                    "tms_ext_id": site.get("tms_ext_id", ""),
                    "utv_segment_ext_id": site.get("utv_segment_ext_id", ""),
                    "type_code": site.get("type_code", ""),
                    "type_description": site.get("type_description", ""),
                    "status_code": site.get("status_code", ""),
                    "status_description": site.get("status_description", ""),
                    "description": site.get("description", ""),
                    "lon": site.get("lon", ""),
                    "lat": site.get("lat", ""),
                    "available_report_types": "|".join(types),
                    "available_years": "|".join(years),
                    "available_months": "|".join(months),
                    "available_days": "|".join(days),
                }
            )
            rows.append(row)
        return rows, None
    except Exception as error:
        return [], {"site_code": loc, "error": repr(error), "http_status": ""}


def write_csv(path, rows, headers):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers)
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description="Inventory public TRADAS report links for BCEnviroScreen traffic source discovery.")
    parser.add_argument("--loc", action="append", help="Specific TRADAS station/site code. Can be repeated.")
    parser.add_argument("--limit", type=int, help="Limit number of TMS sites when --loc is not supplied.")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--full-combinations", action="store_true", help="Try every listed type/year/month/day combination.")
    args = parser.parse_args()

    sites = load_sites()
    if args.loc:
        wanted = set(args.loc)
        sites = [site for site in sites if site.get("site_code") in wanted]
        found = {site.get("site_code") for site in sites}
        for loc in sorted(wanted - found):
            sites.append({"site_code": loc})
    elif args.limit:
        sites = sites[: args.limit]

    rows = []
    errors = []
    started = time.time()
    with futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_rows = [executor.submit(scrape_site, site, args.full_combinations) for site in sites]
        for index, future in enumerate(futures.as_completed(future_rows), 1):
            site_rows, error = future.result()
            rows.extend(site_rows)
            if error:
                errors.append(error)
            if index % 50 == 0:
                print(f"processed {index} sites links {len(rows)} errors {len(errors)} elapsed {time.time() - started:.1f}s", flush=True)

    headers = [
        "site_code",
        "station_title",
        "tms_ext_id",
        "utv_segment_ext_id",
        "type_code",
        "type_description",
        "status_code",
        "status_description",
        "description",
        "lon",
        "lat",
        "report_type",
        "report_year",
        "report_month",
        "report_day",
        "extension",
        "requested_type",
        "requested_year",
        "requested_month",
        "requested_day",
        "available_report_types",
        "available_years",
        "available_months",
        "available_days",
        "url",
    ]
    rows.sort(key=lambda row: (row.get("site_code", ""), row.get("report_year", ""), row.get("report_month", ""), row.get("report_day", ""), row.get("report_type", ""), row.get("extension", "")))
    write_csv(OUTPUT_PATH, rows, headers)
    write_csv(ERROR_PATH, errors, ["site_code", "http_status", "error"])
    print(f"BCEnviroScreen TRADAS links: wrote {OUTPUT_PATH.relative_to(SCRIPT_DIR)}")
    print(f"Sites checked: {len(sites)}; report links: {len(rows)}; errors: {len(errors)}")


if __name__ == "__main__":
    main()
