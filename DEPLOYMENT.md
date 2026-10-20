# GAZE Online Deployment

## What Changed

The app is now prepared for online hosting:

- Uses the hosting platform's `PORT`
- Can bind to `0.0.0.0`
- Has password protection through `APP_PASSWORD`
- Uses signed browser sessions through `APP_SECRET`
- Supports a configurable database path through `DATABASE_PATH`
- Includes `requirements.txt`, `Procfile`, and `runtime.txt`

## Railway Setup

1. Create a new Railway project.
2. Upload or connect this `revenue_analytics` folder as the app source.
3. Add these private environment variables:

```text
APP_PASSWORD=your-private-dashboard-password
APP_SECRET=a-long-random-secret-string
HOST=0.0.0.0
DATABASE_PATH=/data/revenue_analytics.sqlite
```

4. Add a Railway volume mounted at:

```text
/data
```

This keeps the SQLite database from disappearing between deploys.

5. Deploy.

## Important Security Note

Do not deploy this app publicly without `APP_PASSWORD` and `APP_SECRET`.

For a stronger production setup later, move from SQLite to PostgreSQL and add proper user accounts.
