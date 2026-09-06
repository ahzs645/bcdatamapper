#!/usr/bin/env python3
"""One command: acquire -> native-grid build -> validated R2 publication."""
import argparse
from pathlib import Path
import subprocess
import sys

HERE=Path(__file__).resolve().parent

if __name__=="__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--archive-root",type=Path)
    p.add_argument("--restore",action="store_true")
    p.add_argument("--source-manifest")
    p.add_argument("--refresh",action="store_true")
    p.add_argument("--upload",action="store_true",help="Publish to R2; omitted means local build and publication dry run")
    p.add_argument("--wrangler-auth",action="store_true")
    args=p.parse_args()
    acquire=[]
    if args.archive_root: acquire += ["--archive-root",str(args.archive_root)]
    if args.source_manifest: acquire += ["--source-manifest",args.source_manifest]
    if args.restore: acquire += ["--restore"]
    if args.refresh: acquire += ["--refresh"]
    publish=[]
    if args.upload: publish += ["--upload"]
    if args.wrangler_auth: publish += ["--wrangler-auth"]
    for script,extra in [("acquire.py",acquire),("build.py",[]),("publish.py",publish)]:
        print(f"\n=== {script} ===",flush=True)
        subprocess.run([sys.executable,str(HERE/script),*extra],check=True)
