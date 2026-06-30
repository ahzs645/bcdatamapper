#!/usr/bin/env python3
"""Convert Digital Road Atlas FileGDB layers into compact Parquet caches.

The BCEnviroScreen linear-footprint rebuild only needs DRA segment length and
geometry. Keeping those in Parquet avoids repeatedly opening the FileGDB ZIP.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pyogrio


SCRIPT_DIR = Path(__file__).resolve().parent
RAW_LARGE_DIR = SCRIPT_DIR / "output" / "bc-enviro-screen" / "raw-rebuild-seed" / "large"
DRA_DIR = RAW_LARGE_DIR / "digital-road-atlas"
GDB_PATH = DRA_DIR / "dgtl_road_atlas.gdb.zip"
OUTPUT_DIR = DRA_DIR / "parquet"
BATCH_SIZE = 100_000


LAYERS = {
    "mpar": "DGTL_ROAD_ATLAS_MPAR_SP",
    "dpar": "DGTL_ROAD_ATLAS_DPAR_SP",
}


def convert_layer(layer_key, layer_name):
    info = pyogrio.read_info(GDB_PATH, layer=layer_name)
    feature_count = int(info["features"])
    out_path = OUTPUT_DIR / f"dgtl_road_atlas_{layer_key}.parquet"
    writer = None
    rows_written = 0

    for offset in range(0, feature_count, BATCH_SIZE):
        _metadata, source_table = pyogrio.read_arrow(
            GDB_PATH,
            layer=layer_name,
            columns=["ID", "LENGTH_2D"],
            skip_features=offset,
            max_features=BATCH_SIZE,
        )
        table = pa.table(
            {
                "id": source_table["ID"],
                "length_2d_m": source_table["LENGTH_2D"],
                "geometry_wkb": source_table["geometry"],
            }
        )
        if writer is None:
            writer = pq.ParquetWriter(
                out_path,
                table.schema,
                compression="zstd",
                compression_level=9,
                use_dictionary=True,
            )
        writer.write_table(table)
        rows_written += table.num_rows
        print(f"{layer_key}: wrote {rows_written:,}/{feature_count:,} rows")

    if writer is not None:
        writer.close()

    return {
        "layerKey": layer_key,
        "sourceLayer": layer_name,
        "sourceFeatureCount": feature_count,
        "rowsWritten": rows_written,
        "output": str(out_path.relative_to(SCRIPT_DIR)),
        "bytes": out_path.stat().st_size,
        "schema": [
            {"name": "id", "description": "DRA segment ID"},
            {"name": "length_2d_m", "description": "Source DRA 2D length in metres"},
            {"name": "geometry_wkb", "description": "EPSG:3005 geometry encoded as WKB"},
        ],
    }


def main():
    if not GDB_PATH.exists():
        raise SystemExit(f"Missing DRA FileGDB ZIP: {GDB_PATH}")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    layers = [convert_layer(key, name) for key, name in LAYERS.items()]
    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": str(GDB_PATH.relative_to(SCRIPT_DIR)),
        "notes": [
            "Converted from BC Digital Road Atlas FileGDB ZIP.",
            "Geometry is stored as WKB in EPSG:3005; length_2d_m is the source DRA LENGTH_2D field.",
            "This is an analysis cache for BCEnviroScreen linear-footprint rebuilding, not a public app payload.",
        ],
        "layers": layers,
    }
    (OUTPUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"BCEnviroScreen DRA Parquet: wrote {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
