#!/usr/bin/env python3
"""Download a complete, validated local research snapshot of BCGW site points."""
import collections
import datetime
import gzip
import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request
import argparse
import time
from build import build_product

ROOT = Path(__file__).resolve().parent
LAYER = "WHSE_WASTE.SITE_ENV_RMDTN_SITES_SVW"
SERVICE = f"https://openmaps.gov.bc.ca/geo/pub/{LAYER}/ows"
CATALOGUE = "https://catalogue.data.gov.bc.ca/dataset/environmental-remediation-sites"


def get_json(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=120) as response:
                return json.load(response)
        except (OSError, ValueError):
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-cache', action='store_true', help='Rebuild map product from the existing download')
    if parser.parse_args().from_cache:
        build_product(ROOT / 'cache')
        return
    metadata = get_json("https://catalogue.data.gov.bc.ca/api/3/action/package_show?id=environmental-remediation-sites")["result"]
    features, requests = [], []
    expected = None
    while expected is None or len(features) < expected:
        params = dict(service="WFS", version="2.0.0", request="GetFeature",
                      typeNames=LAYER, outputFormat="application/json",
                      srsName="urn:ogc:def:crs:OGC:1.3:CRS84", count=10000,
                      startIndex=len(features), sortBy="ENV_RMDTN_SITES_ID A")
        url = SERVICE + "?" + urllib.parse.urlencode(params)
        page = get_json(url)
        matched = int(page["numberMatched"])
        if expected is not None and matched != expected:
            raise RuntimeError("Source count changed during paging; rerun download")
        expected = matched
        if not page["features"]:
            raise RuntimeError("Empty page before reaching source count")
        features.extend(page["features"])
        requests.append(url)
        print(f"Downloaded {len(features)}/{expected}", flush=True)
    ids = [f["properties"]["ENV_RMDTN_SITES_ID"] for f in features]
    assert len(features) == expected == len(set(ids))
    assert None not in ids
    for feature in features:
        geometry = feature["geometry"]
        assert geometry and geometry["type"] == "Point"
        lon, lat = geometry["coordinates"][:2]
        assert -180 <= lon <= 180 and -90 <= lat <= 90
    payload = (json.dumps({"type": "FeatureCollection", "features": features},
                          separators=(",", ":"), ensure_ascii=False) + "\n").encode()
    compressed = gzip.compress(payload, mtime=0)
    source = ROOT / "source"
    source.mkdir(exist_ok=True)
    path = source / "environmental-remediation-sites.geojson.gz"
    temporary = source / (path.name + '.tmp')
    temporary.write_bytes(compressed)
    temporary.replace(path)
    (source / "catalogue-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    manifest = dict(downloadedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    catalogue=CATALOGUE, service=SERVICE, layer=LAYER,
                    license=metadata.get("license_title"), licenseUrl=metadata.get("license_url"),
                    crs="OGC:CRS84 (longitude, latitude)", featureCount=expected,
                    uniqueSiteIds=len(set(ids)), geometryTypes=dict(collections.Counter(f["geometry"]["type"] for f in features)),
                    bytes=len(payload), gzipBytes=len(compressed),
                    sha256=hashlib.sha256(payload).hexdigest(), requests=requests,
                    resource=path.name, gzipSha256=hashlib.sha256(compressed).hexdigest(),
                    purpose="Local compressed source archive; not a deployable or redistribution artifact.")
    (source / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    build_product(ROOT / "cache")
    print(json.dumps({k: manifest[k] for k in ["featureCount", "uniqueSiteIds", "geometryTypes", "bytes", "gzipBytes", "license"]}, indent=2))


if __name__ == "__main__":
    main()
