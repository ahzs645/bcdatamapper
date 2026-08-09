#!/usr/bin/env python3
"""Convert Humidex and SPEI source files into sparse shared-grid BC HDF5 packs."""

import argparse
import json
from pathlib import Path

import h5py
import numpy as np


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
DEFAULT_CACHE = SCRIPT_DIRECTORY / "cache" / "separate-grids"


def parse_arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["f32", "u16"], required=True)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--families", default="humidex,spei")
    parser.add_argument("--output-dir", type=Path)
    return parser.parse_args()


def copy_attributes(source, destination):
    for name in (
        "units",
        "long_name",
        "standard_name",
        "description",
        "cell_methods",
    ):
        if name in source.attrs:
            destination.attrs[name] = source.attrs[name]


def encode_uint16(values):
    finite = np.isfinite(values)
    if not finite.any():
        return np.full(values.shape, 65535, dtype=np.uint16), 1.0, 0.0, 0.0, "empty"
    finite_values = values[finite]
    minimum = float(np.nanmin(finite_values))
    maximum = float(np.nanmax(finite_values))
    if (
        minimum >= 0
        and maximum <= 65534
        and np.allclose(finite_values, np.rint(finite_values), atol=1e-7)
    ):
        packed = np.full(values.shape, 65535, dtype=np.uint16)
        packed[finite] = np.rint(finite_values).astype(np.uint16)
        return packed, 1.0, 0.0, 0.0, "exact integer"
    scale = (maximum - minimum) / 65534 if maximum != minimum else 1.0
    packed = np.full(values.shape, 65535, dtype=np.uint16)
    packed[finite] = np.clip(
        np.rint((finite_values - minimum) / scale), 0, 65534
    ).astype(np.uint16)
    return packed, scale, minimum, scale / 2, "scale/offset"


def write_dataset(group, name, values, source_dataset, mode):
    chunks = (1, min(4096, values.shape[1]))
    if mode == "f32":
        destination = group.create_dataset(
            name,
            data=values.astype(np.float32, copy=False),
            chunks=chunks,
            compression="gzip",
            compression_opts=4,
            shuffle=True,
            fillvalue=np.nan,
        )
    else:
        packed, scale, offset, error, encoding = encode_uint16(values)
        destination = group.create_dataset(
            name,
            data=packed,
            chunks=chunks,
            compression="gzip",
            compression_opts=4,
            shuffle=True,
            fillvalue=np.uint16(65535),
        )
        destination.attrs["scale_factor"] = scale
        destination.attrs["add_offset"] = offset
        destination.attrs["maximum_quantization_error"] = error
        destination.attrs["packing"] = encoding
        destination.attrs["_FillValue"] = np.uint16(65535)
    copy_attributes(source_dataset, destination)


def build_family(family, records, cache, indices, mode, output_path, manifest):
    first_file = cache / records[0]["file"]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with h5py.File(first_file, "r") as reference, h5py.File(output_path, "w") as output:
        grid = output.create_group("grid")
        grid.create_dataset("lat", data=reference["lat"][:])
        grid.create_dataset("lon", data=reference["lon"][:])
        grid.create_dataset(
            "cell_flat_index", data=indices, compression="gzip", shuffle=True
        )
        output.attrs["family"] = family
        output.attrs["layout"] = "shared-grid sparse cell matrix"
        output.attrs["source"] = manifest["endpoint"]
        output.attrs["source_bbox"] = manifest["bbox"]
        output.attrs["bc_cell_count"] = len(indices)
        output.attrs["encoding"] = (
            "float32" if mode == "f32" else "uint16 exact-or-scale/offset"
        )
        output.attrs["contains_absolute_values_only"] = True
        products = output.create_group("products")

        for index, record in enumerate(records, start=1):
            source_path = cache / record["file"]
            print(f"[{family} {index}/{len(records)}] {source_path.name}", flush=True)
            with h5py.File(source_path, "r") as source:
                group = (
                    products.require_group(record["variable"])
                    .require_group(record["datasetType"])
                    .create_group(record["month"])
                )
                group.attrs["source_file"] = source_path.name
                time = group.create_dataset("time", data=source["time"][:])
                for key, value in source["time"].attrs.items():
                    time.attrs[key] = value
                names = sorted(
                    name
                    for name, value in source.items()
                    if isinstance(value, h5py.Dataset)
                    and value.ndim == 3
                    and "_delta_" not in name
                )
                for name in names:
                    source_dataset = source[name]
                    values = source_dataset[:].reshape(
                        source_dataset.shape[0], -1
                    )[:, indices]
                    write_dataset(group, name, values, source_dataset, mode)
    print(f"Wrote {output_path} ({output_path.stat().st_size / 2**20:.2f} MiB)")


def main():
    arguments = parse_arguments()
    cache = arguments.cache_dir.resolve()
    manifest_file = (arguments.manifest or cache / "download-manifest.json").resolve()
    output_directory = (arguments.output_dir or cache / "processed").resolve()
    selected = {item.strip() for item in arguments.families.split(",") if item.strip()}
    manifest = json.loads(manifest_file.read_text())
    for family in sorted(selected):
        records = [
            result
            for result in manifest["results"]
            if result["status"] != "failed" and result["family"] == family
        ]
        if not records:
            raise RuntimeError(f"No successful {family} files in {manifest_file}")
        indices = np.load(cache / f"{family}-grid-flat-indices.npy")
        output_path = output_directory / f"climatedata-bc-{family}-{arguments.mode}.h5"
        build_family(
            family, records, cache, indices, arguments.mode, output_path, manifest
        )


if __name__ == "__main__":
    main()
