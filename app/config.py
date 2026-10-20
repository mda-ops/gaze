from __future__ import annotations

import json
import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = APP_DIR / "data"
EXPORT_DIR = APP_DIR / "exports"
DB_PATH = Path(os.environ.get("DATABASE_PATH", DATA_DIR / "revenue_analytics.sqlite"))
SETTINGS_PATH = DATA_DIR / "settings.json"
MAPPINGS_PATH = DATA_DIR / "column_mappings.json"

DEFAULT_SETTINGS = {
    "reporting_week_start": "Friday",
    "default_currency": "EUR",
    "timezone": "Europe/Amsterdam",
    "unlock_threshold": 199.0,
    "inactivity_threshold_minutes": 120,
    "low_revenue_per_hour_threshold": 50.0,
    "high_revenue_per_hour_threshold": 250.0,
    "anomaly_revenue_drop_pct": 30.0,
    "anomaly_revenue_spike_pct": 40.0,
    "master_google_sheet_url": "https://docs.google.com/spreadsheets/d/1m9dt-YmwTQM58JdXDfVslzxysnSUEWFjlGU3A4FxasQ/edit?gid=759629051#gid=759629051",
    "master_google_sheet_id": "1m9dt-YmwTQM58JdXDfVslzxysnSUEWFjlGU3A4FxasQ",
    "master_revenue_gid": "759629051",
    "master_shifts_gid": "2108008269",
    "master_modelmap_gid": "2052695705",
    "revenue_catcher_base_url": "https://revenuecatcher-production.up.railway.app",
    "revenue_catcher_start_date": "2026-05-20",
    "revenue_catcher_api_key": "",
    "english_chatter_salary_usd_per_hour": 2.0,
    "viewer_allowed_routes": [
        "/c-hub",
        "/c-hub/executive-overview",
        "/c-hub/revenue",
        "/c-hub/chatter-revenue",
        "/c-hub/inactivity",
        "/c-hub/performance",
        "/c-hub/commissions",
        "/c-hub/transactions",
        "/c-hub/target-monitoring",
        "/c-hub/chatter-revenue-tier",
        "/c-hub/compliance",
        "/c-hub/tickets",
        "/c-hub/marketing-ads",
        "/c-hub/models-socials",
        "/c-hub/of-new-fans",
        "/c-hub/ads-performance",
        "/compliance-dash",
        "/marketing",
        "/models-socials",
        "/of-new-fan-growth",
        "/ads-performance",
        "/notion-tickets",
    ],
    "shared_people_credentials_version": "2026-08-31-c-hub-hub-access",
    "shared_people": {
        "anne": {
            "name": "Anne",
            "title": "Admin",
            "role": "admin",
            "username": "anne",
            "email": "",
            "photo_url": "",
            "password_hash": "pbkdf2_sha256$anne0000000000000000$960f7008e80acc064e2a821fb0947e27b31e58bc84fcd184fa6d02b1c02ae52c",
            "allowed_routes": ["*"],
        },
        "damian": {
            "name": "Damian",
            "title": "CEO",
            "role": "viewer",
            "username": "damian",
            "email": "",
            "photo_url": "",
            "password_hash": "pbkdf2_sha256$damian0000000000000000$0d779b3d18379c4f5f8acabef43780a23628a0a7f82fc1fd96adf5f1c4493be6",
            "allowed_routes": ["/c-hub", "/c-hub/executive-overview", "/c-hub/revenue", "/c-hub/chatter-revenue", "/c-hub/inactivity", "/c-hub/performance", "/c-hub/commissions", "/c-hub/transactions", "/c-hub/target-monitoring", "/c-hub/chatter-revenue-tier", "/c-hub/compliance", "/c-hub/tickets", "/c-hub/marketing-ads", "/c-hub/models-socials", "/c-hub/of-new-fans", "/c-hub/ads-performance", "/compliance-dash", "/marketing", "/models-socials", "/of-new-fan-growth", "/ads-performance", "/notion-tickets"],
        },
        "dusan": {
            "name": "Dusan",
            "title": "COO",
            "role": "viewer",
            "username": "dusan",
            "email": "",
            "photo_url": "",
            "password_hash": "pbkdf2_sha256$dusan0000000000000000$21f45f8235068870f9e37930a4cd364384dc9c475149fc0ebb5840e02d302c16",
            "allowed_routes": ["/c-hub", "/c-hub/executive-overview", "/c-hub/revenue", "/c-hub/chatter-revenue", "/c-hub/inactivity", "/c-hub/performance", "/c-hub/commissions", "/c-hub/transactions", "/c-hub/target-monitoring", "/c-hub/chatter-revenue-tier", "/c-hub/compliance", "/c-hub/tickets", "/c-hub/marketing-ads", "/c-hub/models-socials", "/c-hub/of-new-fans", "/c-hub/ads-performance", "/compliance-dash", "/marketing", "/models-socials", "/of-new-fan-growth", "/ads-performance", "/notion-tickets"],
        },
        "atamay": {
            "name": "Atamay",
            "title": "Operations Manager",
            "role": "viewer",
            "username": "atamay",
            "email": "",
            "photo_url": "",
            "password_hash": "pbkdf2_sha256$atamay0000000000000000$1d666737280d20f7cb1d51ae2d171adcc321a66f4648a2885beebb6420e0a71f",
            "allowed_routes": ["/c-hub", "/c-hub/executive-overview", "/c-hub/revenue", "/c-hub/chatter-revenue", "/c-hub/inactivity", "/c-hub/performance", "/c-hub/commissions", "/c-hub/transactions", "/c-hub/target-monitoring", "/c-hub/chatter-revenue-tier", "/c-hub/compliance", "/c-hub/tickets", "/c-hub/marketing-ads", "/c-hub/models-socials", "/c-hub/of-new-fans", "/c-hub/ads-performance", "/compliance-dash", "/marketing", "/models-socials", "/of-new-fan-growth", "/ads-performance", "/notion-tickets"],
        },
        "faruk": {
            "name": "Faruk",
            "title": "Super Admin / System Developer",
            "role": "admin",
            "username": "faruk",
            "email": "",
            "photo_url": "",
            "password_hash": "pbkdf2_sha256$faruk0000000000000000$78e6fd219c1ab5f6b6ce0fc6051710851162e100aa7750b4a269d9bbf6c8a47f",
            "allowed_routes": ["*"],
        },
        "myron": {
            "name": "Myron",
            "title": "CFO",
            "role": "viewer",
            "username": "myron",
            "email": "",
            "photo_url": "",
            "password_hash": "pbkdf2_sha256$myron0000000000000000$c7c1caea4c42f4616cb8428afb0e39082be78633748b2d613c1630b7bd0e1915",
            "allowed_routes": ["/c-hub", "/c-hub/executive-overview", "/c-hub/revenue", "/c-hub/chatter-revenue", "/c-hub/inactivity", "/c-hub/performance", "/c-hub/commissions", "/c-hub/transactions", "/c-hub/target-monitoring", "/c-hub/chatter-revenue-tier", "/c-hub/compliance", "/c-hub/tickets", "/c-hub/marketing-ads", "/c-hub/models-socials", "/c-hub/of-new-fans", "/c-hub/ads-performance", "/compliance-dash", "/marketing", "/models-socials", "/of-new-fan-growth", "/ads-performance", "/notion-tickets"],
        },
        "test-viewer": {
            "name": "Test Viewer",
            "title": "Shared Preview",
            "role": "viewer",
            "username": "test",
            "email": "",
            "photo_url": "",
            "password_hash": "pbkdf2_sha256$test0000000000000000$d817e9ef2c601d4dff1ebeab41ed52903552dc55ebe893599db445fb2a1a1128",
            "allowed_routes": ["/c-hub", "/c-hub/executive-overview", "/c-hub/revenue", "/c-hub/chatter-revenue", "/c-hub/inactivity", "/c-hub/performance", "/c-hub/commissions", "/c-hub/transactions", "/c-hub/target-monitoring", "/c-hub/chatter-revenue-tier", "/c-hub/compliance", "/c-hub/tickets", "/c-hub/marketing-ads", "/c-hub/models-socials", "/c-hub/of-new-fans", "/c-hub/ads-performance", "/compliance-dash", "/marketing", "/models-socials", "/of-new-fan-growth", "/ads-performance", "/notion-tickets"],
        },
    },
    "commission_rules": [
        {
            "name": "Default demo rule",
            "platform": "*",
            "creator": "*",
            "chatter": "*",
            "team": "*",
            "effective_from": "2026-01-01",
            "creator_pct": 30.0,
            "external_partner_pct": 0.0,
            "other_commission_pct": 0.0,
            "chatter_commission_pct": 8.0,
            "salary_per_hour": 0.0,
            "company_net_pct": 62.0,
        }
    ],
    "operating_expenses": [
        {"department": "Finance", "person": "Myron", "monthly_amount": 5000.0, "currency": "EUR"},
        {"department": "Finance", "person": "Melika", "monthly_amount": 600.0, "currency": "EUR"},
        {"department": "Finance", "person": "Mihajlo", "monthly_amount": 900.0, "currency": "EUR"},
        {"department": "Ops", "person": "Dusan", "monthly_amount": 7157.4, "currency": "EUR"},
        {"department": "Ops", "person": "Atamay", "monthly_amount": 1700.0, "currency": "EUR"},
        {"department": "Ops", "person": "Faruk", "monthly_amount": 800.0, "currency": "EUR"},
        {"department": "Ops", "person": "Juul", "monthly_amount": 2000.0, "currency": "EUR"},
        {"department": "Ops", "person": "Marli", "monthly_amount": 600.0, "currency": "USD"},
        {"department": "Ops", "person": "Lowella", "monthly_amount": 450.0, "currency": "USD"},
        {"department": "Ops", "person": "Kelechi", "monthly_amount": 1700.0, "currency": "USD"},
        {"department": "Quality", "person": "Anne", "monthly_amount": 1100.0, "currency": "USD"},
        {"department": "Quality", "person": "Zyrose", "monthly_amount": 400.0, "currency": "USD"},
        {"department": "Marketing", "person": "Beni", "monthly_amount": 2800.0, "currency": "EUR"},
        {"department": "Marketing", "person": "Lisa", "monthly_amount": 1400.0, "currency": "EUR"},
        {"department": "Marketing", "person": "Nerj", "monthly_amount": 1800.0, "currency": "EUR"},
        {"department": "Marketing", "person": "Alona", "monthly_amount": 600.0, "currency": "USD"},
        {"department": "Marketing", "person": "Jasmine", "monthly_amount": 300.0, "currency": "USD"},
        {"department": "BD", "person": "Mauro", "monthly_amount": 3000.0, "currency": "EUR"},
        {"department": "HR", "person": "Elethu", "monthly_amount": 1400.0, "currency": "USD"},
        {"department": "HR", "person": "Tirza", "monthly_amount": 250.0, "currency": "USD"},
        {"department": "Chat Dept Managers", "person": "Daniel", "monthly_amount": 2000.0, "currency": "EUR"},
        {"department": "Chat Dept Managers", "person": "Tineke", "monthly_amount": 3500.0, "currency": "EUR"},
    ],
}


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)


def load_json(path: Path, default):
    ensure_dirs()
    if not path.exists():
        path.write_text(json.dumps(default, indent=2), encoding="utf-8")
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, value) -> None:
    ensure_dirs()
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def load_settings() -> dict:
    loaded = load_json(SETTINGS_PATH, DEFAULT_SETTINGS.copy())
    merged = DEFAULT_SETTINGS.copy()
    merged.update(loaded)
    default_people = DEFAULT_SETTINGS.get("shared_people", {})
    loaded_people = merged.get("shared_people")
    if isinstance(default_people, dict) and isinstance(loaded_people, dict):
        people = {}
        for key, default_profile in default_people.items():
            loaded_profile = loaded_people.get(key)
            if isinstance(default_profile, dict) and isinstance(loaded_profile, dict):
                profile = default_profile.copy()
                profile.update(loaded_profile)
                people[key] = profile
            else:
                people[key] = loaded_profile if loaded_profile is not None else default_profile
        for key, loaded_profile in loaded_people.items():
            if key not in people:
                people[key] = loaded_profile
        merged["shared_people"] = people
    default_credentials_version = DEFAULT_SETTINGS.get("shared_people_credentials_version")
    if loaded.get("shared_people_credentials_version") != default_credentials_version:
        refresh_keys = {"damian", "dusan", "atamay", "faruk", "myron", "test-viewer"}
        people = merged.get("shared_people") if isinstance(merged.get("shared_people"), dict) else {}
        for key in refresh_keys:
            default_profile = default_people.get(key)
            if not isinstance(default_profile, dict):
                continue
            profile = people.get(key) if isinstance(people.get(key), dict) else {}
            profile = profile.copy()
            for field in ["name", "title", "role", "username", "password_hash"]:
                profile[field] = default_profile.get(field, "")
            profile["allowed_routes"] = list(default_profile.get("allowed_routes", []))
            people[key] = profile
        merged["shared_people"] = people
        merged["shared_people_credentials_version"] = default_credentials_version
    return merged


def save_settings(settings: dict) -> None:
    merged = DEFAULT_SETTINGS.copy()
    merged.update(settings)
    save_json(SETTINGS_PATH, merged)


def load_mappings() -> dict:
    return load_json(MAPPINGS_PATH, {})


def save_mappings(mappings: dict) -> None:
    save_json(MAPPINGS_PATH, mappings)
