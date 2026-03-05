# Delisting Monitor Dashboard

This repository contains a static web dashboard for monitoring stocks likely to be delisted in the next month.

The seeded dataset now uses real listed companies (instead of placeholder tickers) that have had elevated listing-compliance or distress signals in recent disclosures.

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

## Data model

- Input data lives in `data/stocks.json` and currently contains real company tickers plus illustrative risk fields.
- The dashboard computes:
  - `delistReason`
  - `expectedDelistingDate`
  - `delistingChance`
- Computed values are rule-based and include rationale in the details panel.

This keeps objective data in a pipeline-friendly JSON payload while keeping risk scoring transparent.

## PR recovery on GitHub (no command line)

If a pull request shows **"invalid branch"** after accidental deletion, you can recover from the GitHub UI:

1. Open the old PR and click **Restore branch** (if available).
2. If restore is unavailable, go to **Pull requests → New pull request** and create a fresh PR from your latest branch into `main`.
3. Add a note in the PR body that it replaces the broken PR so reviewers can continue quickly.

