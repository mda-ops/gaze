"""Extract the numbers shown on captured Python-app pages into JSON.

Reads <capture_dir>/manifest.json and every HTML page it lists, and writes
<capture_dir>/numbers.json with, per page:
  - cards:  every KPI / metric / stat tile as {label, value, note}
  - tables: every data table as {headers, rows}, using each cell's
            data-sort-value (the unrounded number) where the page has one
  - chart:  the window.chartData object, when the page embeds one

The rewrite's pages are compared against this file.

Usage: python v2/tools/extract_reference.py v2/reference/<capture-date>
"""
from __future__ import annotations

import html as html_lib
import json
import math
import pathlib
import re
import sys
from html.parser import HTMLParser

CARD_CLASSES = ("kpi", "c-metric-card", "c-stat-tile")


class PageNumbers(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.cards: list[dict] = []
        self.tables: list[dict] = []
        self._card: dict | None = None
        self._card_depth = 0
        self._field: str | None = None
        self._field_depth = 0
        self._skip_depth = 0  # inside a tooltip <button>: ignore its text
        self._table: dict | None = None
        self._row: list | None = None
        self._cell: dict | None = None
        self._in_th = False
        self._depth = 0

    def handle_starttag(self, tag, attrs):
        self._depth += 1
        attrs = dict(attrs)
        classes = (attrs.get("class") or "").split()
        if self._card is None and tag in ("div", "a") and any(c in CARD_CLASSES for c in classes):
            self._card = {"label": "", "value": "", "note": ""}
            self._card_depth = self._depth
        elif self._card is not None and self._field is None and tag in ("span", "strong", "em"):
            field = {"span": "label", "strong": "value", "em": "note"}[tag]
            if not self._card[field]:
                self._field = field
                self._field_depth = self._depth
        if tag == "button" and not self._skip_depth:
            self._skip_depth = self._depth
        if tag == "table" and "data-table" in classes:
            self._table = {"headers": [], "rows": []}
        elif self._table is not None:
            if tag == "th":
                self._in_th = True
                self._table["headers"].append("")
            elif tag == "tr":
                self._row = []
            elif tag == "td" and self._row is not None:
                self._cell = {"text": "", "raw": attrs.get("data-sort-value"), "type": attrs.get("data-sort-type")}

    def handle_endtag(self, tag):
        if self._skip_depth and self._depth == self._skip_depth:
            self._skip_depth = 0
        if self._card is not None:
            if self._field and self._depth == self._field_depth:
                self._field = None
            if self._depth == self._card_depth and tag in ("div", "a"):
                self.cards.append({k: " ".join(v.split()) for k, v in self._card.items()})
                self._card = None
        if self._table is not None:
            if tag == "th":
                self._in_th = False
            elif tag == "td" and self._cell is not None:
                self._row.append(_cell_value(self._cell))
                self._cell = None
            elif tag == "tr" and self._row:
                self._table["rows"].append(self._row)
                self._row = None
            elif tag == "table":
                self.tables.append(self._table)
                self._table = None
        self._depth -= 1

    def handle_data(self, data):
        if self._skip_depth:
            return
        if self._card is not None and self._field:
            self._card[self._field] += data
        if self._table is not None:
            if self._in_th:
                self._table["headers"][-1] += data.strip()
            elif self._cell is not None:
                self._cell["text"] += data


def _cell_value(cell: dict):
    raw, text = cell["raw"], " ".join(cell["text"].split())
    if cell["type"] == "number" and raw not in (None, ""):
        try:
            return float(raw)
        except ValueError:
            return raw
    return text


CHART_RE = re.compile(r"<script>window\.chartData=(.*?);</script>", re.S)
TAG_RE = re.compile(r"<[^>]+>")

# Revenue cards of the model and chatter revenue pages (c_revenue_breakdown_cards)
# and the platform totals strip (c_platform_totals_strip): fixed markup from the
# Python app, so regular expressions are reliable here.
PLATFORM_TOTAL_RE = re.compile(
    r"<article class='platform-total-card'><span[^>]*>(.*?)</span><strong[^>]*>(.*?)</strong><em>(.*?)</em></article>", re.S)
REVENUE_CARD_RE = re.compile(r"<article class='model-revenue-card'>(.*?)</article>", re.S)
CARD_NAME_RE = re.compile(r"<h3>(.*?)</h3>", re.S)
CARD_HEAD_EXTRA_RE = re.compile(r"</h3>(.*?)</div>", re.S)
CARD_BADGES_RE = re.compile(r"<div class='model-revenue-meta'>(.*?)</div>", re.S)
CARD_TOTAL_RE = re.compile(r"(?:</div>|<div class='model-revenue-meta'>.*?</div>)<strong>(.*?)</strong>", re.S)
CARD_SUBSCRIPTIONS_RE = re.compile(r"<span class='model-subscription-total'>(.*?)</span>", re.S)
PLATFORM_ROW_RE = re.compile(
    r"<div class='model-platform-row'><span[^>]*>(.*?)</span><strong[^>]*>(.*?)</strong><em>(.*?)</em>", re.S)
SELECT_RE = re.compile(r"<select name=['\"]([^'\"]+)['\"][^>]*>(.*?)</select>", re.S)
OPTION_RE = re.compile(r"<option(?: value=\"([^\"]*)\")?[^>]*>(.*?)</option>", re.S)


def _text(fragment: str) -> str:
    return " ".join(html_lib.unescape(TAG_RE.sub(" ", fragment)).split())


def revenue_cards(page: str) -> list[dict]:
    cards = []
    for body in REVENUE_CARD_RE.findall(page):
        head_extra = CARD_HEAD_EXTRA_RE.search(body)
        badges = CARD_BADGES_RE.search(body)
        total = CARD_TOTAL_RE.search(body)
        subscriptions = CARD_SUBSCRIPTIONS_RE.search(body)
        cards.append({
            "name": _text(CARD_NAME_RE.search(body).group(1)),
            "head": _text(head_extra.group(1)) if head_extra else "",
            "badges": [_text(b) for b in re.findall(r"<span>(.*?)</span>", badges.group(1))] if badges else [],
            "total": _text(total.group(1)) if total else "",
            "subscriptions": _text(subscriptions.group(1)) if subscriptions else "",
            "platforms": [
                {"platform": _text(p), "amount": _text(a), "subs": _text(s)}
                for p, a, s in PLATFORM_ROW_RE.findall(body)
            ],
        })
    return cards


TIER_MATRIX_RE = re.compile(r"<table class='tier-matrix-table'>(.*?)</table>", re.S)
TIER_ROW_RE = re.compile(r"<tr><th class='model-name'>(.*?)</th>(.*?)</tr>", re.S)
TIER_CELL_RE = re.compile(r"<td class='tier-cell[^']*'[^>]*>(?:<strong>(.*?)<span>(.*?)</span></strong>|<em>-</em>)<small>(.*?)</small></td>", re.S)


# Chatting Revenue Tier matrix: months, then per model [tier, arrow, amount] per month.
def tier_matrix(page: str) -> dict | None:
    match = TIER_MATRIX_RE.search(page)
    if not match:
        return None
    body = match.group(1)
    months = [_text(m) for m in re.findall(r"<th>(.*?)</th>", body.split("</thead>")[0])]
    rows = []
    for model, cells in TIER_ROW_RE.findall(body.split("<tbody>", 1)[1]):
        rows.append([_text(model), [[_text(t or ""), _text(a or ""), _text(amount)] for t, a, amount in TIER_CELL_RE.findall(cells)]])
    return {"months": months, "rows": rows}


def select_options(page: str) -> dict[str, list[str]]:
    selects = {}
    for name, body in SELECT_RE.findall(page):
        selects[name] = [html_lib.unescape(value if value is not None and value != "" else _text(label))
                         for value, label in OPTION_RE.findall(body)]
    return selects


def extract(html: str) -> dict:
    parser = PageNumbers()
    parser.feed(html)
    result = {"cards": parser.cards, "tables": parser.tables}
    match = CHART_RE.search(html)
    if match:
        result["chart"] = json.loads(match.group(1))
    totals = PLATFORM_TOTAL_RE.findall(html)
    if totals:
        result["platform_totals"] = [{"platform": _text(p), "amount": _text(a), "share": _text(s)} for p, a, s in totals]
    cards = revenue_cards(html)
    if cards:
        result["revenue_cards"] = cards
    selects = select_options(html)
    if selects:
        result["selects"] = selects
    matrix = tier_matrix(html)
    if matrix:
        result["tier_matrix"] = matrix
    return result


def _json_safe(value):
    # Python's json writes NaN/Infinity, which JSON (and JavaScript) reject.
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    return value


def main(capture_dir: pathlib.Path) -> None:
    manifest = json.loads((capture_dir / "manifest.json").read_text(encoding="utf-8"))
    numbers = {"captured_at": manifest["captured_at"], "settings": manifest["settings"], "pages": {}}
    for page in manifest["pages"]:
        html = (capture_dir / page["file"]).read_text(encoding="utf-8", errors="replace")
        key = f"{page['range']} {page['path']}"
        numbers["pages"][key] = {"status": page["status"], "seconds": page["seconds"], **extract(html)}
    (capture_dir / "numbers.json").write_text(json.dumps(_json_safe(numbers), indent=1, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    pages = numbers["pages"].values()
    print(f"{len(numbers['pages'])} pages, {sum(len(p['cards']) for p in pages)} cards, "
          f"{sum(len(p['tables']) for p in pages)} tables, {sum('chart' in p for p in pages)} charts")


if __name__ == "__main__":
    main(pathlib.Path(sys.argv[1]))
