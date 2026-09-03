#!/usr/bin/env python3

"""Validate and optionally publish a BC EnviroScreen release to Cloudflare R2."""

from __future__ import annotations

import argparse
import hashlib
import json
import shlex
import shutil
import subprocess
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_RELEASE_ROOT = SCRIPT_DIR / "output" / "bc-enviro-screen" / "release"
DEFAULT_ENDPOINT = "https://479e77f49d4ac5d7498529ee360f194b.r2.cloudflarestorage.com"
IMMUTABLE_CACHE = "public,max-age=31536000,immutable"
POINTER_CACHE = "public,max-age=300,must-revalidate"


def read_json(path: Path):
    if not path.exists():
        raise SystemExit(f"Required publication file is missing: {path}")
    return json.loads(path.read_text())


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_release(root: Path) -> tuple[Path, dict]:
    latest = read_json(root / "latest.json")
    release_id = latest.get("releaseId")
    if not release_id:
        raise SystemExit("latest.json does not declare releaseId")
    release_dir = root / release_id
    manifest = read_json(release_dir / "manifest.json")
    if manifest.get("releaseId") != release_id:
        raise SystemExit("latest.json and manifest.json release IDs do not match")
    if manifest.get("schemaVersion") != 1:
        raise SystemExit("Unsupported manifest schemaVersion")
    if manifest.get("boundary", {}).get("rowCount") != 89 or len(manifest.get("indicatorKeys", [])) != 21:
        raise SystemExit("Release does not contain the required 89 LHAs and 21 indicators")
    for entry in manifest.get("files", []):
        path = release_dir / entry["filename"]
        if not path.exists():
            raise SystemExit(f"Manifest file is missing: {path}")
        if path.stat().st_size != entry["bytes"]:
            raise SystemExit(f"Byte size mismatch for {path.name}")
        if sha256_file(path) != entry["sha256"]:
            raise SystemExit(f"SHA-256 mismatch for {path.name}")
        document = read_json(path)
        if isinstance(document, dict) and document.get("releaseId") != release_id:
            raise SystemExit(f"Release ID mismatch in {path.name}")
    return release_dir, manifest


def aws_base(args: argparse.Namespace) -> list[str]:
    return ["aws", "--profile", args.profile, "--endpoint-url", args.endpoint]


def show(command: list[str]) -> None:
    print(" ".join(shlex.quote(part) for part in command))


def run(command: list[str], upload: bool) -> None:
    show(command)
    if upload:
        subprocess.run(command, check=True)


def is_missing_object(stderr: str) -> bool:
    lowered = stderr.lower()
    return "404" in lowered or "not found" in lowered or "nosuchkey" in lowered


def merge_remote_catalog(args: argparse.Namespace, base: list[str], release: dict) -> None:
    catalog_path = args.release_root / "catalog.json"
    local_catalog = read_json(catalog_path)
    command = base + ["s3", "cp", f"s3://{args.bucket}/{args.prefix}/catalog.json", "-"]
    remote = subprocess.run(command, text=True, capture_output=True)
    if remote.returncode == 0:
        remote_catalog = json.loads(remote.stdout)
        prior = remote_catalog.get("releases", [])
        local_catalog["releases"] = [release] + [entry for entry in prior if entry.get("releaseId") != release["releaseId"]]
    elif not is_missing_object(remote.stderr):
        raise SystemExit(f"Could not inspect the existing R2 catalog: {remote.stderr.strip()}")
    catalog_path.write_text(json.dumps(local_catalog, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-root", type=Path, default=DEFAULT_RELEASE_ROOT)
    parser.add_argument("--bucket", default="maps")
    parser.add_argument("--prefix", default="environmental-burden/bc-enviro-screen")
    parser.add_argument("--profile", default="r2")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--upload", action="store_true", help="Perform uploads; the default only prints the plan")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    release_dir, manifest = validate_release(args.release_root)
    release_id = manifest["releaseId"]
    destination = f"s3://{args.bucket}/{args.prefix}/releases/{release_id}/"
    base = aws_base(args)

    if args.upload:
        if not shutil.which("aws"):
            raise SystemExit("AWS CLI is required for --upload")
        head = subprocess.run(
            base
            + [
                "s3api",
                "head-object",
                "--bucket",
                args.bucket,
                "--key",
                f"{args.prefix}/releases/{release_id}/manifest.json",
            ],
            text=True,
            capture_output=True,
        )
        if head.returncode == 0:
            raise SystemExit(f"Immutable release already exists in R2: {release_id}")
        if not is_missing_object(head.stderr):
            raise SystemExit(f"Could not verify R2 release immutability: {head.stderr.strip()}")
        local_catalog = read_json(args.release_root / "catalog.json")
        merge_remote_catalog(args, base, local_catalog["releases"][0])

    print(f"Validated release {release_id}; publication order:")
    run(
        base
        + [
            "s3",
            "cp",
            str(release_dir) + "/",
            destination,
            "--recursive",
            "--content-type",
            "application/json; charset=utf-8",
            "--cache-control",
            IMMUTABLE_CACHE,
        ],
        args.upload,
    )
    for pointer in ["catalog.json", "latest.json"]:
        run(
            base
            + [
                "s3",
                "cp",
                str(args.release_root / pointer),
                f"s3://{args.bucket}/{args.prefix}/{pointer}",
                "--content-type",
                "application/json; charset=utf-8",
                "--cache-control",
                POINTER_CACHE,
            ],
            args.upload,
        )
    print("Upload complete." if args.upload else "Dry run only; add --upload to publish.")


if __name__ == "__main__":
    main()
