import argparse, json, math, pathlib, subprocess, time

p = argparse.ArgumentParser(
    description="Resume a bounded-concurrency archive of the entire published CCISS tile extent"
)
p.add_argument("--archive", type=pathlib.Path, required=True)
p.add_argument("--metadata", type=pathlib.Path, required=True)
a = p.parse_args()
base = a.archive
base.mkdir(parents=True, exist_ok=True)
meta = json.loads(a.metadata.read_text())
if meta["id"] != "NewFeas_1961_1990_ref_C4_Pl":
    raise ValueError("Unexpected layer")
(base / "tilejson.json").write_text(json.dumps(meta, sort_keys=True))
b = meta["bounds"]
z = 12
xy = lambda lon, lat: (
    int((lon + 180) / 360 * 2**z),
    int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**z),
)
x0, y0 = xy(b[0], b[3])
x1, y1 = xy(b[2], b[1])
wanted = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]


def valid(p):
    if not p.exists():
        return False
    with p.open("rb") as f:
        h = f.read(12)
    return (
        h[:4] == b"RIFF"
        and h[8:12] == b"WEBP"
        and int.from_bytes(h[4:8], "little") + 8 == p.stat().st_size
    )


pending = [
    (x, y)
    for x, y in wanted
    if not valid(base / f"{z}-{x}-{y}.webp")
    and not (base / f"{z}-{x}-{y}.empty").exists()
]
print("tiles", len(wanted), "cached", len(wanted) - len(pending), flush=True)
t = time.monotonic()
for offset in range(0, len(pending), 512):
    batch = pending[offset : offset + 512]
    cfg = base / "batch.curl"
    cfg.write_text(
        "\n".join(
            f'url = "https://tileserver.thebeczone.ca/data/{meta["id"]}/{z}/{x}/{y}.webp"\noutput = "{base}/{z}-{x}-{y}.part"'
            for x, y in batch
        )
    )
    proc = subprocess.run(
        [
            "curl",
            "--parallel",
            "--parallel-max",
            "8",
            "--silent",
            "--show-error",
            "--fail",
            "--retry",
            "2",
            "--connect-timeout",
            "10",
            "--max-time",
            "30",
            "--write-out",
            "%{http_code} %{filename_effective}\n",
            "--config",
            str(cfg),
        ],
        capture_output=True,
        text=True,
    )
    errors = []
    for line in proc.stdout.splitlines():
        code, name = line.split(" ", 1)
        p = pathlib.Path(name)
        if code == "200" and valid(p):
            p.rename(p.with_suffix(".webp"))
        elif code == "204":
            p.with_suffix(".empty").write_text("HTTP 204 No Content\n")
            p.unlink(missing_ok=True)
        else:
            errors.append(line)
    done = sum(
        valid(base / f"{z}-{x}-{y}.webp") or (base / f"{z}-{x}-{y}.empty").exists()
        for x, y in batch
    )
    print(
        f"{offset + done}/{len(pending)} fetched; {time.monotonic() - t:.1f}s",
        flush=True,
    )
    if errors or done != len(batch):
        raise RuntimeError(str(errors[:5]) + proc.stderr[-1000:])
print("DONE", flush=True)
