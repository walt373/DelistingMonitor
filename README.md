# Delisting Monitor Dashboard

This repository contains a static web dashboard for monitoring stocks likely to be delisted in the next month.

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

- Input data lives in `data/stocks.json`.
- The dashboard computes:
  - `delistReason`
  - `expectedDelistingDate`
  - `delistingChance`
- Computed values are rule-based and include rationale in the details panel.

This keeps objective data in a pipeline-friendly JSON payload while keeping risk scoring transparent.
