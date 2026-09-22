#!/usr/bin/env python3
"""Reproduce the BCPLM initial public-land screen with current source snapshots."""

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request
import zipfile

import numpy as np
import pyogrio
from pyogrio.raw import read, write
import shapely

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "source" / "public-land"
OUTPUT = ROOT / "output" / "public-land"
PUBLIC = {"Federal", "Crown Provincial", "Crown Agency", "Local Government", "Untitled Provincial"}
EXCLUDED = {"Private", "First Nations", "Mixed Ownership", "Unclassified"}
SOURCES = {
    "reserves": ("c2ce81af-78c1-467c-b47e-c392cd0a771f", "WHSE_ADMIN_BOUNDARIES.ADM_INDIAN_RESERVES_BANDS_SP", "OBJECTID"),
    "provincial_parks": ("1130248f-f1a3-4956-8b2e-38d29d3e4af7", "WHSE_TANTALIS.TA_PARK_ECORES_PA_SVW", "ADMIN_AREA_SID"),
    "national_parks": ("88e61a14-19a0-46ab-bdae-f68401d3d0fb", "WHSE_ADMIN_BOUNDARIES.CLAB_NATIONAL_PARKS", "NATIONAL_PARK_ID"),
    "regional_districts": ("d1aff64e-dbfe-45a6-af97-582b7f6418b9", "WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_REGIONAL_DISTRICTS_SP", "LGL_ADMIN_AREA_ID"),
    "conservancies": ("550b3133-2004-468f-ba1f-b95d0e281e78", "WHSE_TANTALIS.TA_CONSERVANCY_AREAS_SVW", "ADMIN_AREA_SID"),
}


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=180) as response:
        return json.load(response)


def load_source(name, refresh=False):
    dataset, layer, key = SOURCES[name]
    path = CACHE / f"{name}.json.gz"
    if path.exists() and not refresh:
        with gzip.open(path, "rt") as stream:
            result = json.load(stream)
    else:
        print(f"Fetching full-resolution {name}", flush=True)
        catalogue = fetch_json(f"https://catalogue.data.gov.bc.ca/api/3/action/package_show?id={dataset}")["result"]
        params = dict(service="WFS", version="2.0.0", request="GetFeature", typeNames=f"pub:{layer}",
                      outputFormat="application/json", srsName="EPSG:3005", count=10000, sortBy=key)
        url = f"https://openmaps.gov.bc.ca/geo/pub/{layer}/ows?{urllib.parse.urlencode(params)}"
        data = fetch_json(url)
        if data.get("type") != "FeatureCollection" or not data.get("features"):
            raise ValueError(f"Missing features in {name}: {data}")
        expected = data.get("numberMatched", data.get("totalFeatures"))
        if int(expected) != len(data["features"]):
            raise ValueError(f"Truncated {name}: got {len(data['features'])}, expected {expected}")
        if not data.get("crs", {}).get("properties", {}).get("name", "").endswith("3005"):
            raise ValueError(f"Unexpected source CRS for {name}")
        ids = [f["properties"][key] for f in data["features"]]
        if len(set(ids)) != len(ids):
            raise ValueError(f"Duplicate source IDs in {name}")
        result = {"metadata": {
            "catalogueUrl": f"https://catalogue.data.gov.bc.ca/dataset/{dataset}",
            "title": catalogue["title"], "licence": catalogue.get("license_title"),
            "sourceLayer": layer, "url": url, "featureCount": len(ids),
            "retrievedAt": datetime.now(timezone.utc).isoformat(),
            "crs": "EPSG:3005", "simplification": "none",
        }, "data": data}
        payload = json.dumps(result, separators=(",", ":")).encode()
        temporary = path.with_suffix(".part")
        temporary.write_bytes(gzip.compress(payload, mtime=0))
        temporary.replace(path)
    result["metadata"]["cacheSha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    return name, result


def public_mask(owners):
    unknown = set(owners) - PUBLIC - EXCLUDED
    if unknown:
        raise ValueError(f"Unmapped ownership classes: {unknown}")
    return np.isin(owners, sorted(PUBLIC))


def predicate_geometries(geometries):
    if np.any(shapely.is_missing(geometries)) or np.any(shapely.is_empty(geometries)):
        raise ValueError("Missing/empty geometry must be reviewed, not silently retained")
    invalid = ~shapely.is_valid(geometries)
    fixed = geometries.copy()
    fixed[invalid] = shapely.make_valid(fixed[invalid])
    for index in np.flatnonzero(shapely.get_type_id(fixed) == 7):
        parts = shapely.get_parts(fixed[index])
        fixed[index] = shapely.union_all(parts[shapely.get_dimensions(parts) == 2])
    if np.any(shapely.is_empty(fixed)) or np.any(shapely.get_dimensions(fixed) != 2):
        raise ValueError("Non-polygonal geometry after validity repair")
    return fixed, int(invalid.sum())


def intersect_masks(parcels, exclusions):
    """A boundary touch counts as intersects; record the sensitivity separately."""
    tree = shapely.STRtree(exclusions)
    hit = np.zeros(len(parcels), dtype=bool)
    positive_area = np.zeros(len(parcels), dtype=bool)
    for start in range(0, len(parcels), 2000):
        indices = tree.query(parcels[start:start + 2000], predicate="intersects")
        if indices.shape[1] == 0:
            continue
        left, right = indices
        hit[start + left] = True
        # Polygon interiors intersect iff the intersection has positive area.
        interiors = shapely.relate_pattern(parcels[start + left], exclusions[right], "T********")
        positive_area[start + left[interiors]] = True
    return hit, positive_area


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="Refresh cached exclusion/boundary sources")
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        sources = dict(pool.map(lambda name: load_source(name, args.refresh), SOURCES))

    manifest = json.loads((ROOT / "output/polygons-manifest.json").read_text())
    archive = ROOT / manifest["archive"]["file"]
    with archive.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    if checksum != manifest["archive"]["sha256"]:
        raise ValueError("Parcel archive checksum mismatch")
    with zipfile.ZipFile(archive) as source:
        database, = {n.split(".gdb/")[0] + ".gdb" for n in source.namelist() if ".gdb/" in n}
    path = f"/vsizip/{archive}/{database}"
    info = pyogrio.read_info(path)
    if info["crs"] != "EPSG:3005":
        raise ValueError("Expected BC Albers parcel geometry")
    meta, _, _, data = read(path, columns=["OWNER_TYPE"], read_geometry=False)
    owners = data[0]
    selected_count = int(public_mask(owners).sum())
    owner_counts = dict(sorted(Counter(owners).items()))
    print(f"Selecting {selected_count:,} public parcels from {len(owners):,}", flush=True)
    where = "OWNER_TYPE IN (" + ",".join(f"'{v}'" for v in sorted(PUBLIC)) + ")"
    columns = ["PMBC_PP_SYSID", "PID", "PIN", "PLAN_NUMBER", "PARCEL_CLASS", "PARCEL_STATUS", "OWNER_TYPE", "MUNICIPALITY", "REGIONAL_DISTRICT"]
    meta, _, wkb, arrays = read(path, columns=columns, where=where)
    attributes = dict(zip(meta["fields"], arrays))
    if len(wkb) != selected_count or len(set(attributes["PMBC_PP_SYSID"])) != selected_count:
        raise ValueError("Public parcel count or stable ID uniqueness check failed")
    original = shapely.from_wkb(wkb)
    geometries, repaired = predicate_geometries(original)
    masks, positive, layer_reports = {}, {}, {}
    retained = np.ones(selected_count, dtype=bool)
    for name in ("reserves", "provincial_parks", "national_parks", "conservancies"):
        features = sources[name]["data"]["features"]
        exclusions = np.array([shapely.geometry.shape(f["geometry"]) for f in features], dtype=object)
        exclusions, invalid = predicate_geometries(exclusions)
        print(f"Intersecting {name}: {len(exclusions):,} exclusion geometries", flush=True)
        hit, area = intersect_masks(geometries, exclusions)
        masks[name], positive[name] = hit, area
        baseline = name != "conservancies"
        layer_reports[name] = {
            "intersectingPublicParcels": int(hit.sum()), "boundaryTouchOnlyParcels": int((hit & ~area).sum()),
            "newlyExcludedInOrder": int((hit & retained).sum()) if baseline else None,
            "additionalCandidatesIfApplied": int((hit & retained).sum()) if not baseline else None,
            "invalidExclusionGeometriesRepairedForPredicates": invalid, "appliedToBaseline": baseline,
        }
        if baseline:
            retained &= ~hit

    regions = np.array([v or "UNASSIGNED" for v in attributes["REGIONAL_DISTRICT"]], dtype=object)
    missing = regions == "UNASSIGNED"
    areas = shapely.area(original)
    rows = []
    for region in sorted(set(regions)):
        for owner in sorted(PUBLIC):
            before = (regions == region) & (attributes["OWNER_TYPE"] == owner)
            after = before & retained
            rows.append({"region": region, "owner_type": owner, "before_exclusions": int(before.sum()),
                         "excluded": int((before & ~retained).sum()), "retained": int(after.sum()),
                         "retained_parcel_area_ha": round(float(areas[after].sum() / 10000), 4)})
    with (OUTPUT / "by-region-owner.csv").open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    assert sum(r["before_exclusions"] for r in rows) == selected_count
    assert sum(r["retained"] for r in rows) == int(retained.sum())
    baseline_area = positive["reserves"] | positive["provincial_parks"] | positive["national_parks"]
    boundary_only = ~retained & ~baseline_area
    rd_names = {f["properties"]["ADMIN_AREA_NAME"] for f in sources["regional_districts"]["data"]["features"]}
    result = {
        "methodologyUrl": "https://hart.ubc.ca/our-publications/bcplm-methodology/",
        "scope": "Initial public ownership and reserve/park exclusion screen only; not housing suitability or land availability",
        "parcelArchiveSha256": checksum, "parcelSourceLastModified": manifest["archive"]["lastModified"],
        "sourceFeatures": len(owners), "ownershipCounts": owner_counts,
        "publicOwnershipSelected": selected_count, "excludedByOwnership": len(owners) - selected_count,
        "spatialExclusions": layer_reports, "excludedSpatialUnion": int((~retained).sum()),
        "retained": int(retained.sum()), "excludedOnlyByBoundaryContact": int(boundary_only.sum()),
        "retainedIfPositiveAreaOverlapRequired": int((~baseline_area).sum()),
        "invalidParcelGeometriesRepairedForPredicates": repaired,
        "retainedOriginalInvalidGeometries": int((~shapely.is_valid(original) & retained).sum()),
        "regionAssignment": "Existing ParcelMap BC REGIONAL_DISTRICT attribute; no clipping or duplicate assignment at boundaries",
        "regions": sorted(set(regions)), "unassignedPublicParcels": int(missing.sum()),
        "unassignedRetainedParcels": int((missing & retained).sum()),
        "parcelRegionNamesAbsentFromRDBoundaryLayer": sorted(set(regions) - rd_names - {"UNASSIGNED"}),
        "sources": {name: value["metadata"] for name, value in sources.items()},
        "software": {"pyogrio": pyogrio.__version__, "shapely": shapely.__version__},
        "geometryPolicy": "No simplification, buffer or area threshold. Any intersection, including touching, removes whole parcel. Validity repairs used only for predicates; output keeps original geometry in EPSG:3005.",
        "limitations": [
            "Current snapshots, not UBC's January 2026 input snapshots; exact numerical reproduction is not claimed.",
            "UBC names source families but not exact layer IDs or intersection tolerance; these choices are explicit here.",
            "Conservancies are a separate BCGW layer; reported as an additional sensitivity screen, not silently added to baseline.",
            "Regional grouping uses ParcelMap BC attribution, not a recreated UBC spatial join; Northern Rockies and Stikine are retained as regional reporting units.",
            "Building strata unit PIDs and BC Assessment are not required for this initial screen, but later assessment joins need a checked crosswalk.",
            "National park source is Access Only. Raw boundaries and candidate geometries remain in ignored local research cache; no app publication.",
            "Parcel area sums are not dissolved union area and can double-count any overlapping source parcels.",
        ],
    }
    # Preserve a per-parcel decision trail locally, without distributing mask geometries.
    with gzip.open(CACHE / "parcel-decisions.csv.gz", "wt", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["PMBC_PP_SYSID", "PID", "OWNER_TYPE", "REGIONAL_DISTRICT", "retained", *masks])
        for i in range(selected_count):
            writer.writerow([attributes["PMBC_PP_SYSID"][i], attributes["PID"][i], attributes["OWNER_TYPE"][i],
                             regions[i], int(retained[i]), *[int(mask[i]) for mask in masks.values()]])
    candidate = CACHE / "public-land-candidates.gpkg"
    temporary = CACHE / "public-land-candidates.part.gpkg"
    temporary.unlink(missing_ok=True)
    write(temporary, wkb[retained], [a[retained] for a in arrays], meta["fields"].tolist(),
          driver="GPKG", layer="public_land_candidates", geometry_type="MultiPolygon", crs="EPSG:3005")
    check = pyogrio.read_info(temporary)
    if check["features"] != int(retained.sum()):
        raise ValueError("Written candidate count mismatch")
    temporary.replace(candidate)
    result["candidateFile"] = {"path": str(candidate.relative_to(ROOT)), "bytes": candidate.stat().st_size}
    (OUTPUT / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
    report = [
        "# ParcelMap BC initial public-land screening", "",
        "Reconstruction of the first BCPLM methodology stage using current source data. "
        "These are screened public parcel records, not verified available or housing-suitable sites.", "",
        "| Stage | Parcel records |", "|---|---:|",
        f"| Original ParcelMap BC polygons | {len(owners):,} |",
        f"| Five public ownership categories | {selected_count:,} |",
    ]
    for name in ("reserves", "provincial_parks", "national_parks"):
        report.append(f"| Removed by {name.replace('_', ' ')} (additional, in order) | {layer_reports[name]['newlyExcludedInOrder']:,} |")
    report.extend([
        f"| Retained after the three exclusions | {int(retained.sum()):,} |", "",
        "## Reproduction choices", "",
        f"- Uses the ParcelMap BC archive last modified {manifest['archive']['lastModified']}, not UBC's January 18, 2026 snapshot.",
        "- Selects Federal, Crown Provincial, Crown Agency, Local Government and Untitled Provincial.",
        "- Removes the entire parcel for any intersection with a reserve, provincial park/protected-area or national park polygon. No clipping, buffers or minimum overlap area.",
        "- Uses full-resolution EPSG:3005 geometry throughout; no simplification or coordinate rounding.",
        f"- {int(boundary_only.sum()):,} exclusions were boundary-touch-only; {repaired:,} invalid parcel geometries were repaired in memory for the predicate calculation. Original output geometries remain unchanged ({result['retainedOriginalInvalidGeometries']:,} invalid geometries remain in the candidate file).",
        f"- Groups by the existing ParcelMap BC REGIONAL_DISTRICT field: {len(set(regions) - {'UNASSIGNED'})} named reporting units, including Northern Rockies and Stikine; {int(missing.sum()):,} public parcels have a missing region. The separate legal RD polygons are recorded for source comparison, not used to split or duplicate parcels.",
        f"- Conservancies are supplied as a separate provincial layer. Adding them would remove another {layer_reports['conservancies']['additionalCandidatesIfApplied']:,} records and retain {int(retained.sum()) - layer_reports['conservancies']['additionalCandidatesIfApplied']:,}. This is reported separately because the published methodology does not identify exact source layer IDs.",
        "- National park geometry is marked Access Only in the catalogue. All downloaded boundary geometry, candidate geometry and per-parcel decisions are kept in the ignored local source cache; this run publishes no map layer.", "",
        "## Retained records by owner", "", "| Owner category | Records |", "|---|---:|",
    ])
    for owner in sorted(PUBLIC):
        report.append(f"| {owner} | {sum(r['retained'] for r in rows if r['owner_type'] == owner):,} |")
    report.extend(["", "## Retained records by region", "", "| Region | Records |", "|---|---:|"])
    for region in sorted(set(regions)):
        report.append(f"| {region} | {sum(r['retained'] for r in rows if r['region'] == region):,} |")
    report.extend(["", "## What is still needed for later BCPLM stages", "",
        "This first screen requires neither BC Assessment nor individual strata lot PIDs. "
        "Recreating the next stage requires province-wide BC Assessment actual-use, ALR, "
        "land-characteristic and land/improvement value data plus a validated PID/folio/roll crosswalk. "
        "PGMaps currently has only a Prince George assessment extract. Individual strata records "
        "need the Parcel Fabric or shared-geometry cross-reference table; joining attributes one-to-one "
        "without checking strata and multiple assessment records would be incorrect.", "",
        "Additional size/shape, access, amenity, infrastructure, risk and scoring steps have not been applied. "
        "The result therefore should not match the published BCPLM final-layer count.", "",
        "## Sources and outputs", "",
        "- [UBC methodology](https://hart.ubc.ca/our-publications/bcplm-methodology/)",
        "- `summary.json`: source URLs, snapshot dates, checksums, predicates, counts and limitations.",
        "- `by-region-owner.csv`: complete region/owner summary with counts and summed parcel area.",
        "- `../../source/public-land/public-land-candidates.gpkg`: local full-geometry candidate subset.",
        "- `../../source/public-land/parcel-decisions.csv.gz`: local per-parcel exclusion flags, including conservancy sensitivity.",
    ])
    for name, source in sources.items():
        report.append(f"- [{source['metadata']['title']}]({source['metadata']['catalogueUrl']}): {source['metadata']['featureCount']:,} source features; {source['metadata']['licence']}.")
    (OUTPUT / "report.md").write_text("\n".join(report) + "\n")
    print(json.dumps({k:result[k] for k in ["publicOwnershipSelected", "excludedSpatialUnion", "retained", "excludedOnlyByBoundaryContact", "spatialExclusions"]}, indent=2), flush=True)


if __name__ == "__main__":
    main()
