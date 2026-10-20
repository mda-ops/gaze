from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pandas as pd

from .config import EXPORT_DIR, ensure_dirs


def export_table(df: pd.DataFrame, name: str, filters: dict, file_type: str = "csv") -> Path:
    ensure_dirs()
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_name = name.lower().replace(" ", "_")
    if file_type == "xlsx":
        path = EXPORT_DIR / f"{safe_name}_{stamp}.xlsx"
        with pd.ExcelWriter(path, engine="openpyxl") as writer:
            df.to_excel(writer, sheet_name="Data", index=False)
            pd.DataFrame([filters]).to_excel(writer, sheet_name="Filters", index=False)
        return path
    path = EXPORT_DIR / f"{safe_name}_{stamp}.csv"
    meta = pd.DataFrame([{"filters_used": str(filters)}])
    with path.open("w", encoding="utf-8", newline="") as handle:
        handle.write("# GAZE export\n")
        handle.write(f"# Filters: {filters}\n")
        df.to_csv(handle, index=False)
    return path
