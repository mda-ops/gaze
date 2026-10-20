"""Shared financial definitions, classifications, and reconciliation rules.

Amounts passed to this module are in GAZE's reporting currency (EUR).  The
module deliberately keeps unknown inputs as ``None``: an unclassified Flow
net amount is useful evidence, but it is not enough to manufacture a complete
P&L.
"""
from __future__ import annotations

from typing import Any


METRIC_REGISTRY: dict[str, dict[str, str]] = {
    "gross_revenue": {"label": "Gross Revenue", "definition": "Total revenue generated before deductions.", "formula": ""},
    "flow_manager_gross": {"label": "Flow Manager Gross", "definition": "Gross revenue on the realised Flow Manager Dashboard scope: tips and messages with an MD agency amount plus settled subscriptions. It excludes PPV and unsettled subscriptions.", "formula": ""},
    "flow_manager_net": {"label": "Flow Manager Net", "definition": "The total MD agency amount on the same realised Flow Manager Dashboard scope used for Flow Manager Gross.", "formula": ""},
    "external_revenue_splits": {"label": "External Revenue Splits", "definition": "Revenue allocated to platforms, creators, partners, or other external parties.", "formula": ""},
    "agency_revenue": {"label": "Agency Revenue", "definition": "Gross revenue remaining after external revenue splits.", "formula": "Gross Revenue − External Revenue Splits"},
    "direct_revenue_costs": {"label": "Direct Revenue Costs", "definition": "Internal costs directly tied to generating or managing revenue.", "formula": "Commission + bonus + salary + manager cut"},
    "chatter_commission": {"label": "Chatter Commission", "definition": "Commission allocated to chatters from eligible attributed revenue.", "formula": ""},
    "chatter_bonus": {"label": "Chatter Bonus", "definition": "Bonus calculated from Flow's applicable team bonus rules.", "formula": ""},
    "chatter_salary": {"label": "Chatter Salary", "definition": "Recorded or configured salary attributable to the selected period.", "formula": ""},
    "manager_commission": {"label": "Chat Manager Commission", "definition": "Commission allocated through Flow's effective-dated chat-manager rate.", "formula": ""},
    "net_revenue": {"label": "Net Revenue", "definition": "Agency revenue remaining after direct revenue costs.", "formula": "Agency Revenue − Direct Revenue Costs"},
    "operating_expenses": {"label": "Operating Expenses", "definition": "Business running costs not already included in revenue splits or direct costs.", "formula": ""},
    "profit_loss": {"label": "P&L Profit/Loss", "definition": "Final profit or loss after direct costs and operating expenses.", "formula": "Net Revenue − Operating Expenses", "colour": "profit_loss"},
    "profit_margin": {"label": "Profit Margin", "definition": "Final profit or loss as a share of gross revenue.", "formula": "P&L Profit/Loss ÷ Gross Revenue", "colour": "profit_loss"},
    "net_revenue_margin": {"label": "Net Revenue Margin", "definition": "Net revenue as a share of gross revenue.", "formula": "Net Revenue ÷ Gross Revenue"},
    "revenue_per_hour": {"label": "Revenue / Hour", "definition": "Selected revenue divided by recorded shift hours.", "formula": ""},
    "inactivity_cost": {"label": "Inactivity Cost", "definition": "Estimated revenue lost during scheduled inactive time.", "formula": ""},
    "md_earnings_after_expenses": {"label": "MD Earnings After Expenses", "definition": "The retained management pool after tracked operating expenses.", "formula": "Management pool − Operating Expenses", "colour": "profit_loss"},
}


def metric_key_for_label(label: object) -> str | None:
    clean = str(label or "").strip().casefold()
    for key, meta in METRIC_REGISTRY.items():
        if clean == meta["label"].casefold():
            return key
    aliases = {
        "gross rev": "gross_revenue", "gross profit": "agency_revenue", "net rev": "net_revenue",
        "net margin": "net_revenue_margin", "p&l profit": "profit_loss",
        "total operating expenses": "operating_expenses", "flow chatter bonus": "chatter_bonus",
        "chatter salary cost": "chatter_salary", "chat manager cuts": "manager_commission",
        "md earnings after expenses": "md_earnings_after_expenses",
    }
    return aliases.get(clean)


def metric_definition(metric_key: str | None) -> dict[str, str] | None:
    return METRIC_REGISTRY.get(metric_key or "")


def _amount(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _sum_known(*values: Any) -> float | None:
    parsed = [_amount(value) for value in values]
    return sum(parsed) if all(value is not None for value in parsed) else None


def financial_ledger(*, gross_revenue: Any, platform_fees: Any = None,
                     creator_share: Any = None, partner_share: Any = None,
                     other_external: Any = None, chatter_commission: Any = None,
                     chatter_bonus: Any = None, chatter_salary: Any = None,
                     manager_commission: Any = None, other_direct_costs: Any = None,
                     operating_expenses: Any = None, source: str = "") -> dict[str, Any]:
    """Return the standard GAZE financial hierarchy without inventing data."""
    gross = _amount(gross_revenue)
    external = _sum_known(platform_fees, creator_share, partner_share, other_external)
    agency = gross - external if gross is not None and external is not None else None
    direct = _sum_known(chatter_commission, chatter_bonus, chatter_salary, manager_commission, other_direct_costs)
    net = agency - direct if agency is not None and direct is not None else None
    opex = _amount(operating_expenses)
    pnl = net - opex if net is not None and opex is not None else None
    return {
        "source": source,
        "gross_revenue": gross,
        "platform_share": _amount(platform_fees),
        "creator_share": _amount(creator_share),
        "partner_share": _amount(partner_share),
        "other_share": _amount(other_external),
        "external_revenue_splits": external,
        "agency_revenue": agency,
        "chatter_commission": _amount(chatter_commission),
        "chatter_bonus": _amount(chatter_bonus),
        "chatter_salary": _amount(chatter_salary),
        "manager_commission": _amount(manager_commission),
        "other_direct_costs": _amount(other_direct_costs),
        "direct_revenue_costs": direct,
        "net_revenue": net,
        "operating_expenses": opex,
        "profit_loss": pnl,
        "profit_margin_pct": pnl / gross * 100 if pnl is not None and gross else None,
        "net_revenue_margin_pct": net / gross * 100 if net is not None and gross else None,
        "is_complete": all(value is not None for value in (gross, external, direct, opex)),
    }
