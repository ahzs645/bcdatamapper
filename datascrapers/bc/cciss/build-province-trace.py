"""Build the full public CCISS layer from archived zoom-12 tiles using cell-interior votes."""

import argparse, gzip, hashlib, json, math, sys, time, warnings
from pathlib import Path
import numpy as np
import rasterio
from rasterio.transform import from_origin

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
from categorical_raster import convert, encode_json
from palette_classes import classify_rgba
from grid_tile_votes import axis_cells, accumulate, resolve

PALETTE = {10: [0, 100, 0], 20: [30, 144, 255], 30: [238, 201, 0], 40: [247, 247, 247]}
LAYER = "NewFeas_1961_1990_ref_C4_Pl"


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--archive", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--source-store", type=Path, required=True)
    p.add_argument(
        "--wait-for-download",
        action="store_true",
        help="Allow the resumable downloader to fill later rows concurrently",
    )
    args = p.parse_args()
    if args.output.exists():
        raise ValueError("Use a new output directory")
    meta = json.loads((args.archive / "tilejson.json").read_text())
    if meta["id"] != LAYER:
        raise ValueError("Unexpected source layer")
    w, s, e, n = meta["bounds"]
    step = 1 / 360
    z = 12
    size = 256
    width = round((e - w) / step)
    height = round((n - s) / step)
    xy = lambda lon, lat: (
        math.floor((lon + 180) / 360 * 2**z),
        math.floor((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**z),
    )
    x0, y0 = xy(w, n)
    x1, y1 = xy(e, s)
    xc = {x: axis_cells(z, x, "x", w, step, width) for x in range(x0, x1 + 1)}
    yc = {y: axis_cells(z, y, "y", n, step, height) for y in range(y0, y1 + 1)}
    expected_x = np.zeros(width, dtype="uint16")
    expected_y = np.zeros(height, dtype="uint16")
    for _, ids in xc.values():
        expected_x += np.bincount(ids, minlength=width).astype("uint16")
    for _, ids in yc.values():
        expected_y += np.bincount(ids, minlength=height).astype("uint16")
    expected = expected_y[:, None] * expected_x[None, :]
    counts = np.zeros((5, height, width), dtype="uint16")
    sources = []
    blank = 0
    started = time.monotonic()
    args.source_store.mkdir(parents=True, exist_ok=True)
    (args.source_store / "tilejson.json").write_bytes(
        (args.archive / "tilejson.json").read_bytes()
    )
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", rasterio.errors.NotGeoreferencedWarning)
        for y in range(y0, y1 + 1):
            yi, rows = yc[y]
            for x in range(x0, x1 + 1):
                path = args.archive / f"{z}-{x}-{y}.webp"
                if args.wait_for_download:
                    deadline = time.monotonic() + 300
                    while not path.exists() and not path.with_suffix(".empty").exists():
                        if time.monotonic() > deadline:
                            raise TimeoutError(f"Download did not produce {path}")
                        time.sleep(1)
                if path.with_suffix(".empty").exists():
                    sources.append([x, y, None, 0, 204])
                    blank += 1
                    continue
                data = path.read_bytes()
                digest = hashlib.sha256(data).hexdigest()
                dest = args.source_store / "objects" / f"{digest}.webp"
                if not dest.exists():
                    dest.parent.mkdir(exist_ok=True)
                    dest.write_bytes(data)
                sources.append([x, y, digest, len(data), 200])
                with rasterio.open(path) as src:
                    if src.width != 256 or src.height != 256 or src.count not in (3, 4):
                        raise ValueError(f"Invalid tile {path}")
                    image = src.read()
                if image.shape[0] == 4 and not image[3].any():
                    blank += 1
                    continue
                xi, cols = xc[x]
                if not len(xi) or not len(yi):
                    continue
                rgba = image[:, yi[:, None], xi[None, :]]
                if len(rgba) == 3:
                    rgba = np.concatenate(
                        [rgba, np.full((1, *rgba.shape[1:]), 255, dtype="uint8")]
                    )
                labels = classify_rgba(rgba, PALETTE)
                accumulate(counts, labels, rows, cols)
            if (y - y0) % 10 == 0:
                print(
                    f"rows {y - y0 + 1}/{y1 - y0 + 1}; {time.monotonic() - started:.1f}s",
                    flush=True,
                )
    result = resolve(counts, expected)
    # Display-vote agreement measures interiors only, not truth of the original numeric raster.
    valid = counts[:4].sum(axis=0, dtype="uint32")
    top = counts[:4].max(axis=0)
    accepted = (result != 0) & (result != 99)
    voted = int(valid[accepted].sum())
    disagree = int((valid[accepted] - top[accepted]).sum())
    del counts, expected, valid, top
    args.output.mkdir(parents=True)
    path = args.output / "inferred-display-classes.tif"
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=height,
        width=width,
        count=1,
        dtype="uint16",
        crs="EPSG:4326",
        transform=from_origin(w, n, step, step),
        nodata=0,
        compress="deflate",
        tiled=True,
    ) as dst:
        dst.write(result, 1)
        dst.update_tags(
            DESCRIPTION="INFERRED CCISS tile display classes; not original model data"
        )
    manifest = convert(path, args.output / "polygons")
    index = {
        "layer": LAYER,
        "zoom": z,
        "urlTemplate": f"https://tileserver.thebeczone.ca/data/{LAYER}/{{z}}/{{x}}/{{y}}.webp",
        "columns": ["x", "y", "sha256", "bytes", "status"],
        "tiles": sources,
    }
    packed = gzip.compress(encode_json(index), mtime=0)
    (args.source_store / "index.json.gz").write_bytes(packed)
    codes, nums = np.unique(result, return_counts=True)
    report = {
        "kind": "inferred-display-classes",
        "authoritativeNumericData": False,
        "scope": "Entire published layer extent",
        "layer": LAYER,
        "sourceZoom": z,
        "bounds": meta["bounds"],
        "grid": {
            "crs": "EPSG:4326",
            "origin": [w, n],
            "stepDegrees": step,
            "width": width,
            "height": height,
        },
        "method": {
            "interiorFraction": 0.6,
            "minimumSamples": 4,
            "minimumClassifiedCoverageAndWinningShare": 0.8,
            "uncertainCode": 99,
            "nodataCode": 0,
        },
        "counts": {str(k): int(v) for k, v in zip(codes, nums)},
        "sourceTiles": len(sources),
        "transparentTiles": blank,
        "sourceBytes": sum(row[3] for row in sources),
        "uniqueSourceObjects": len(set(row[2] for row in sources if row[2])),
        "sourceIndexSha256": hashlib.sha256(packed).hexdigest(),
        "acceptedInteriorVotes": voted,
        "disagreeingInteriorVotes": disagree,
        "interiorVoteAgreement": 1 - disagree / voted,
        "notSourceDataAccuracy": True,
        "validation": manifest["validation"],
        "features": manifest["features"],
        "gzipBytes": manifest["gzipBytes"],
    }
    (args.output / "provenance.json").write_bytes(encode_json(report))
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
