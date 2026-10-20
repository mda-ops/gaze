"""Revenue Catcher native amounts normalized to Gaze's EUR reporting currency."""
from __future__ import annotations

import json
import math
import os
from urllib import request

import pandas as pd


MONEY_COLUMNS = (
    "revenue", "unlock_amount", "subscription_revenue", "tip_revenue",
    "message_revenue", "net_amount", "platform_net_amount", "creator_net_amount",
    "md_net_amount", "partner_net_amount", "other_net_amount", "chatter_net_amount",
    "manager_net_amount", "commission_earned",
)


def revenue_catcher_rate() -> float:
    # Read the same current rate as Revenue Catcher; never assume USD equals EUR.
    from .postgres_source import configured_database_url, _read_sql
    database_url = configured_database_url()
    if database_url:
        rates = _read_sql(
            "SELECT eur_usd_rate FROM fx_rate_cache ORDER BY fetched_at DESC LIMIT 1",
            database_url,
        )
        value = rates.iloc[0]["eur_usd_rate"] if not rates.empty else None
    else:
        from .config import load_settings
        settings = load_settings()
        base = settings.get("revenue_catcher_base_url", "https://revenuecatcher-production.up.railway.app").rstrip("/")
        key = os.environ.get("REVENUE_CATCHER_API_KEY") or settings.get("revenue_catcher_api_key", "")
        req = request.Request(base + "/api/shifts/fx-rate", headers={"Accept": "application/json", "x-api-key": key})
        with request.urlopen(req, timeout=6) as response:
            value = json.load(response).get("eurUsdRate")
    return valid_rate(value)


def valid_rate(value) -> float:
    try:
        rate = float(value)
    except (TypeError, ValueError):
        raise ValueError("Revenue Catcher EUR/USD rate is unavailable.") from None
    if not math.isfinite(rate) or rate <= 0:
        raise ValueError("Revenue Catcher EUR/USD rate must be positive and finite.")
    return rate


def normalize_revenue_catcher(frame: pd.DataFrame, rate: float | None = None) -> pd.DataFrame:
    """Convert all native money fields together, without rounding before aggregation.

    New summary values already contain converted {eur, usd} pairs. Select eur
    directly. Scalar values follow their native currency; missing currency uses
    Revenue Catcher's platform convention (F2F EUR, OF/KNKY USD).
    """
    result = frame.copy()
    if result.empty:
        return result
    platform = result.get("platform", pd.Series("", index=result.index)).fillna("").astype(str).str.upper()
    currency = result.get("currency", pd.Series("", index=result.index)).fillna("").astype(str).str.strip().str.upper()
    currency = currency.mask(currency.eq(""), platform.map({"F2F": "EUR", "OF": "USD", "KNKY": "USD"}).fillna("EUR"))
    scalar_usd = pd.Series(False, index=result.index)
    for column in MONEY_COLUMNS:
        if column in result:
            scalar_usd |= currency.eq("USD") & result[column].notna() & ~result[column].map(lambda value: isinstance(value, dict))
    fx = valid_rate(rate) if scalar_usd.any() and rate is not None else revenue_catcher_rate() if scalar_usd.any() else 1.0
    for column in MONEY_COLUMNS:
        if column not in result:
            continue
        converted = []
        for value, native in zip(result[column], currency):
            if isinstance(value, dict):
                if value.get("eur") is None:
                    raise ValueError("Revenue Catcher currency pair is missing its EUR amount.")
                converted.append(float(value["eur"]))
            elif pd.isna(value):
                converted.append(value)
            elif native in {"EUR", "USD"}:
                converted.append(float(value) / fx if native == "USD" else float(value))
            else:
                raise ValueError(f"Unsupported Revenue Catcher currency: {native}")
        result[column] = converted
    result["currency"] = "EUR"
    return result
