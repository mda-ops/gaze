from app.connectors import RevenueCatcherJSONConnector, apply_mapping, guess_mapping
from app.database import connect, insert_import, load_transactions
from app.validation import validate_transactions

SOURCE_NAME = "Revenue Catcher shifts/history sample - 2026-08-10 to 2026-08-11"
SOURCE_PATH = r"C:\Users\HP\.codex\attachments\d52a4398-4095-41a7-8ddd-b6eb5796b15d\pasted-text.txt"


def remove_existing_history_samples():
    with connect() as conn:
        ids = [
            row["id"]
            for row in conn.execute(
                "SELECT id FROM imports WHERE source_name LIKE 'Revenue Catcher shifts/history sample%' OR source_type = 'revenue_catcher_history_json'"
            ).fetchall()
        ]
        for import_id in ids:
            conn.execute("DELETE FROM raw_rows WHERE import_id = ?", (import_id,))
            conn.execute("DELETE FROM processed_transactions WHERE import_id = ?", (import_id,))
            conn.execute("DELETE FROM data_quality_issues WHERE import_id = ?", (import_id,))
            conn.execute("DELETE FROM imports WHERE id = ?", (import_id,))
        return ids


removed = remove_existing_history_samples()
raw = RevenueCatcherJSONConnector(SOURCE_PATH).load()
mapping = guess_mapping(list(raw.columns))
processed = apply_mapping(raw, mapping)
issues = validate_transactions(processed)
insert_import(SOURCE_NAME, "revenue_catcher_history_json", raw, processed, issues, is_demo=False)
df = load_transactions()

shift_rows = df[df["shift_hours"].notna()]
print(f"removed={removed}")
print(f"loaded_shift_rows={len(raw)}")
print(f"shift_date_min={shift_rows['date'].min() if not shift_rows.empty else None}")
print(f"shift_date_max={shift_rows['date'].max() if not shift_rows.empty else None}")
print(f"total_shift_hours={shift_rows['shift_hours'].sum():.2f}")
