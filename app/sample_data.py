from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
import random

import pandas as pd

from .config import DATA_DIR, ensure_dirs


def create_demo_csv(path: Path | None = None) -> Path:
    ensure_dirs()
    path = path or DATA_DIR / "DEMO_revenue_analytics_sample.csv"
    random.seed(42)
    creators = ["Ava North", "Lena Vale", "Mila Stone", "Nora Blue", "Iris Ray", "Sofia Lux"]
    chatters = ["Marta", "Elena", "Ruben", "Nina", "Daan", "Sara", "Leo", "Eva", "Tom", "Lotte", "Unassigned"]
    platforms = ["F2F", "OnlyFans", "Kinky", "FanCentro", "Fansly"]
    teams = ["Dutch", "German", "English"]
    languages = ["NL", "DE", "EN"]
    types = ["unlock", "tip", "subscription", "message"]
    rows = []
    start = date(2026, 6, 19)
    for day in range(53):
        current = start + timedelta(days=day)
        for _ in range(random.randint(8, 16)):
            chatter = random.choices(chatters, weights=[14, 13, 12, 10, 9, 9, 7, 6, 5, 4, 1])[0]
            creator = random.choice(creators)
            platform = random.choice(platforms)
            transaction_type = random.choices(types, weights=[40, 25, 20, 15])[0]
            base = {"unlock": 135, "tip": 62, "subscription": 28, "message": 44}[transaction_type]
            revenue = round(max(5, random.gauss(base, base * 0.45)), 2)
            if transaction_type == "unlock" and random.random() < 0.12:
                revenue = round(random.uniform(199, 520), 2)
            hours = round(random.uniform(0.3, 2.3), 2)
            inactive = round(random.uniform(0, 80), 1)
            if chatter in ["Tom", "Lotte"] and random.random() < 0.35:
                inactive += random.randint(70, 180)
            rows.append({
                "date": current.isoformat(),
                "timestamp": f"{current.isoformat()} {random.randint(8, 23):02d}:{random.choice([0, 15, 30, 45]):02d}:00",
                "creator": creator,
                "creator_id": creator[:3].upper(),
                "chatter": None if chatter == "Unassigned" else chatter,
                "chatter_id": None if chatter == "Unassigned" else chatter[:3].upper(),
                "platform": platform,
                "team": random.choice(teams),
                "language": random.choice(languages),
                "transaction_type": transaction_type,
                "revenue": revenue,
                "currency": "EUR",
                "unlock_amount": revenue if transaction_type == "unlock" else 0,
                "subscription_revenue": revenue if transaction_type == "subscription" else 0,
                "tip_revenue": revenue if transaction_type == "tip" else 0,
                "message_revenue": revenue if transaction_type == "message" else 0,
                "shift_id": f"S-{current.strftime('%Y%m%d')}-{random.randint(1, 4)}",
                "shift_start": f"{current.isoformat()} 08:00:00",
                "shift_end": f"{current.isoformat()} 16:00:00",
                "shift_hours": hours,
                "messages_sent": random.randint(3, 80),
                "active_hours": max(0, hours - inactive / 60),
                "inactive_minutes": inactive,
            })
    df = pd.DataFrame(rows)
    df = pd.concat([df, df.iloc[[5]]], ignore_index=True)
    df.loc[3, "revenue"] = -25
    df.loc[8, "platform"] = "NewPlatform"
    df.to_csv(path, index=False)
    return path

