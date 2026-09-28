"""Build display-only polygon overviews from the same integer raster as a full-detail manifest."""

import argparse
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from affine import Affine

from categorical_raster import convert, encode_json, sha256


def sampled_grid(data, factor):
    """Nearest cell-centre samples, including the mask; preserve the complete extent."""
    if factor < 2:
        raise ValueError("Overview factor must be at least 2")
    height, width = data.shape
    oh, ow = math.ceil(height / factor), math.ceil(width / factor)
    rows = np.floor((np.arange(oh) + 0.5) * height / oh).astype(int)
    cols = np.floor((np.arange(ow) + 0.5) * width / ow).astype(int)
    return data[np.ix_(rows, cols)], Affine.scale(width / ow, height / oh)


def build(source_path, full_manifest, output, levels):
    source_path, full_manifest, output = map(Path, (source_path, full_manifest, output))
    full = json.loads(full_manifest.read_text())
    if full["source"]["sha256"] != sha256(source_path):
        raise ValueError("Full-detail polygons must come from this exact raster")
    if output.exists():
        raise ValueError("Output must be a new directory")
    output.mkdir(parents=True)
    entries = []
    with rasterio.open(source_path) as source:
        if source.count != 1 or not np.issubdtype(source.dtypes[0], np.integer):
            raise ValueError("Expected a single integer class band")
        data = source.read(1, masked=True)
        for factor, zoom in levels:
            overview, scale = sampled_grid(data, factor)
            path = output / f"grid-{factor}.tif"
            profile = source.profile | {
                "width": overview.shape[1],
                "height": overview.shape[0],
                "transform": source.transform * scale,
            }
            with rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True):
                with rasterio.open(path, "w", **profile) as dest:
                    dest.write(overview.data, 1)
                    dest.write_mask(
                        (~np.ma.getmaskarray(overview)).astype("uint8") * 255
                    )
            manifest = convert(path, output / f"factor-{factor}")
            entries.append(
                {
                    "id": f"overview-{factor}",
                    "label": f"Overview (1:{factor})",
                    "minZoom": zoom,
                    "overview": True,
                    "manifest": f"factor-{factor}/manifest.json",
                    "gzipBytes": manifest["gzipBytes"],
                    "blocks": len(manifest["tiles"]),
                    "features": manifest["features"],
                }
            )
    # Relative path makes this directory portable with the full snapshot.
    import os

    entries.append(
        {
            "id": "full",
            "label": "Full grid",
            "minZoom": max(z for _, z in levels) + 1,
            "overview": False,
            "manifest": os.path.relpath(full_manifest, output),
            "gzipBytes": full["gzipBytes"],
            "blocks": len(full["tiles"]),
            "features": full["features"],
        }
    )
    index = {
        "format": "categorical-raster-pyramid-v1",
        "sourceSha256": full["source"]["sha256"],
        "method": "nearest-cell-centre",
        "displayOnlyOverviews": True,
        "levels": sorted(entries, key=lambda level: level["minZoom"]),
    }
    (output / "manifest.json").write_bytes(encode_json(index))
    return index


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--full-manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--level", action="append", required=True, help="factor:minZoom, e.g. 8:0"
    )
    args = parser.parse_args()
    levels = [tuple(map(int, entry.split(":"))) for entry in args.level]
    print(
        json.dumps(build(args.input, args.full_manifest, args.output, levels), indent=2)
    )
