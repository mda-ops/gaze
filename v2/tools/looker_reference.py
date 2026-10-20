"""Reference outputs of the Python app's Looker source functions, for v2's tests.

Saves the live Google Sheet CSVs once (so tests are repeatable), then runs
compliance_data, ads_data, model_socials_data, of_new_fans_data and
tickets_data on those files and the cached snapshots for a few date ranges.

Usage (repo root):
    .venv/Scripts/python v2/tools/looker_reference.py
Writes v2/reference/looker/ (gitignored: business data).
"""
from __future__ import annotations

import json
import math
import os
import sys
import urllib.request
from datetime import date
from pathlib import Path

sys.path.insert(0, os.getcwd())

import pandas as pd  # noqa: E402

from app import looker_sources as ls  # noqa: E402

OUT = Path("v2/reference/looker")
OUT.mkdir(parents=True, exist_ok=True)

SHEETS = {
    "live_marketing_ads.csv": (ls.MARKETING_SHEET_ID, ls.MARKETING_ADS_GID),
    "live_of_new_fans.csv": (ls.OF_NEW_FANS_SHEET_ID, ls.OF_NEW_FANS_GID),
}
for name, (sheet, gid) in SHEETS.items():
    url = f"https://docs.google.com/spreadsheets/d/{sheet}/export?format=csv&gid={gid}"
    with urllib.request.urlopen(url, timeout=60) as response:
        (OUT / name).write_bytes(response.read())


def saved_sheet(spreadsheet_id, gid, fallback_filename=None):
    name = next(n for n, (s, g) in SHEETS.items() if s == spreadsheet_id and g == gid)
    rows = pd.read_csv(OUT / name)
    rows.attrs["source"] = "Live Google Sheet"
    return rows


ls.load_google_sheet_source = saved_sheet
ls.load_ticket_rows = lambda force=False: pd.DataFrame()


def plain(value):
    if isinstance(value, pd.DataFrame):
        return {"columns": [str(c) for c in value.columns], "rows": [[plain(v) for v in row] for row in value.itertuples(index=False)]}
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (date, pd.Timestamp)):
        return str(value)
    return value


RANGES = [
    ("2026-09_month", date(2026, 9, 1), date(2026, 9, 30)),
    ("2026-10-02_week", date(2026, 10, 2), date(2026, 10, 8)),
    ("2026-10-01_day", date(2026, 10, 1), date(2026, 10, 1)),
    ("2026-q2", date(2026, 4, 1), date(2026, 6, 30)),
    ("2026-ytd", date(2026, 1, 1), date(2026, 10, 15)),
]
FUNCTIONS = ["compliance_data", "ads_data", "model_socials_data", "of_new_fans_data", "tickets_data"]

result = {"today_year": date.today().year, "ranges": {}}
for name, start, end in RANGES:
    result["ranges"][name] = {"start": str(start), "end": str(end)}
    for fn in FUNCTIONS:
        out = getattr(ls, fn)(start, end)
        out.pop("metrics", None) if fn != "compliance_data" else None
        result["ranges"][name][fn] = plain(out)

# Every distinct date text with its Year cell, and how the Python app reads it.
dates = []
frames = [ls.load_source(f) for f in ["compliance_looker.csv", "models_lisa_raw.csv", "marketing_ads.csv", "of_new_fans.csv", "notion_tickets.csv"]]
frames += [pd.read_csv(OUT / n) for n in SHEETS]
for frame in frames:
    parsed = ls.parsed_date_series(frame)
    col = next((c for c in ["Date of Evaluation", "Date", "Created", "Created At"] if c in frame), None)
    if not col:
        continue
    for index, raw in frame[col].items():
        year = frame.at[index, "Year"] if "Year" in frame else None
        dates.append([plain(raw), plain(year), plain(parsed.at[index])])
extra = ["5 Sept 2026", "2026-03-04", "04/03/2026", "31 Feb", "Jan", "12", "2026-08-18T10:15:00.000Z", "15 Oct, 2026", "1 Apr 25"]
for raw in extra:
    frame = pd.DataFrame({"Date": [raw]})
    dates.append([raw, None, plain(ls.parsed_date_series(frame).iloc[0])])
unique = [list(x) for x in dict.fromkeys(tuple(d) for d in dates)]
result["dates"] = unique

(OUT / "reference.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"Wrote {OUT / 'reference.json'}: {len(unique)} date cases")
