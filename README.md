# GAZE

GAZE is an internal dashboard for analysing revenue, chatter performance, creator performance, platforms, inactivity, transactions, commissions, insights, and weekly reporting.

It runs on your computer and stores data locally. Version 1 does not send revenue data to third-party AI services.

## Start the Application

Double-click:

```text
START_REVENUE_ANALYTICS.bat
```

Then open:

```text
http://127.0.0.1:8766
```

## Stop the Application

Close the black launcher window, or press `Ctrl + C` inside it.

## Online Version

The app is now prepared for hosting on Railway or a similar service.

For online use, set:

```text
APP_PASSWORD=your-private-dashboard-password
APP_SECRET=a-long-random-secret-string
HOST=0.0.0.0
DATABASE_PATH=/data/revenue_analytics.sqlite
```

See:

```text
DEPLOYMENT.md
```

Do not put the app online without a private password.

## Load Demo Data

1. Open `Data Sources`.
2. Click `Load DEMO DATA`.
3. Go to `Overview`.

The demo file is clearly marked as demo data.

## Upload Your Own Data

1. Open `Data Sources`.
2. Choose a `.csv`, `.xlsx`, or `.xls` file.
3. Click upload.
4. Review `Data Quality`.

The original imported rows are stored separately from processed analytics rows.

## Import the Master Google Sheet

The master database is configured as:

```text
MD Master Revenue DB
Revenue tab: 759629051
Shifts tab: 2108008269
ModelMap tab: 2052695705
```

Open `Data Sources` and click `Import Master Google Sheet`.

Important: direct import works only if Google allows CSV export by link. If the Sheet is private, Google will block the local app. In that case, either:

- export the Revenue tab as CSV/XLSX and upload it,
- publish/share the Revenue tab for link-based CSV export, or
- connect a proper Google OAuth/API connector later.

## Column Mapping

The app guesses common mappings automatically and remembers them in:

```text
data\column_mappings.json
```

For example, an incoming column named `Chatter Name` can map to the standard field `chatter`.

## Change Settings

Open `Settings` to change:

- Reporting week start
- Default currency
- Timezone
- Unlock threshold
- Inactivity threshold
- Anomaly thresholds
- Commission rule values

## Export Reports and Tables

The Transactions page can export high-value unlock tables to CSV or Excel.

Exports are saved in:

```text
exports\
```

## Where Data Is Stored

The local database is:

```text
data\revenue_analytics.sqlite
```

Settings are:

```text
data\settings.json
```

## Back Up the Database

Copy this file to a safe location:

```text
data\revenue_analytics.sqlite
```

## Connect Revenue Catcher Later

Version 1 includes a `RevenueCatcherConnector` adapter but does not invent an API.

To connect Revenue Catcher later, provide:

- API endpoint
- Authentication method
- Available endpoints
- Response structure
- Pagination details
- Rate limits
- Field definitions

Then only the connector needs to be updated; the analytics engine can stay the same.
