# Delisting Monitor Dashboard

This repository contains a static web dashboard for monitoring stocks likely to be delisted in the next month.

The dashboard no longer ships with seeded stocks; it discovers candidates from recent SEC filings at runtime.

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

- On page load, the app shows `Loading stocks...` and queries recent SEC filings to discover likely delisting candidates.
- Candidates are ranked from filing matches (e.g., listing deficiencies, minimum bid warnings, Form 25 withdrawal filings) and then displayed in the dashboard.
- Yahoo Finance quotes are polled every 60 seconds to refresh price, market cap, and volume.
- SEC scan is repeated every 15 minutes to keep the candidate list fresh.

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

