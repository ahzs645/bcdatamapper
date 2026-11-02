"""Prepare checked display overviews of the original numeric Pl/C4 download.

uv run --with rasterio==1.5.1 python \
  datascrapers/bc/cciss/prepare-numeric-overviews.py --verify-determinism

Never reads the WebP trace or regenerates full-detail polygons. Outputs are
display grids; numeric point inspection continues to sample the original TIFF.
"""

import argparse
import json
import math
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import rasterio

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parents[1] / "lib"))
from categorical_overviews import build  # noqa: E402
from categorical_raster import encode_json, sha256  # noqa: E402

LEVELS = [(8, 0), (4, 6), (2, 7)]


def validate(source_path, full_manifest, output):
    """Check each generated sample independently of its published geometry."""
    full = json.loads(full_manifest.read_text())
    index = json.loads((output / "manifest.json").read_text())
    source_hash = sha256(source_path)
    if source_hash != full["source"]["sha256"] or index["sourceSha256"] != source_hash:
        raise ValueError("Numeric overview/source checksum mismatch")
    if [(level["id"], level["minZoom"]) for level in index["levels"]] != [
        ("overview-8", 0), ("overview-4", 6), ("overview-2", 7), ("full", 8)
    ]:
        raise ValueError("Unexpected numeric overview zoom policy")
    if (output / index["levels"][-1]["manifest"]).resolve() != full_manifest.resolve():
        raise ValueError("Full-detail level must reference the existing numeric polygons")
    checks = []
    with rasterio.open(source_path) as source:
        original = source.read(1, masked=True)
        original_classes = set(map(int, np.unique(original.compressed())))
        if original_classes != {10, 20, 30}:
            raise ValueError("Expected the unchanged historical Pl/C4 numeric class raster")
        for factor, zoom in LEVELS:
            path = output / f"grid-{factor}.tif"
            # Independent sample indices use the extent-preserving output
            # dimensions, including non-divisible edge cells.
            height, width = math.ceil(source.height / factor), math.ceil(source.width / factor)
            rows = np.floor((np.arange(height) + 0.5) * source.height / height).astype(int)
            columns = np.floor((np.arange(width) + 0.5) * source.width / width).astype(int)
            expected = original[np.ix_(rows, columns)]
            with rasterio.open(path) as overview:
                actual = overview.read(1, masked=True)
                if (overview.count != 1 or overview.crs != source.crs
                        or overview.dtypes != source.dtypes or overview.nodata != source.nodata):
                    raise ValueError(f"Overview {factor}: source band/CRS/type/NoData changed")
                if overview.width != width or overview.height != height:
                    raise ValueError(f"Overview {factor}: unexpected dimensions")
                if not np.allclose(overview.bounds, source.bounds, rtol=0, atol=1e-10):
                    raise ValueError(f"Overview {factor}: source extent changed")
                if not np.array_equal(np.ma.getmaskarray(actual), np.ma.getmaskarray(expected)):
                    raise ValueError(f"Overview {factor}: sampled NoData mask changed")
                if not np.array_equal(actual.compressed(), expected.compressed()):
                    raise ValueError(f"Overview {factor}: sampled numeric classes changed")
                classes, counts = np.unique(actual.compressed(), return_counts=True)
                if not set(map(int, classes)) <= original_classes:
                    raise ValueError(f"Overview {factor}: invented class")
                counts = {str(int(code)): int(count) for code, count in zip(classes, counts)}
                manifest = json.loads((output / f"factor-{factor}" / "manifest.json").read_text())
                if manifest["source"]["sha256"] != sha256(path) or manifest["classCounts"] != counts:
                    raise ValueError(f"Overview {factor}: polygon manifest differs from numeric raster")
                checks.append({
                    "factor": factor,
                    "minZoom": zoom,
                    "width": width,
                    "height": height,
                    "validCells": sum(counts.values()),
                    "classCounts": counts,
                    "gzipBytes": manifest["gzipBytes"],
                    "blocks": len(manifest["tiles"]),
                    "features": manifest["features"],
                })
    receipt = {
        "schema": "cciss-numeric-overview-validation-v1",
        "sourceRaster": source_path.name,
        "sourceSha256": source_hash,
        "fullManifestSha256": sha256(full_manifest),
        "displayOnlyOverviews": True,
        "method": "nearest-cell-centre",
        "checks": ["original-source-checksum", "sampled-mask-and-values", "source-extent",
                   "class-counts", "published-polygon-roundtrips-in-generic-converter"],
        "levels": checks,
        "limitation": "Generalized display grids; exact values and ecological resolution remain those of the original numeric TIFF.",
    }
    (output / "validation.json").write_bytes(encode_json(receipt))
    return receipt


def signatures(directory):
    return {path.relative_to(directory).as_posix(): sha256(path)
            for path in sorted(directory.rglob("*")) if path.is_file()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ROOT / "output/historical-download-1961-1990-C4-Pl.tif")
    parser.add_argument("--full-manifest", type=Path, default=ROOT / "output/historical-Pl-C4-polygons/manifest.json")
    parser.add_argument("--output", type=Path, default=ROOT / "output/historical-Pl-C4-overviews")
    parser.add_argument("--verify-determinism", action="store_true")
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    index = build(args.input, args.full_manifest, args.output, LEVELS)
    receipt = validate(args.input, args.full_manifest, args.output)
    if args.verify_determinism:
        # A sibling directory keeps portable relative full-manifest links
        # identical, while both fresh builds read the same numeric source.
        with tempfile.TemporaryDirectory(prefix=".cciss-numeric-rebuild-", dir=args.output.parent) as temporary:
            os.rmdir(temporary)
            second = Path(temporary)
            build(args.input, args.full_manifest, second, LEVELS)
            validate(args.input, args.full_manifest, second)
            if signatures(args.output) != signatures(second):
                raise ValueError("Numeric overview repeat build changed published bytes")
    print(json.dumps({
        "manifest": str(args.output / "manifest.json"),
        "sourceSha256": receipt["sourceSha256"],
        "deterministicRebuildVerified": args.verify_determinism,
        "files": len(signatures(args.output)),
        "levels": index["levels"],
    }, indent=2))


if __name__ == "__main__":
    main()
