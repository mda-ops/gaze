# GAZE - Version 1 Plan and Architecture

## A. Proposed Architecture

Revenue Catcher, CSV/XLSX, or Google Sheets data enters through connector adapters. The imported raw rows are stored unchanged, then mapped into the standard schema, validated, saved as processed transactions, and analysed by deterministic Pandas functions. The browser dashboard only displays those calculated results.

Flow:

1. Data connector: CSV/XLSX now, Google Sheets later, Revenue Catcher API later.
2. Schema mapping: remembers incoming column to standard field mappings.
3. Data validation: flags missing, invalid, duplicate, negative, extreme, unknown, and inconsistent values.
4. SQLite storage: keeps raw rows, processed transactions, quality issues, imports, and calculated metrics separate.
5. Pandas analytics engine: calculates KPIs, comparisons, concentration, commissions, anomalies, reports, and deterministic Q&A.
6. Local web app: executive dashboard, analysis pages, data quality, exports, settings, metric definitions.

## B. Folder Structure

```text
revenue_analytics/
  app/
    analytics.py          KPI and filtering engine
    config.py             Local paths and editable settings
    connectors.py         CSV/XLSX, Google Sheets, Revenue Catcher adapter interfaces
    database.py           SQLite schema and storage functions
    exports.py            CSV/Excel export logic
    insights.py           Deterministic insights and anomaly flags
    reports.py            Weekly report generation
    sample_data.py        Clearly marked demo data generator
    schema.py             Standard fields and metric definitions
    validation.py         Data quality rules
    web.py                Local web application
    static/               CSS and dashboard JavaScript
    templates/            Browser layout
  data/
    revenue_analytics.sqlite
    settings.json
    column_mappings.json
  exports/
  tests/
  START_REVENUE_ANALYTICS.bat
  README.md
```

## C. Database Schema

Tables:

- `imports`: one record per upload/import, source name, source type, row count, demo flag.
- `raw_rows`: original imported rows as JSON. These are never modified.
- `processed_transactions`: mapped standard fields used for analysis.
- `data_quality_issues`: validation issues linked to import rows.
- `calculated_metrics`: storage area for calculated metric snapshots.

SQLite is used for Version 1 so the data stays local.

## D. Standard Data Schema

Core supported fields include `date`, `timestamp`, `creator`, `creator_id`, `chatter`, `chatter_id`, `platform`, `team`, `language`, `transaction_type`, `revenue`, `currency`, `unlock_amount`, `subscription_revenue`, `tip_revenue`, `message_revenue`, `shift_id`, `shift_start`, `shift_end`, `shift_hours`, `messages_sent`, `active_hours`, and `inactive_minutes`.

Fields may be missing. Missing fields are preserved as missing, not silently converted to zero.

## E. KPI Definitions

The app includes a Metric Definitions screen. Key formulas:

- Revenue change % = `(current - previous) / previous * 100`
- Revenue per hour = `total revenue / total shift_hours`
- Revenue share = `entity revenue / total selected revenue`
- Average transaction value = `total revenue / transaction count`
- Top-N concentration = `top N chatter revenue / total chatter revenue`
- Messages per hour = `messages_sent / shift_hours`
- Company net revenue = gross revenue minus configured commission amounts

## F. Dashboard Structure

Navigation:

Overview, Revenue, Chatters, Creators, Platforms, Inactivity, Transactions, Commissions, Insights, Weekly Report, Ask Your Data, Data Quality, Data Sources, Settings, Metric Definitions, Architecture.

All main analysis pages share date and operational filters.

## G. What Works in Version 1

- Local browser app
- Demo data loading
- CSV/XLSX import
- Master Google Sheet source saved in Settings
- Master Google Sheet Revenue-tab import when the Sheet permits direct CSV export
- Automatic schema mapping guesses
- Remembered mapping file
- SQLite storage
- Data quality screen
- Executive dashboard
- Chatter, creator, platform, inactivity, transaction, and commission pages
- Top performer concentration
- Unlocks above configurable threshold
- Deterministic insights
- Rule-based anomaly detection
- Weekly report generation
- Ask Your Data common deterministic questions
- CSV/Excel exports
- Settings screen
- Metric definitions
- Automated KPI tests
- Windows double-click launcher

## H. What Requires Revenue Catcher API Access

- Direct Revenue Catcher import
- Authentication handling
- Pagination/rate-limit handling
- Exact API response mapping
- Incremental sync strategy

The `RevenueCatcherConnector` adapter exists but intentionally has no fake API implementation.

## Google Sheet Master DB

Configured source:

- Spreadsheet: `MD Master Revenue DB`
- Spreadsheet ID: `1m9dt-YmwTQM58JdXDfVslzxysnSUEWFjlGU3A4FxasQ`
- Revenue tab: `759629051`
- Shifts tab: `2108008269`
- ModelMap tab: `2052695705`

The local app can import the Revenue tab through Google CSV export only when the Sheet allows link-based export. Private Google Sheets need OAuth/API integration before fully automatic refresh can work.

## I. What Could Require Paid Services Later

- Hosted secure deployment
- User authentication
- Automated scheduled runs
- Managed database backups
- OpenAI natural-language commentary
- Google Sheets API integration at scale

## J. Questions / Blockers

No blocker for Version 1. Later, to connect Revenue Catcher, we need API endpoint, authentication method, available endpoints, response structure, pagination, rate limits, and field definitions.
