from __future__ import annotations

import os

import psycopg


QUERIES = {
    "latest_transactions": """
        SELECT t.id, t.occurred_at, t.creator_id, c.name AS creator_name,
               t.chatter_id, u.name AS chatter_name, t.creator_account_id,
               ca.username AS account_username, t.platform, t.type, t.status,
               t.gross_amount, t.net_amount, t.currency
        FROM transactions t
        LEFT JOIN creators c ON c.id = t.creator_id
        LEFT JOIN users u ON u.id = t.chatter_id
        LEFT JOIN creator_accounts ca ON ca.id = t.creator_account_id
        ORDER BY t.occurred_at DESC NULLS LAST
        LIMIT 10
    """,
    "date_totals": """
        SELECT occurred_at::date AS date, platform, type, status,
               count(*) AS rows, sum(gross_amount) AS gross
        FROM transactions
        WHERE occurred_at >= '2026-08-01'::date
        GROUP BY 1, 2, 3, 4
        ORDER BY 1 DESC, 2, 3
        LIMIT 40
    """,
    "latest_shifts": """
        SELECT s.id, s.date, s.clock_in, s.clock_out, s.creator_id,
               c.name AS creator_name, s.chatter_id, u.name AS chatter_name,
               s.platform
        FROM shifts s
        LEFT JOIN creators c ON c.id = s.creator_id
        LEFT JOIN users u ON u.id = s.chatter_id
        ORDER BY s.clock_in DESC NULLS LAST
        LIMIT 10
    """,
    "latest_inactivity": """
        SELECT ie.id, ie.started_at, ie.ended_at, ie.creator_account_id,
               ca.creator_id, c.name AS creator_name, ca.username AS account_username,
               ie.platform, ie.team, ie.orange_minutes, ie.red_minutes,
               ie.dormant_minutes, ie.orange_money_wasted_eur,
               ie.red_money_wasted_eur, ie.peak_unread_chats
        FROM inactivity_episodes ie
        LEFT JOIN creator_accounts ca ON ca.id = ie.creator_account_id
        LEFT JOIN creators c ON c.id = ca.creator_id
        ORDER BY ie.started_at DESC NULLS LAST
        LIMIT 10
    """,
}


def main() -> None:
    with psycopg.connect(os.environ["GAZE_PG_URL"], connect_timeout=15) as conn:
        with conn.cursor() as cur:
            for name, query in QUERIES.items():
                print(f"--- {name} ---")
                cur.execute(query)
                columns = [desc.name for desc in cur.description]
                print(" | ".join(columns))
                for row in cur.fetchall():
                    print(" | ".join("" if value is None else str(value) for value in row))


if __name__ == "__main__":
    main()
