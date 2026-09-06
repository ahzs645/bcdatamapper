#!/usr/bin/env python3
"""Build lossless, spatially partitioned native-grid climate layers for Deck.gl.

Only recipes and code belong in Git. cache/ and output/ are intentionally ignored.
The binary format is documented in README.md and decoded by deckgl.mjs.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta
import gzip
import hashlib
import json
from pathlib import Path
import shutil

import h5py
import numpy as np
import rasterio
import shapely
from shapely.geometry import shape, mapping, Point, Polygon

from acquire import HERE, digest, write_json

BLOCK = 128


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n").encode()


def text(value):
    return value.decode() if isinstance(value, bytes) else str(value)


def edges(centres):
    centres = np.asarray(centres, dtype=np.float64)
    step = np.diff(centres)
    if len(step) == 0 or not (np.all(step > 0) or np.all(step < 0)):
        raise ValueError("Grid coordinates must be strictly monotonic")
    return np.r_[centres[0] - step[0] / 2, (centres[:-1] + centres[1:]) / 2, centres[-1] + step[-1] / 2]


def make_grid(grid_id, x, y, boundary):
    """Exact intersection with native cells, including boundary-touching cells."""
    shapely.prepare(boundary)
    nx, ny = len(x) - 1, len(y) - 1
    blocks = []
    bx0, by0, bx1, by1 = boundary.bounds
    for r in range(0, ny, BLOCK):
        h = min(BLOCK, ny-r)
        for c in range(0, nx, BLOCK):
            w = min(BLOCK, nx-c)
            bounds = [min(x[c], x[c+w]), min(y[r], y[r+h]), max(x[c], x[c+w]), max(y[r], y[r+h])]
            if bounds[0] > bx1 or bounds[2] < bx0 or bounds[1] > by1 or bounds[3] < by0:
                continue
            rr, cc = np.meshgrid(np.arange(r, r+h), np.arange(c, c+w), indexing="ij")
            cells = shapely.box(np.minimum(x[cc], x[cc+1]), np.minimum(y[rr], y[rr+1]),
                                np.maximum(x[cc], x[cc+1]), np.maximum(y[rr], y[rr+1]))
            selected = np.flatnonzero(shapely.intersects(boundary, cells))
            if not len(selected):
                continue
            blocks.append(dict(id=f"r{r}-c{c}", row=r, col=c, height=h, width=w,
                               bounds=bounds, count=len(selected), indices=selected.tolist()))
    count = sum(b["count"] for b in blocks)
    if not count:
        raise ValueError("Boundary did not intersect source grid")
    return dict(id=grid_id, crs="EPSG:4326", cellCount=count, shape=[ny, nx],
                xEdges=x.tolist(), yEdges=y.tolist(), tiles=blocks,
                topology="Shared axis edges; native rectangles; no simplification or interpolation",
                cellSelection="intersects BC; full border cells retained; no extrapolation")


def selectors(source, variable):
    horizons = [text(v) for v in source["horizon"][:]]
    units = text(source["time"].attrs["units"])
    calendar = text(source["time"].attrs["calendar"])
    if not units.startswith("days since ") or calendar not in ("proleptic_gregorian", "standard", "gregorian"):
        raise ValueError(f"Unsupported CF time axis: {units}, {calendar}")
    dates = [datetime.fromisoformat(units.removeprefix("days since ")) + timedelta(days=int(v)) for v in source["time"][:]]
    bands = []
    for name in sorted(k for k in source if k.startswith(variable + "_") and source[k].ndim == 3):
        percentile = name.rsplit("_", 1)[-1]
        if percentile not in ("p10", "p50", "p90"):
            raise ValueError(f"Unrecognised percentile: {name}")
        baseline = name.split("_delta_")[1].rsplit("_", 1)[0].replace("_", "-") if "_delta_" in name else None
        for i, horizon in enumerate(horizons):
            bands.append(dict(sourceVariable=name, sourceIndex=i, horizon=horizon, month=dates[i].month,
                              percentile=percentile, measure="source-delta" if baseline else "absolute",
                              baseline=baseline, sourceUnits=text(source[name].attrs["units"]),
                              description=text(source[name].attrs.get("description", ""))))
    if len(bands) != 9 * len(horizons):
        raise ValueError(f"Incomplete source bands for {variable}")
    return bands


def convert(values, band, display_units):
    values = np.asarray(values, dtype="<f8").copy()
    if display_units == "°C" and band["sourceUnits"] == "K" and band["measure"] == "absolute":
        values -= 273.15
    elif display_units == "°C" and band["sourceUnits"] not in ("K", "degC", "°C"):
        raise ValueError(f"Unexpected temperature units: {band['sourceUnits']}")
    values[~np.isfinite(values)] = np.nan
    return values


def provincial_outline(boundary):
    """Province coverage includes inland waters and administrative exclusions.

    Dissolving separately supplied administrative layers leaves precision slivers
    along internal joins. Keep exterior rings unchanged, remove internal holes,
    then union once more. This modifies only the derived province mask, never
    any of the canonical adjacent administrative polygons.
    """
    parts = list(boundary.geoms) if hasattr(boundary, "geoms") else [boundary]
    return shapely.union_all([Polygon(p.exterior) for p in parts])


def load_boundary(recipe, recipe_path):
    boundary_path = (recipe_path.parent / recipe["boundary"]).resolve()
    geo = json.loads(boundary_path.read_text())
    supplement = recipe["boundarySupplement"]
    extra_path = (recipe_path.parent / supplement["path"]).resolve()
    extra = json.loads(extra_path.read_text())
    selected = [f for f in extra["features"] if f["properties"].get(supplement["field"]) == supplement["value"]]
    if len(selected) != 1:
        raise ValueError("Expected exactly one Northern Rockies supplemental boundary")
    boundary = shapely.union_all([shape(f["geometry"]) for f in geo["features"] + selected])
    if not boundary.is_valid:
        raise ValueError("Invalid BC boundary: repair source in its owning scraper")
    original_area = boundary.area
    boundary = provincial_outline(boundary)
    # Fail closed if a source change turns this small seam/inland cleanup into
    # a material expansion. Units cancel in this relative-area diagnostic.
    if (boundary.area-original_area)/original_area > 0.001:
        raise ValueError("Province hole filling changes area by >0.1%; review boundary sources")
    for check in recipe["boundaryCoverageChecks"]:
        if not boundary.covers(Point(check["coordinates"])):
            raise ValueError(f"Incomplete BC coverage: {check['name']}")
    return boundary, {recipe["boundary"]: digest(boundary_path), supplement["path"]: digest(extra_path)}


def build(args):
    recipe = json.loads(args.recipe.read_text())
    sources = json.loads((args.cache / "sources.json").read_text())["sources"]
    by_id = {s["id"]: s for s in sources}
    required = {v["id"] + "_ann" for v in recipe["annual"]} | {"prcptot_sea"} | {"PAS_" + v["horizon"] for v in recipe["snow"]["files"]}
    if set(by_id) != required:
        raise ValueError(f"Incomplete source acquisition: missing={required-set(by_id)}, extra={set(by_id)-required}")
    for s in sources:
        if digest(args.cache / s["file"]) != s["sha256"]:
            raise ValueError(f"Source changed: {s['id']}")
    boundary, boundary_hashes = load_boundary(recipe, args.recipe)
    identity = dict(recipe=recipe, sources={s["id"]: s["sha256"] for s in sources},
                    boundarySha256=boundary_hashes,
                    code={p: digest(HERE / p) for p in ("build.py", "deckgl.mjs", "requirements.txt", "preview.html")})
    release = hashlib.sha256(encoded(identity)).hexdigest()[:20]
    out = args.output / "releases" / release
    out.mkdir(parents=True, exist_ok=True)
    inventory = []

    def save(path, content, zipped=False):
        payload = gzip.compress(content, compresslevel=6, mtime=0) if zipped else content
        target = out / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        entry = dict(path=path, bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
        inventory.append(entry)
        return entry

    save("bc-boundary.geojson", encoded(dict(type="FeatureCollection", features=[dict(type="Feature", properties=dict(name="British Columbia", source=recipe["boundaryDescription"]), geometry=mapping(boundary))])))
    grids = {}
    with h5py.File(args.cache / by_id["tg_mean_ann"]["file"]) as f:
        grids["u6"] = make_grid("u6", edges(f["lon"][:]), edges(f["lat"][:]), boundary)
    with rasterio.open(args.cache / by_id["PAS_1971-2000"]["file"]) as f:
        if f.crs.to_epsg() != 4326 or f.transform.b != 0 or f.transform.d != 0:
            raise ValueError("Snow must be an unrotated WGS84 grid")
        grids["snow"] = make_grid("snow", f.transform.c + np.arange(f.width+1)*f.transform.a,
                                 f.transform.f + np.arange(f.height+1)*f.transform.e, boundary)
    grid_records = {}
    for key, grid in grids.items():
        for tile in grid["tiles"]:
            info = save(f"grids/{key}/{tile['id']}.json.gz", encoded(dict(indices=tile["indices"])), True)
            tile["geometry"] = info["path"]
        grid_public = {**grid, "tiles": [{k:v for k,v in t.items() if k != "indices"} for t in grid["tiles"]]}
        info = save(f"grids/{key}.json", encoded(grid_public))
        grid_records[key] = dict(path=info["path"], cellCount=grid["cellCount"], tileCount=len(grid["tiles"]))
        print(f"Grid {key}: {grid['cellCount']:,} cells, {len(grid['tiles'])} spatial blocks", flush=True)

    products = []
    comparisons = 0
    for spec in recipe["annual"] + [dict(id="prcptot_seasonal", label="Seasonal total precipitation", units="mm", report=True)]:
        seasonal = spec["id"] == "prcptot_seasonal"
        variable = "prcptot" if seasonal else spec["id"]
        source_id = variable + ("_sea" if seasonal else "_ann")
        grid = grids["u6"]
        with h5py.File(args.cache / by_id[source_id]["file"]) as f:
            if not (np.array_equal(edges(f["lat"][:]), grid["yEdges"]) and np.array_equal(edges(f["lon"][:]), grid["xEdges"])):
                raise ValueError(f"Grid mismatch for {source_id}")
            bands = selectors(f, variable)
            for band in bands:
                band["units"] = spec["units"]
                band["season"] = recipe["seasonal"]["seasons"][str(band["month"])] if seasonal else "annual"
                band["conversion"] = "K minus 273.15" if spec["units"] == "°C" and band["sourceUnits"] == "K" and band["measure"] == "absolute" else "none"
            tiles = []
            ranges = [[None, None, 0] for _ in bands]
            for tile in grid["tiles"]:
                r, c, h, w = [tile[k] for k in ("row", "col", "height", "width")]
                idx = np.asarray(tile["indices"])
                # Read each source variable once per block, not once per horizon.
                arrays = {name: f[name][:, r:r+h, c:c+w].reshape((-1, h*w))[:,idx] for name in {b["sourceVariable"] for b in bands}}
                values = np.stack([convert(arrays[b["sourceVariable"]][b["sourceIndex"]], b, spec["units"]) for b in bands]).astype("<f8")
                for i, arr in enumerate(values):
                    finite = arr[np.isfinite(arr)]
                    if len(finite):
                        ranges[i][0] = float(finite.min()) if ranges[i][0] is None else min(ranges[i][0], float(finite.min()))
                        ranges[i][1] = float(finite.max()) if ranges[i][1] is None else max(ranges[i][1], float(finite.max()))
                        ranges[i][2] += len(finite)
                info = save(f"values/{spec['id']}/{tile['id']}.f64.gz", values.tobytes(), True)
                restored = np.frombuffer(gzip.decompress((out/info["path"]).read_bytes()), dtype="<f8").reshape(values.shape)
                if not np.array_equal(restored, values, equal_nan=True):
                    raise ValueError("Lossless data roundtrip failed")
                comparisons += values.size
                tiles.append(dict(id=tile["id"], **info))
            for band, (lo, hi, count) in zip(bands, ranges):
                band.update(min=lo, max=hi, validCells=count, missingCells=grid["cellCount"]-count)
            product = dict(**spec, sourceId=source_id, grid="u6", bands=bands, tiles=tiles,
                           format="band-major little-endian float64; NaN is nodata; gzip")
            if seasonal or variable in ("rx1day", "rx5day"):
                product["unitNote"] = "Source metadata may use mm day-1 for accumulated totals. Display uses mm following the source indicator description and report; numeric values are unchanged, not multiplied by days. sourceUnits remains available on every band."
            info = save(f"products/{spec['id']}.json", encoded(product))
            products.append(dict(id=spec["id"], label=spec["label"], units=spec["units"], grid="u6", path=info["path"], bandCount=len(bands), report=spec["report"]))
            print(f"Built {spec['id']}: {len(bands)} bands", flush=True)

    snow_bands, snow_arrays = [], []
    for spec in recipe["snow"]["files"]:
        sid = "PAS_" + spec["horizon"]
        with rasterio.open(args.cache / by_id[sid]["file"]) as f:
            grid = grids["snow"]
            if f.crs.to_epsg() != 4326 or list(f.shape) != grid["shape"] or not np.array_equal(f.transform.c + np.arange(f.width+1)*f.transform.a, grid["xEdges"]) or not np.array_equal(f.transform.f + np.arange(f.height+1)*f.transform.e, grid["yEdges"]):
                raise ValueError("Snow grids are not identical")
            arr = f.read(1).astype("<f8")
            arr[(arr == f.nodata) | ~np.isfinite(arr)] = np.nan
            snow_arrays.append(arr)
            snow_bands.append(dict(sourceId=sid, horizon=spec["horizon"], percentile=None, season="annual", measure="absolute", baseline=None, units="mm", sourceUnits="mm", conversion="none"))
    tiles = []
    snow_ranges = [[None, None, 0] for _ in snow_bands]
    for tile in grids["snow"]["tiles"]:
        r,c,h,w = [tile[k] for k in ("row", "col", "height", "width")]
        values = np.stack([arr[r:r+h,c:c+w].ravel()[tile["indices"]] for arr in snow_arrays]).astype("<f8")
        info = save(f"values/PAS/{tile['id']}.f64.gz", values.tobytes(), True)
        if not np.array_equal(values.ravel(), np.frombuffer(gzip.decompress((out/info["path"]).read_bytes()), dtype="<f8"), equal_nan=True):
            raise ValueError("Snow roundtrip failed")
        comparisons += values.size
        for i, arr in enumerate(values):
            finite = arr[np.isfinite(arr)]
            if len(finite):
                snow_ranges[i][0] = float(finite.min()) if snow_ranges[i][0] is None else min(snow_ranges[i][0], float(finite.min()))
                snow_ranges[i][1] = float(finite.max()) if snow_ranges[i][1] is None else max(snow_ranges[i][1], float(finite.max()))
                snow_ranges[i][2] += len(finite)
        tiles.append(dict(id=tile["id"], **info))
    for band, (lo, hi, count) in zip(snow_bands, snow_ranges):
        band.update(min=lo, max=hi, validCells=count, missingCells=grids["snow"]["cellCount"]-count)
    snow = dict(id="PAS", label=recipe["snow"]["label"], units="mm", grid="snow", bands=snow_bands,
                tiles=tiles, version=recipe["snow"]["version"], ensemble=recipe["snow"]["ensemble"],
                sourceIds=[b["sourceId"] for b in snow_bands], format="band-major little-endian float64; NaN is nodata; gzip")
    info = save("products/PAS.json", encoded(snow))
    products.append(dict(id="PAS", label=snow["label"], units="mm", grid="snow", path=info["path"], bandCount=4, report=True))
    for name in ("deckgl.mjs", "preview.html"):
        save(name, (HERE/name).read_bytes())

    # Keep byte-for-byte upstream sources recoverable, using content-addressed
    # 64 MiB parts that also work with the Cloudflare REST object size limit.
    published_sources = []
    for source in sources:
        parts = []
        with (args.cache/source["file"]).open("rb") as f:
            n = 0
            while blob := f.read(64 * 1024 * 1024):
                path = f"sources/{source['sha256']}/{n:03d}.part"
                parts.append(save(path, blob))
                n += 1
        published_sources.append({k:v for k,v in source.items() if k not in ("file", "acquisition")} | dict(parts=parts))
    save("sources.json", encoded(dict(schemaVersion=1, sources=published_sources)))
    validation = dict(passed=True, losslessValuesCompared=comparisons, sourceCount=len(sources),
                      boundaryCoverageChecks=recipe["boundaryCoverageChecks"],
                      grids={k:dict(cells=v["cellCount"], tiles=len(v["tiles"])) for k,v in grids.items()},
                      topology="Exact shared axis edges; non-overlapping native rectangles; no simplification",
                      missingValues="NaN retained, never converted to zero or filled outside source coverage")
    save("validation.json", encoded(validation))
    manifest = dict(schemaVersion=1, format="bcdatamapper-native-grid-v1", id=recipe["id"], release=release,
                    title=recipe["title"], scenario=recipe["scenario"], grids=grid_records, products=products,
                    reportHorizons=recipe["reportHorizons"], boundary="bc-boundary.geojson", boundaryRule=recipe["boundaryRule"],
                    sourceManifest="sources.json", validation="validation.json", identity=identity,
                    attribution=[dict(provider="PCIC / ClimateData.ca / PAVICS", dataset="CanDCS-U6 BCCAQv2 CMIP6 + ANUSPLIN300", terms="https://www.pacificclimate.org/terms-of-use"),
                                 dict(provider="ClimateBC, University of British Columbia", dataset=recipe["snow"]["version"], license="CC-BY", terms="https://climatebc.ca/")],
                    cautions=["SSP585 only: no mixing with newer M6 products or other scenarios.",
                              "txgt_29 means days above 29°C, not above 30°C.",
                              "Source delta percentiles are retained, not recomputed by subtracting marginal percentiles.",
                              "Snow has no percentile dimension and retains its separate native grid.",
                              "Regional population-weighted statistics and facility sampling are separate analyses; this release is the gridded source layer."])
    save("manifest.json", encoded(manifest))
    write_json(out/"checksums.json", dict(schemaVersion=1, files=sorted(inventory, key=lambda x:x["path"])))
    write_json(args.output/"current.json", dict(release=release, directory=str(out.resolve())))
    print(json.dumps(dict(release=release, products=len(products), bands=sum(p["bandCount"] for p in products), artifacts=len(inventory)+1, bytes=sum(f["bytes"] for f in inventory), validation=validation)), flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--recipe", type=Path, default=HERE/"recipe.json")
    p.add_argument("--cache", type=Path, default=HERE/"cache")
    p.add_argument("--output", type=Path, default=HERE/"output")
    build(p.parse_args())
