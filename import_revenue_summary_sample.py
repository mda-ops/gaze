from app.connectors import RevenueCatcherJSONConnector, apply_mapping, guess_mapping
from app.database import connect, insert_import, load_transactions
from app.validation import validate_transactions


def remove_revenue_catcher_imports():
    with connect() as conn:
        ids = [
            row["id"]
            for row in conn.execute(
                "SELECT id FROM imports WHERE source_name LIKE 'Revenue Catcher%'"
            ).fetchall()
        ]
        for import_id in ids:
            conn.execute("DELETE FROM raw_rows WHERE import_id = ?", (import_id,))
            conn.execute("DELETE FROM processed_transactions WHERE import_id = ?", (import_id,))
            conn.execute("DELETE FROM data_quality_issues WHERE import_id = ?", (import_id,))
            conn.execute("DELETE FROM imports WHERE id = ?", (import_id,))
        return ids


removed = remove_revenue_catcher_imports()
raw = RevenueCatcherJSONConnector("data/revenue_summary_2026_08_11.json").load()
mapping = guess_mapping(list(raw.columns))
processed = apply_mapping(raw, mapping)
issues = validate_transactions(processed)
insert_import(
    "Revenue Catcher revenue-summary sample - 2026-08-05 to 2026-08-11",
    "revenue_catcher_summary_json",
    raw,
    processed,
    issues,
    is_demo=False,
)
df = load_transactions()
print(f"removed={removed}")
print(f"loaded_rows={len(raw)}")
print(f"total_2026_08_11={df[df['date'].astype(str) == '2026-08-11']['revenue'].sum():.2f}")
