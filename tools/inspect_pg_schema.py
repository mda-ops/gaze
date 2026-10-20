from __future__ import annotations

import os

import psycopg
from psycopg import sql


def main() -> None:
    database_url = os.environ["GAZE_PG_URL"]
    with psycopg.connect(database_url, connect_timeout=15) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT table_schema, table_name
                FROM information_schema.tables
                WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                  AND table_type = 'BASE TABLE'
                ORDER BY table_schema, table_name
                """
            )
            tables = cur.fetchall()
            print(f"tables {len(tables)}")
            for schema, table in tables:
                cur.execute(
                    sql.SQL("SELECT count(*) FROM {}.{}").format(
                        sql.Identifier(schema),
                        sql.Identifier(table),
                    )
                )
                count = cur.fetchone()[0]
                cur.execute(
                    """
                    SELECT column_name, data_type
                    FROM information_schema.columns
                    WHERE table_schema = %s
                      AND table_name = %s
                    ORDER BY ordinal_position
                    """,
                    (schema, table),
                )
                cols = cur.fetchall()
                print(f"[{schema}.{table}] rows={count}")
                print("  " + ", ".join(f"{name}:{dtype}" for name, dtype in cols[:40]))


if __name__ == "__main__":
    main()
