#!/usr/bin/env python3
"""Publish and verify an immutable climate release; latest.json is written last.

Dry run by default. --upload explicitly enables writes in recipe.storage.prefix.
Use CLOUDFLARE_API_TOKEN or --wrangler-auth after `wrangler whoami` refreshes login.
Credentials are read in memory and never included in logs, artifacts, or Git.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time
import tomllib
from urllib.parse import quote

import requests
from acquire import HERE, digest, write_json


def auth(args):
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if token:
        return token
    if not args.wrangler_auth:
        raise ValueError("Provide CLOUDFLARE_API_TOKEN or explicitly select --wrangler-auth")
    path = args.auth_file
    if path is None:
        if sys.platform == "darwin":
            path = Path.home()/"Library/Preferences/.wrangler/config/default.toml"
        else:
            path = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home()/".config")))/".wrangler/config/default.toml"
    config = tomllib.loads(path.read_text())
    token = config.get("oauth_token") or config.get("api_token")
    if not token:
        raise ValueError("No Wrangler credential: run wrangler whoami/login first")
    return token


def content_type(path):
    if path.endswith(".gz"):
        return "application/gzip"
    if path.endswith(".mjs"):
        return "text/javascript; charset=utf-8"
    if path.endswith(".html"):
        return "text/html; charset=utf-8"
    if path.endswith(".geojson"):
        return "application/geo+json"
    if path.endswith(".json"):
        return "application/json"
    return "application/octet-stream"


def publish(args):
    recipe = json.loads((HERE/"recipe.json").read_text())
    storage = recipe["storage"]
    current = json.loads((args.output/"current.json").read_text())
    release = current["release"]
    if len(release) != 20 or any(c not in "0123456789abcdef" for c in release):
        raise ValueError("Invalid content-derived release ID")
    directory = args.output/"releases"/release
    manifest = json.loads((directory/"manifest.json").read_text())
    if manifest["release"] != release or not json.loads((directory/"validation.json").read_text())["passed"]:
        raise ValueError("Release identity/validation failed")
    files = json.loads((directory/"checksums.json").read_text())["files"]
    files.append(dict(path="checksums.json", sha256=digest(directory/"checksums.json"), bytes=(directory/"checksums.json").stat().st_size))
    for item in files:
        path = directory/item["path"]
        if not path.resolve().is_relative_to(directory.resolve()) or digest(path) != item["sha256"] or path.stat().st_size != item["bytes"]:
            raise ValueError(f"Invalid local artifact: {item['path']}")
    prefix = storage["prefix"].strip("/")
    if not prefix.startswith("climate/") or ".." in prefix:
        raise ValueError("Refusing an unscoped publication prefix")
    print(json.dumps(dict(mode="UPLOAD" if args.upload else "dry-run", bucket=storage["bucket"], prefix=prefix, release=release, objects=len(files), bytes=sum(f["bytes"] for f in files))), flush=True)
    if not args.upload:
        return
    token = auth(args)
    endpoint = f'https://api.cloudflare.com/client/v4/accounts/{storage["accountId"]}/r2/buckets/{storage["bucket"]}/objects/'
    base = storage["publicBaseUrl"].rstrip("/") + "/"
    journal_path = args.output/f"published-{release}.json"
    journal = json.loads(journal_path.read_text()) if journal_path.exists() else {}
    journal_lock = threading.Lock()
    rate_lock = threading.Lock()
    next_request = 0.0

    def verify(key, sha):
        url = base + quote(key, safe="/")
        with requests.get(url, stream=True, timeout=(30, 180), headers={"Origin":"https://pgmaps.ahmadjalil.com"}) as response:
            response.raise_for_status()
            hasher = hashlib.sha256()
            for chunk in response.iter_content(1024*1024):
                hasher.update(chunk)
            if hasher.hexdigest() != sha:
                raise ValueError(f"Public R2 checksum mismatch: {key}")

    def put(key, payload, sha, mutable=False):
        nonlocal next_request
        headers = {"Authorization":"Bearer " + token, "Content-Type":content_type(key),
                   "Cache-Control":"no-cache, max-age=0" if mutable else "public, max-age=31536000, immutable"}
        for attempt in range(6):
            try:
                with rate_lock:
                    wait = max(0, next_request-time.monotonic())
                    if wait:
                        time.sleep(wait)
                    next_request = time.monotonic()+0.55
                response = requests.put(endpoint+quote(key,safe="/"), data=payload, headers=headers, timeout=(30,240))
                if response.status_code in (401,403):
                    raise PermissionError(f"R2 authorization failed ({response.status_code}); refresh Wrangler login")
                if not response.ok:
                    raise RuntimeError(f"R2 upload returned HTTP {response.status_code} for {key}")
                verify(key,sha)
                return
            except PermissionError:
                raise
            except Exception:
                if attempt == 5:
                    raise
                time.sleep(min(2**attempt,20))

    def upload(item):
        path=item["path"]
        if journal.get(path)==item["sha256"] and not args.reverify:
            return "resumed"
        key=f"{prefix}/releases/{release}/{path}"
        # Never trust an upload acknowledgement alone: public GET must hash-match.
        put(key,(directory/path).read_bytes(),item["sha256"])
        with journal_lock:
            journal[path]=item["sha256"]
            write_json(journal_path,journal)
        return "verified"

    # Catalogues last inside the release; globally visible latest pointer later still.
    ordered=sorted(files,key=lambda i:(i["path"] in ("manifest.json","checksums.json"), i["path"]))
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for count,status in enumerate(pool.map(upload,ordered),1):
            if count%20==0 or count==len(files):
                print(f"Published/verified {count}/{len(files)} objects ({status})",flush=True)
    source_manifest=json.loads((directory/"sources.json").read_text())
    for source in source_manifest["sources"]:
        for part in source["parts"]:
            part["path"]=f"releases/{release}/{part['path']}"
    payload=(json.dumps(source_manifest,sort_keys=True,separators=(",",":"))+"\n").encode()
    put(prefix+"/sources.json",payload,hashlib.sha256(payload).hexdigest(),True)
    pointer=dict(schemaVersion=1,release=release,manifest=f"releases/{release}/manifest.json",sha256=digest(directory/"manifest.json"))
    payload=(json.dumps(pointer,sort_keys=True,separators=(",",":"))+"\n").encode()
    put(prefix+"/latest.json",payload,hashlib.sha256(payload).hexdigest(),True)
    print(f"LIVE: {base}{prefix}/latest.json",flush=True)
    print(f"PREVIEW: {base}{prefix}/releases/{release}/preview.html",flush=True)


if __name__=="__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output",type=Path,default=HERE/"output")
    p.add_argument("--upload",action="store_true")
    p.add_argument("--wrangler-auth",action="store_true")
    p.add_argument("--auth-file",type=Path)
    p.add_argument("--workers",type=int,default=3)
    p.add_argument("--reverify",action="store_true",help="Upload/readback even previously verified journal entries")
    publish(p.parse_args())
