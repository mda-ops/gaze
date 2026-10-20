"""Static inventory of Gaze routes: for each handler, the data sources and settings it reaches.

Walks the call graph inside app/*.py transitively from every route handler.
"""
import ast
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
modules = {}
for path in (root / "app").glob("*.py"):
    modules[path.stem] = ast.parse(path.read_text(encoding="utf-8"))

# function name -> (module, node); handler methods keyed as "self.<name>"
funcs = {}
for mod, tree in modules.items():
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            funcs.setdefault(node.name, (mod, node))
        if isinstance(node, ast.ClassDef) and node.name == "RevenueAnalyticsHandler":
            for item in node.body:
                if isinstance(item, ast.FunctionDef):
                    funcs["self." + item.name] = (mod, item)

SOURCE_PATTERNS = {
    "flow_pg:transactions+shifts+inactivity": r"^load_postgres_transactions$",
    "flow_pg:manager_transactions(visible_transactions)": r"^load_postgres_flow_manager_transactions$",
    "flow_pg:scheduled_shifts": r"^load_postgres_scheduled_shifts$",
    "flow_pg:account_targets": r"^load_postgres_account_targets$",
    "flow_pg:creator_tiers": r"^load_postgres_creator_tiers$",
    "flow_pg:creator_accounts": r"^load_postgres_creator_accounts$",
    "flow_pg:team_rules": r"^load_postgres_flow_team_rules$",
    "flow_pg:chatter_grades": r"^load_postgres_chatter_grades$",
    "flow_pg:fx_rate": r"^revenue_catcher_rate$",
    "flow_http_api(live)": r"^(live_revenue_catcher_frame|live_revenue_catcher_directory_frame|_fetch_revenue_catcher_\w+|flow_manager_dashboard_summary)$",
    "sqlite:transactions(fallback)": r"^load_transactions$",
    "sqlite:imports/quality": r"^(load_imports|load_quality_issues|insert_import|delete_demo_imports)$",
    "sqlite:creator/chatter lookup": r"^(load_creator_lookup|load_chatter_lookup|upsert_creator_lookup|upsert_chatter_lookup)$",
    "google_sheets": r"^(load_google_sheet_source|GoogleSheetsConnector)$",
    "looker_csv_snapshot": r"^load_source$",
    "notion_api": r"^(load_employee_rows|load_ticket_rows|_query_database|_search_databases)$",
    "notion_snapshot_csv": r"^load_chatter_snapshot$",
    "settings.json:write": r"^save_settings$",
    "file_upload/export": r"^(export_table|create_demo_csv)$",
}


def call_names(node):
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call):
            f = sub.func
            if isinstance(f, ast.Name):
                yield f.id
            elif isinstance(f, ast.Attribute):
                if isinstance(f.value, ast.Name) and f.value.id == "self":
                    yield "self." + f.attr
                else:
                    yield f.attr


def settings_keys(node):
    keys = set()
    for sub in ast.walk(node):
        # settings.get("key") / settings["key"] / ctx["settings"].get("key")
        if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute) and sub.func.attr == "get" and sub.args:
            target = ast.unparse(sub.func.value)
            if "settings" in target and isinstance(sub.args[0], ast.Constant) and isinstance(sub.args[0].value, str):
                keys.add(sub.args[0].value)
        if isinstance(sub, ast.Subscript) and "settings" in ast.unparse(sub.value) and isinstance(sub.slice, ast.Constant) and isinstance(sub.slice.value, str) and sub.slice.value != "settings":
            keys.add(sub.slice.value)
    return keys


def reach(start):
    seen, stack = set(), [start]
    while stack:
        name = stack.pop()
        if name in seen or name not in funcs:
            seen.add(name)
            continue
        seen.add(name)
        stack.extend(call_names(funcs[name][1]))
    return seen


web_src = (root / "app" / "web.py").read_text(encoding="utf-8")
get_routes = dict(re.findall(r'"(/[^"]*)": self\.(\w+),', web_src))
post_routes = dict((p, h) for p, h in re.findall(r'if parsed\.path == "(/[^"]*)":\s*\n\s*return self\.(\w+)\(', web_src))

inventory = []
for method, routes in [("GET", get_routes), ("POST", post_routes)]:
    for path, handler in routes.items():
        reached = reach("self." + handler)
        sources = sorted(label for label, pat in SOURCE_PATTERNS.items() if any(re.match(pat, n.removeprefix("self.")) for n in reached))
        keys = set()
        for n in reached:
            if n in funcs:
                keys |= settings_keys(funcs[n][1])
        mod, node = funcs.get("self." + handler, (None, None))
        inventory.append({
            "method": method,
            "path": path,
            "handler": handler,
            "line": node.lineno if node else None,
            "own_lines": (node.end_lineno - node.lineno + 1) if node else None,
            "reachable_functions": len([n for n in reached if n in funcs]),
            "sources": sources,
            "settings_keys": sorted(keys),
        })

print(json.dumps(inventory, indent=1))
