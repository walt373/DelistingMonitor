# Delisting Monitor Dashboard

This repository contains a static web dashboard for monitoring stocks likely to be delisted in the next month.

The default dataset is intentionally empty so no demo symbols are preloaded. Add your own tracked symbols in `data/stocks.json` (or via your generator pipeline).

## Run locally

```bash
node server.js
```

Open: <http://localhost:4173/index.html>

> Why this server? It includes lightweight `/api/sec-proxy` and `/api/market-proxy` endpoints so the dashboard can fetch SEC and Yahoo Finance data without browser CORS blocking.

## Host on GitHub Pages

1. Push this repository to GitHub.
2. Go to **Settings → Pages**.
3. Set **Source** to **Deploy from a branch**.
4. Select branch `main` and folder `/ (root)`.
5. Save and wait for deployment.

## Live auto-refresh behavior

- On page load, the app fetches `data/stocks.json`, then scans recent SEC current filings feeds for **8-K entries in the last 30 days** containing **"notice of delisting"**.
- Symbols inferred from those matching SEC filing entries are merged into the tracked universe automatically.
- The dashboard excludes symbols not listed on NYSE/Nasdaq (e.g., OTC-only listings).
- The app computes delisting reason, expected date, and risk score from each stock's `signals` values and inferred filing text, including more specific explanations such as minimum bid price below $1.00, overdue 10-K/10-Q filings, equity deficiency, and public-float issues when that language appears in the filing.
- It then polls Yahoo Finance market data for tracked symbols and updates price, market cap, volume, 30-day average price, 30-day average market cap, reverse split status, filing-current status, and quote timestamp automatically every 60 seconds.
- The SEC scan + dataset refresh runs every 15 minutes so newly filed candidates can appear automatically.

## Data model

- Candidate universe is discovered dynamically from SEC filing search results (no static stock seed).
- The dashboard computes:
  - `delistReason`
  - `expectedDelistingDate`
  - `delistingChance`
- Values are rule-based and include rationale in the details panel.

## PR recovery on GitHub (no command line)

If a pull request shows **"invalid branch"** after accidental deletion, you can recover from the GitHub UI:

1. Open the old PR and click **Restore branch** (if available).
2. If restore is unavailable, go to **Pull requests → New pull request** and create a fresh PR from your latest branch into `main`.
3. Add a note in the PR body that it replaces the broken PR so reviewers can continue quickly.
