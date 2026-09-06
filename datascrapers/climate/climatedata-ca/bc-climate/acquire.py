#!/usr/bin/env python3
"""Acquire the versioned recipe, never importing data into Git.

PAVICS sources are discovered from THREDDS catalogues. Archived snow is copied
once from an explicitly supplied archive directory and subsequently restored
from the published source manifest. It is never silently replaced by ClimateBC's
newer product. All acquisition records include byte size and SHA-256.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import time
import urllib.request
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent


def open_url(url, timeout=120):
    # Some CDNs reject urllib's default user agent, including the public R2
    # route. Apply the same identifiable agent to catalogues, manifests, parts.
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "BCDataMapper-Climate/1.0"}), timeout=timeout)


def digest(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n")
    tmp.replace(path)


def download(url, path, expected_hash=None):
    path = Path(path)
    if path.exists() and expected_hash and digest(path) == expected_hash:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "BCDataMapper-Climate/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r, tmp.open("wb") as f:
                shutil.copyfileobj(r, f, length=1024 * 1024)
            if tmp.stat().st_size < 8:
                raise ValueError("Empty download")
            if expected_hash and digest(tmp) != expected_hash:
                raise ValueError("Source hash mismatch: " + url)
            tmp.replace(path)
            return
        except Exception:
            tmp.unlink(missing_ok=True)
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def acquire(args):
    recipe = json.loads(args.recipe.read_text())
    raw = args.cache / "raw"
    manifest_path = args.cache / "sources.json"
    old = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"sources": []}
    previous = {s["id"]: s for s in old["sources"]}
    if args.restore:
        with open_url(args.source_manifest, timeout=60) as r:
            remote = json.load(r)
        restored = []
        for entry in remote["sources"]:
            key = entry["id"]
            if not key.replace("-", "").replace("_", "").isalnum():
                raise ValueError("Invalid source ID in manifest")
            path = raw/(key + (".tif" if entry["family"] == "ClimateBC-archive" else ".nc"))
            if not path.exists() or digest(path) != entry["sha256"]:
                restore_source(entry, path, args.source_manifest)
            restored.append({k:v for k,v in entry.items() if k != "parts"} | dict(file=str(path.relative_to(args.cache))))
            print(f"Restored/verified {key}", flush=True)
        write_json(manifest_path, dict(schemaVersion=1, sources=restored))
        return
    specs = [(v["id"], "YS", "ann") for v in recipe["annual"]] + [("prcptot", "QS-DEC", "sea")]

    def get(spec):
        variable, frequency, suffix = spec
        key = f"{variable}_{suffix}"
        catalog = f'{recipe["pavicsCatalogBase"]}{variable}/{frequency}/{recipe["scenario"]}/ensemble_percentiles/catalog.xml'
        with open_url(catalog, timeout=60) as r:
            root = ET.fromstring(r.read())
        candidates = [e.attrib["urlPath"] for e in root.iter()
                      if e.attrib.get("urlPath", "").endswith("_30ymean_percentiles.nc")]
        if len(candidates) != 1:
            raise ValueError(f"Expected one period/percentile source for {key}: {candidates}")
        url = recipe["pavicsFileBase"] + candidates[0]
        path = raw / (key + ".nc")
        pinned = previous.get(key, {}).get("sha256") if not args.refresh else None
        download(url, path, pinned)
        with path.open("rb") as f:
            if f.read(8) not in [b"\x89HDF\r\n\x1a\n", b"CDF\x01\x00\x00\x00\x00"]:
                raise ValueError(f"Unexpected source format: {path}")
        record = dict(id=key, variable=variable, frequency=frequency, family="CanDCS-U6",
                      url=url, catalogUrl=catalog, file=str(path.relative_to(args.cache)),
                      bytes=path.stat().st_size, sha256=digest(path))
        print(f'Downloaded {key}: {record["bytes"]:,} bytes', flush=True)
        return record

    sources = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for record in pool.map(get, specs):
            sources.append(record)
            write_json(manifest_path, {"schemaVersion": 1, "sources": sorted(sources + [s for s in old["sources"] if s["id"] not in {v["id"] for v in sources}], key=lambda s: s["id"])})

    remote = None
    for spec in recipe["snow"]["files"]:
        key = "PAS_" + spec["horizon"]
        path = raw / (key + ".tif")
        expected = previous.get(key, {}).get("sha256")
        if not (path.exists() and expected and digest(path) == expected):
            if args.archive_root:
                source = args.archive_root / spec["path"]
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, path)
                route = "user-supplied Northern Health archive"
            else:
                if remote is None:
                    with open_url(args.source_manifest, timeout=60) as r:
                        remote = json.load(r)
                entry = next(s for s in remote["sources"] if s["id"] == key)
                restore_source(entry, path, args.source_manifest)
                route = "R2 archived source"
        else:
            route = previous[key].get("acquisition", "verified local cache")
        sources.append(dict(id=key, variable="PAS", horizon=spec["horizon"], frequency="YS",
                            family="ClimateBC-archive", url=recipe["snow"]["source"],
                            acquisition=route, file=str(path.relative_to(args.cache)),
                            bytes=path.stat().st_size, sha256=digest(path)))
    write_json(manifest_path, {"schemaVersion": 1, "sources": sorted(sources, key=lambda s: s["id"])})


def restore_source(entry, destination, manifest_url):
    from urllib.parse import urljoin
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp = destination.with_suffix(destination.suffix + ".part")
    with tmp.open("wb") as out:
        for part in entry["parts"]:
            with open_url(urljoin(manifest_url, part["path"]), timeout=120) as r:
                blob = r.read()
            if hashlib.sha256(blob).hexdigest() != part["sha256"]:
                raise ValueError("Source part checksum mismatch")
            out.write(blob)
    if digest(tmp) != entry["sha256"]:
        raise ValueError("Restored source checksum mismatch")
    tmp.replace(destination)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--recipe", type=Path, default=HERE / "recipe.json")
    p.add_argument("--cache", type=Path, default=HERE / "cache")
    p.add_argument("--archive-root", type=Path)
    p.add_argument("--source-manifest", default="https://data.map.ahmad.sh/climate/bc-climate-u6/sources.json")
    p.add_argument("--workers", type=int, default=3)
    p.add_argument("--refresh", action="store_true", help="Explicitly accept a new upstream source version")
    p.add_argument("--restore", action="store_true", help="Restore exact original files from an R2 source manifest without PAVICS or Drive")
    acquire(p.parse_args())
