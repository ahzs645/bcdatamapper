"""Inventory NDIT's public Power BI report; optionally extract bounded source-table samples.

Uses only the public report resource key embedded in NDIT's published report.
No account, browser cookies, access token or private workspace API is used.
"""
import argparse
import gzip
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "output"
PUBLIC_KEY = "0d347d38-3eef-455d-9a54-6d7de2c764ab"
BASE = "https://wabi-west-us-b-primary-api.analysis.windows.net/public/reports"
PAGE = "https://www.northerndevelopment.bc.ca/state-of-the-north/"
MAX_ROWS = 5000
SAMPLES = {
    "BC_Mines": ["Mine Name", "Permittee", "Mine Type", "Commodities", "Nearest City/Town", "Operating Status", "Latitude", "Longitude", "In Operation (Y/N/?)", "Northern BC"],
    "IPPSupplyListOperation_Annually": ["Project Name", "IPP/Seller", "Location", "Type", "Call Process", "Capacity (MW)", "Energy (GWh/yr)", "REF_DATE", "NDIT Region"],
    "ElectricityGeneratingCapacity_Annually": ["Station", "Percentage of BC Total", "REF_DATE", "Generating Capacity (MW)", "Region"],
    "HousingMedian_Monthly": ["Value", "Geography", "Latitude", "Longitude", "REF DATE", "Month", "Year"],
    "Traffic_Ferries_Monthly": ["Route", "Total Vehicles", "Total Passengers", "REF_DATE", "Year"],
    "TourismRevenue_Monthly": ["Date", "Value", "Year", "Month", "Region"],
    "JobVacancy_ByGEO": ["REF_DATE", "Statistics", "VALUE", "Year", "GEO", "Sort", "Quarter"],
}


def request(path, body=None):
    req = Request(BASE + path, data=json.dumps(body).encode() if body is not None else None,
                  headers={"X-PowerBI-ResourceKey": PUBLIC_KEY, "Content-Type": "application/json"})
    with urlopen(req, timeout=90) as response:
        payload = response.read()
    if payload.startswith(b"\x1f\x8b"):
        payload = gzip.decompress(payload)
    return json.loads(payload)


def literal_title(visual, key):
    try:
        value = visual["vcObjects"][key][0]["properties"]["text"]["expr"]["Literal"]["Value"]
        return value[1:-1].replace("''", "'") if value.startswith("'") else value
    except (KeyError, IndexError):
        return None


def decode_rows(data, columns):
    """Decode only the flat grouping shape requested below; reject unexpected forms."""
    datasets = data["dsr"]["DS"]
    if len(datasets) != 1 or len(datasets[0].get("PH", [])) != 1:
        raise ValueError("Unexpected Power BI dataset/grouping shape")
    ds = datasets[0]
    encoded = ds["PH"][0].get("DM0", [])
    dictionaries, schema, previous, result = ds.get("ValueDicts", {}), None, None, []
    for row in encoded:
        if set(row) - {"S", "C", "R", "Ø"}:
            raise ValueError(f"Unsupported Power BI row encoding: {list(row)}")
        schema = row.get("S", schema)
        if schema is None or len(schema) != len(columns):
            raise ValueError("Column count/schema changed")
        cells, index, values = row.get("C", []), 0, []
        for i, field in enumerate(schema):
            if field["N"] != f"G{i}":
                raise ValueError("Unexpected group column order")
            if row.get("R", 0) & (1 << i):
                if previous is None:
                    raise ValueError("Repeat mask on first row")
                value = previous[i]
            elif row.get("Ø", 0) & (1 << i):
                value = None
            else:
                value = cells[index]
                index += 1
            values.append(value)
        if index != len(cells):
            raise ValueError("Unused encoded cells")
        previous = values
        record = {}
        for column, field, value in zip(columns, schema, values):
            # Dictionary-backed strings may also be emitted as inline strings.
            if isinstance(value, int) and not isinstance(value, bool) and "DN" in field:
                value = dictionaries[field["DN"]][value]
            # Power BI datetime columns are milliseconds since the Unix epoch.
            if value is not None and field["T"] == 7:
                value = datetime.fromtimestamp(value / 1000, timezone.utc).isoformat().replace("+00:00", "Z")
            record[column] = value
        result.append(record)
    # DLEx reports a data limit being exceeded. IC also appears on complete
    # responses and must not be interpreted as an incompleteness flag.
    return result, not bool(ds.get("DLEx") or ds.get("RT") or ds.get("RestartTokens") or len(result) >= MAX_ROWS)


def query_table(model_id, entity, columns):
    query = {"Version": 2, "From": [{"Name": "t", "Entity": entity, "Type": 0}],
             "Select": [{"Column": {"Expression": {"SourceRef": {"Source": "t"}}, "Property": column},
                         "Name": entity + "." + column} for column in columns]}
    body = {"version": "1.0.0", "modelId": model_id, "cancelQueries": [], "queries": [{"QueryId": "",
        "Query": {"Commands": [{"SemanticQueryDataShapeCommand": {"Query": query,
            "Binding": {"Primary": {"Groupings": [{"Projections": list(range(len(columns)))}]},
                        "DataReduction": {"DataVolume": 3, "Primary": {"Top": {"Count": MAX_ROWS}}}, "Version": 1},
            "ExecutionMetricsKind": 1}}]}}]}
    response = request("/querydata?synchronous=true", body)
    result = response["results"][0]["result"]
    if "data" not in result:
        raise ValueError(f"Power BI query failed for {entity}: {result}")
    return decode_rows(result["data"], columns)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", action="store_true", help="Extract seven bounded, distinct source-table row sets")
    args = parser.parse_args()
    model = request(f"/{PUBLIC_KEY}/modelsAndExploration?preferReadOnlySession=true")
    model_info = model["models"][0]
    schema = request("/conceptualschema", {"modelIds": [model_info["id"]]})["schemas"][0]["schema"]
    pages, used = [], set()
    for section in model["exploration"]["sections"]:
        charts = []
        for container in section.get("visualContainers", []):
            visual = json.loads(container["config"]).get("singleVisual", {})
            query = visual.get("prototypeQuery")
            if not query:
                continue
            entities = [item["Entity"] for item in query.get("From", [])]
            used.update(entities)
            charts.append({"visualId": json.loads(container["config"])["name"],
                "visualType": visual["visualType"], "title": literal_title(visual, "title"),
                "subtitle": literal_title(visual, "subTitle"), "entities": entities,
                "fields": [item.get("Name") for item in query.get("Select", [])]})
        pages.append({"pageName": section["name"], "title": section["displayName"],
                      "tooltip": section["displayName"].startswith("Tooltip"), "visuals": charts})
    tables = []
    for entity in schema["Entities"]:
        if entity["Name"] in used and not entity.get("Private"):
            tables.append({"name": entity["Name"], "fields": [
                {"name": p["Name"], "dataType": p.get("DataType"), "measure": "Measure" in p, "hidden": bool(p.get("Hidden"))}
                for p in entity.get("Properties", [])]})
    inventory = {"sourceUrl": PAGE, "publicReportResourceKey": PUBLIC_KEY,
        "modelLastRefresh": model_info["LastRefreshTime"], "pages": pages, "tables": tables,
        "access": "Public publish-to-web model and read-only semantic queries; undocumented endpoint, not a stable API contract",
        "caveats": ["Report year is not observation year; series have independent reference dates.",
            "Raw table rows are not chart measures. Chart filters, sums, averages and forecast labels need separate reproduction.",
            "Regional labels mix NDIT service regions, economic regions, regional districts, cities, facilities, routes and BC totals.",
            "NDIT's launch FAQ permits research reuse; retain source attribution and review underlying source terms before publishing derived products."],
        "reuseSourceUrl": "https://www.northerndevelopment.bc.ca/news/northern-development-launches-digital-state-of-the-north-dashboard/",
        "samples": []}
    OUT.mkdir(parents=True, exist_ok=True)
    if args.samples:
        by_entity = {e["Name"]: e for e in schema["Entities"]}
        for name, columns in SAMPLES.items():
            public_columns = {p["Name"] for p in by_entity[name]["Properties"] if not p.get("Hidden") and "Column" in p}
            assert set(columns) <= public_columns and name in used, name
            records, complete = query_table(model_info["id"], name, columns)
            records.sort(key=lambda row: json.dumps(row, ensure_ascii=False, sort_keys=True))
            filename = name.lower() + ".json.gz"
            snapshot = {"sourceUrl": PAGE, "modelLastRefresh": model_info["LastRefreshTime"], "table": name,
                        "columns": columns, "rowLimit": MAX_ROWS, "completeDistinctRows": complete,
                        "role": "source-table extraction pilot; not a reproduction of dashboard chart measures", "rows": records}
            payload = (json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
            (OUT / filename).write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))
            summary = {"table": name, "file": filename, "rows": len(records), "completeDistinctRows": complete,
                       "hasCoordinates": "Latitude" in columns and "Longitude" in columns}
            inventory["samples"].append(summary)
            print(json.dumps(summary), flush=True)
    (OUT / "inventory.json").write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"pages": len(pages), "tablesUsed": len(tables), "modelLastRefresh": model_info["LastRefreshTime"]}))


if __name__ == "__main__":
    main()
