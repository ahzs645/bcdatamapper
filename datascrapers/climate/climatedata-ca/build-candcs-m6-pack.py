#!/usr/bin/env python3
"""Convert ClimateData.ca files to one sparse shared-grid BC HDF5 package."""

import argparse
import json
from pathlib import Path

import h5py
import numpy as np


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
DEFAULT_CACHE = SCRIPT_DIRECTORY / "cache"


def parse_arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["f32", "u16"], required=True)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--indices", type=Path)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def copy_attributes(source, destination, names):
    for name in names:
        if name in source.attrs:
            destination.attrs[name] = source.attrs[name]


def write_common(output, reference, cell_indices, manifest):
    grid = output.create_group("grid")
    grid.create_dataset("lat", data=reference["lat"][:])
    grid.create_dataset("lon", data=reference["lon"][:])
    grid.create_dataset(
        "cell_flat_index", data=cell_indices, compression="gzip", shuffle=True
    )
    output.create_dataset("time", data=reference["time"][:])
    copy_attributes(reference["time"], output["time"], ["calendar", "units"])
    output.attrs["layout"] = "shared-grid sparse cell matrix"
    output.attrs["source"] = manifest["endpoint"]
    output.attrs["bc_cell_count"] = len(cell_indices)
    output.attrs["source_bbox"] = manifest.get("bbox", manifest.get("request", {}).get("bbox"))
    output.attrs["contains_absolute_values_only"] = True


def encode_uint16(values):
    finite = np.isfinite(values)
    if not finite.any():
        return np.full(values.shape, 65535, dtype=np.uint16), 1.0, 0.0, 0.0
    minimum = float(np.nanmin(values))
    maximum = float(np.nanmax(values))
    scale = (maximum - minimum) / 65534 if maximum != minimum else 1.0
    packed = np.full(values.shape, 65535, dtype=np.uint16)
    packed[finite] = np.clip(
        np.rint((values[finite] - minimum) / scale), 0, 65534
    ).astype(np.uint16)
    return packed, scale, minimum, scale / 2


def source_files(cache, manifest):
    return [
        cache / result["file"]
        for result in manifest["results"]
        if result["status"] != "failed"
    ]


def build(mode, sources, cell_indices, manifest, output_path):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with h5py.File(sources[0], "r") as reference, h5py.File(
        output_path, "w"
    ) as output:
        write_common(output, reference, cell_indices, manifest)
        output.attrs["encoding"] = (
            "float32" if mode == "f32" else "uint16 scale/offset"
        )

        variables = output.create_group("variables")
        for source_index, source_path in enumerate(sources, start=1):
            print(f"[{source_index}/{len(sources)}] {source_path.stem}", flush=True)
            with h5py.File(source_path, "r") as source:
                group = variables.create_group(source_path.stem)
                group.attrs["source_file"] = source_path.name
                data_names = sorted(
                    name
                    for name, value in source.items()
                    if isinstance(value, h5py.Dataset)
                    and value.ndim == 3
                    and "_delta_" not in name
                )
                for name in data_names:
                    source_dataset = source[name]
                    values = source_dataset[:].reshape(
                        source_dataset.shape[0], -1
                    )[:, cell_indices]
                    if mode == "f32":
                        destination = group.create_dataset(
                            name,
                            data=values.astype(np.float32, copy=False),
                            chunks=(1, min(4096, values.shape[1])),
                            compression="gzip",
                            compression_opts=4,
                            shuffle=True,
                            fillvalue=np.nan,
                        )
                    else:
                        packed, scale, offset, error = encode_uint16(values)
                        destination = group.create_dataset(
                            name,
                            data=packed,
                            chunks=(1, min(4096, packed.shape[1])),
                            compression="gzip",
                            compression_opts=4,
                            shuffle=True,
                            fillvalue=np.uint16(65535),
                        )
                        destination.attrs["scale_factor"] = scale
                        destination.attrs["add_offset"] = offset
                        destination.attrs["maximum_quantization_error"] = error
                        destination.attrs["_FillValue"] = np.uint16(65535)
                    copy_attributes(
                        source_dataset,
                        destination,
                        [
                            "units",
                            "long_name",
                            "standard_name",
                            "description",
                            "cell_methods",
                        ],
                    )


def main():
    arguments = parse_arguments()
    cache = arguments.cache_dir.resolve()
    manifest_file = (arguments.manifest or cache / "download-manifest.json").resolve()
    indices_file = (arguments.indices or cache / "bc-grid-flat-indices.npy").resolve()
    output_path = (
        arguments.output
        or cache / "processed" / f"climatedata-bc-candcs-m6-absolute-{arguments.mode}.h5"
    ).resolve()
    manifest = json.loads(manifest_file.read_text())
    sources = source_files(cache, manifest)
    if not sources:
        raise RuntimeError(f"No successful source files in {manifest_file}")
    cell_indices = np.load(indices_file)
    build(arguments.mode, sources, cell_indices, manifest, output_path)
    print(f"Wrote {output_path} ({output_path.stat().st_size / 2**20:.2f} MiB)")


if __name__ == "__main__":
    main()
