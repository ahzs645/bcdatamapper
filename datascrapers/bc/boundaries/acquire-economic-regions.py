"""Cache 2021 BC economic regions and the official SGC hierarchy (stdlib only)."""
import gzip
import json
import sys
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "source/StatCanEconomicRegions"
SERVICE = "https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Digital_boundary_files/MapServer/2"
CLASSIFICATION = "https://www23.statcan.gc.ca/imdb/p3VD.pl?CLV=2&CPV=59&CST=01012021&CVD=1368932&Function=getVD&MLV=5&TVD=1368923"


def fetch(url):
    for attempt in range(4):
        try:
            with urlopen(url, timeout=90) as response:
                return response.read()
        except Exception:
            if attempt == 3:
                raise
            time.sleep(attempt + 1)


class Rows(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows, self.row, self.cell, self.link = [], None, None, None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.row, self.link = [], None
        if self.row is not None and tag in ("td", "th"):
            self.cell = []
        if self.row is not None and tag == "a":
            href = dict(attrs).get("href", "")
            if "Function=getVD" in href and "CPV=" in href:
                self.link = href

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None:
            self.row.append(" ".join("".join(self.cell).split()))
            self.cell = None
        if tag == "tr" and self.row is not None:
            if self.link and len(self.row) >= 2:
                self.rows.append((self.link, self.row))
            self.row = None


def children(url, level):
    parser = Rows()
    parser.feed(fetch(url).decode("utf-8"))
    result = []
    for href, cells in parser.rows:
        query = parse_qs(urlparse(href).query)
        if query.get("CLV") == [str(level)]:
            result.append({"code": query["CPV"][0].replace("-ER", ""),
                           "name": cells[1], "type": cells[2] if len(cells) > 2 else None,
                           "sourceUrl": urljoin(url, href)})
    if not result:
        raise ValueError(f"No level {level} children at {url}")
    return sorted(result, key=lambda row: row["code"])


def save(name, data):
    payload = (json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    (SOURCE / name).write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))


def main():
    SOURCE.mkdir(parents=True, exist_ok=True)
    refresh = "--refresh" in sys.argv
    if refresh or not (SOURCE / "bc_economic_regions_2021.full.geojson.gz").exists():
        url = SERVICE + "/query?" + urlencode({"where": "PRUID='59'", "outFields": "ERUID,ERNAME,DGUID,LANDAREA,PRUID",
            "returnGeometry": "true", "outSR": "4326", "f": "geojson"})
        data = json.loads(fetch(url))
        if data.get("type") != "FeatureCollection" or len(data["features"]) != 8 or data.get("exceededTransferLimit"):
            raise ValueError("Expected complete set of eight BC economic regions")
        data["features"].sort(key=lambda f: f["properties"]["ERUID"])
        save("bc_economic_regions_2021.full.geojson.gz", data)
    if refresh or not (SOURCE / "sgc_2021_hierarchy.json.gz").exists():
        regions = children(CLASSIFICATION, 3)
        divisions, subdivisions = [], []
        for region in regions:
            print("SGC", region["code"], region["name"], flush=True)
            for division in children(region["sourceUrl"], 4):
                division["economicRegionCode"] = region["code"]
                divisions.append(division)
                for subdivision in children(division["sourceUrl"], 5):
                    subdivision.update(censusDivisionCode=division["code"], economicRegionCode=region["code"])
                    subdivisions.append(subdivision)
        assert len(regions) == 8 and len(divisions) == 29
        assert len({d["code"] for d in divisions}) == 29
        assert len({s["code"] for s in subdivisions}) == len(subdivisions)
        save("sgc_2021_hierarchy.json.gz", {"sourceUrl": CLASSIFICATION, "censusYear": 2021,
            "provinceCode": "59", "economicRegions": regions, "censusDivisions": sorted(divisions, key=lambda d: d["code"]),
            "censusSubdivisions": sorted(subdivisions, key=lambda s: s["code"])})


if __name__ == "__main__":
    main()
