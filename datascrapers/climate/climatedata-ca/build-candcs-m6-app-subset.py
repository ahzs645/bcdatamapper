#!/usr/bin/env python3
"""Build a small percentile/time subset from a shared-grid CanDCS-M6 pack."""

import argparse
from pathlib import Path

import h5py


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
DEFAULT_CACHE = SCRIPT_DIRECTORY / "cache"


def parse_indices(value):
    try:
        indices = [int(item.strip()) for item in value.split(",") if item.strip()]
    except ValueError as error:
        raise argparse.ArgumentTypeError("time indices must be comma-separated integers") from error
    if not indices or min(indices) < 0:
        raise argparse.ArgumentTypeError("at least one non-negative time index is required")
    return indices


def parse_arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--percentile", choices=["p10", "p50", "p90"], default="p50")
    parser.add_argument(
        "--time-indices",
        type=parse_indices,
        default=[2, 9, 12],
        help="Comma-separated source indices (default: 2,9,12)",
    )
    parser.add_argument(
        "--label",
        default="1971-2000, 2041-2070, 2071-2100",
        help="Human-readable description stored in the output",
    )
    return parser.parse_args()


def main():
    arguments = parse_arguments()
    cache = arguments.cache_dir.resolve()
    source_path = (
        arguments.input
        or cache / "processed" / "climatedata-bc-candcs-m6-absolute-u16.h5"
    ).resolve()
    output_path = (
        arguments.output
        or cache
        / "processed"
        / f"climatedata-bc-candcs-m6-{arguments.percentile}-three-periods-u16.h5"
    ).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with h5py.File(source_path, "r") as source, h5py.File(output_path, "w") as output:
        if max(arguments.time_indices) >= len(source["time"]):
            raise IndexError(
                f"time index exceeds source length {len(source['time'])}: {arguments.time_indices}"
            )
        source.copy("grid", output)
        output.create_dataset("time", data=source["time"][:][arguments.time_indices])
        for key, value in source["time"].attrs.items():
            output["time"].attrs[key] = value
        for key, value in source.attrs.items():
            output.attrs[key] = value
        output.attrs["subset_percentile"] = arguments.percentile
        output.attrs["subset_time_indices"] = arguments.time_indices
        output.attrs["subset_label"] = arguments.label

        variables = output.create_group("variables")
        suffix = f"_{arguments.percentile}"
        for variable, source_group in source["variables"].items():
            group = variables.create_group(variable)
            for key, value in source_group.attrs.items():
                group.attrs[key] = value
            for name, source_dataset in source_group.items():
                if not name.endswith(suffix):
                    continue
                values = source_dataset[arguments.time_indices, :]
                destination = group.create_dataset(
                    name,
                    data=values,
                    chunks=(1, min(4096, values.shape[1])),
                    compression="gzip",
                    compression_opts=4,
                    shuffle=True,
                    fillvalue=source_dataset.fillvalue,
                )
                for key, value in source_dataset.attrs.items():
                    destination.attrs[key] = value

    print(f"Wrote {output_path} ({output_path.stat().st_size / 2**20:.2f} MiB)")


if __name__ == "__main__":
    main()
