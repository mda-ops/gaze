"""Capture reference HTML + timing for every GET page of the running Python Gaze app.

Full procedure (repo root, REVENUE_CATCHER_DATABASE_URL set):
  1. Start the Python app with a long query timeout:
         .venv/Scripts/python v2/tools/run_legacy_for_reference.py
  2. List the routes:
         .venv/Scripts/python v2/tools/route_inventory.py . > inventory.json
  3. Capture (resumable; failed pages are retried on the next run):
         .venv/Scripts/python v2/tools/capture_reference.py http://127.0.0.1:8766 inventory.json v2/reference/<date> [ranges] [paths]
     Optional comma-separated filters re-capture only some ranges/pages,
     e.g. "2026-10-01_day" "/c-hub/commissions,/c-hub/target-monitoring".
  4. Extract the numbers:
         .venv/Scripts/python v2/tools/extract_reference.py v2/reference/<date>

The EUR/USD rate is recorded in fx-rate.json: USD revenue is converted with
Flow's *current* rate, so comparing with the capture later needs that rate.
"""
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

base_url, inventory_path, out_dir = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
only_ranges = set(sys.argv[4].split(",")) if len(sys.argv) > 4 and sys.argv[4] else None
only_paths = set(sys.argv[5].split(",")) if len(sys.argv) > 5 and sys.argv[5] else None

RANGES = {
    "2026-09_month": ("2026-09-01", "2026-09-30"),
    "2026-10-02_week": ("2026-10-02", "2026-10-08"),
    "2026-10-01_day": ("2026-10-01", "2026-10-01"),
}
# Pages without data that depends on a date range: captured once.
STATIC = {"/", "/data-quality", "/data-sources", "/settings", "/edit-site", "/account",
          "/permission-groups", "/people-access", "/metric-definitions",
          "/inactivity-computation", "/architecture"}

routes = [r["path"] for r in json.loads(pathlib.Path(inventory_path).read_text()) if r["method"] == "GET"]


def fetch(path: str, query: dict) -> tuple[int, float, bytes]:
    url = base_url + path + ("?" + urllib.parse.urlencode(query) if query else "")
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(url, timeout=300) as resp:
            body, status = resp.read(), resp.status
    except urllib.error.HTTPError as exc:
        body, status = exc.read(), exc.code
    except (urllib.error.URLError, ConnectionError, TimeoutError) as exc:
        # The Python app's http.server drops the connection when a handler raises.
        body, status = f"CAPTURE ERROR: {exc!r}".encode(), 0
    return status, time.perf_counter() - t0, body


def current_fx_rate() -> float | None:
    url = os.environ.get("REVENUE_CATCHER_DATABASE_URL")
    if not url:
        return None
    import psycopg

    with psycopg.connect(url, connect_timeout=10, options="-c default_transaction_read_only=on") as conn:
        row = conn.execute("SELECT eur_usd_rate FROM fx_rate_cache ORDER BY fetched_at DESC LIMIT 1").fetchone()
    return float(row[0]) if row else None


def slug(path: str) -> str:
    return path.strip("/").replace("/", "__") or "welcome"


manifest_path = out_dir / "manifest.json"
previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
manifest = {"captured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "base_url": base_url, "settings": "defaults (no data/settings.json)", "pages": []}
jobs = [("static", None, p) for p in routes if p in STATIC]
jobs += [(name, rng, p) for name, rng in RANGES.items() for p in routes if p not in STATIC]
jobs = [j for j in jobs if (only_ranges is None or j[0] in only_ranges) and (only_paths is None or j[2] in only_paths)]

done = set()
if previous:  # resume: keep pages already captured successfully
    manifest = previous
    manifest["pages"] = [pg for pg in previous["pages"] if pg["status"] == 200]
    done = {(pg["range"], pg["path"]) for pg in manifest["pages"]}

fx_path = out_dir / "fx-rate.json"
rate_at_start = current_fx_rate()
out_dir.mkdir(parents=True, exist_ok=True)
if not fx_path.exists():
    fx_path.write_text(json.dumps({"eur_usd_rate": rate_at_start, "source": "fx_rate_cache at capture start"}, indent=1))

for i, (range_name, rng, path) in enumerate(jobs, 1):
    if (range_name, path) in done:
        continue
    query = {"range": "Custom", "start": rng[0], "end": rng[1], "compare": "Previous period"} if rng else {}
    status, seconds, body = fetch(path, query)
    target = out_dir / range_name / f"{slug(path)}.html"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(body)
    manifest["pages"].append({"range": range_name, "path": path, "query": query, "status": status, "seconds": round(seconds, 2), "bytes": len(body), "file": str(target.relative_to(out_dir))})
    print(f"[{i}/{len(jobs)}] {status} {seconds:6.2f}s {range_name:16} {path}", flush=True)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1))

rate_at_end = current_fx_rate()
if rate_at_end != rate_at_start:
    print(f"WARNING: Flow's EUR/USD rate changed during the capture ({rate_at_start} -> {rate_at_end}); "
          "pages captured before and after the change are not comparable. Capture again.", flush=True)
