# Delisting Monitor Dashboard

This repository contains a static web dashboard for monitoring stocks likely to be delisted in the next month.

The seeded dataset uses active listed companies and avoids retired/delisted symbols so live quote refresh can resolve correctly.

## Run locally

```bash
python3 -m http.server 4173
```

Open: <http://localhost:4173/index.html>

## Host on GitHub Pages

1. Push this repository to GitHub.
2. Go to **Settings → Pages**.
3. Set **Source** to **Deploy from a branch**.
4. Select branch `main` and folder `/ (root)`.
5. Save and wait for deployment.

## Live auto-refresh behavior

- On page load, the app fetches `data/stocks.json` and computes delisting reason, expected date, and risk score from each stock's `signals` values.
- It then polls Yahoo Finance quote data for the tracked symbols and updates price, market cap, volume, and quote timestamp automatically every 60 seconds.
- The local dataset is also re-fetched every 3 minutes so any JSON changes appear without reloading the page.

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

