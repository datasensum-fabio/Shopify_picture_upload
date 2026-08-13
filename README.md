# Shopify Image Matcher

A browser-based application that accepts a ZIP of product pictures, preprocesses every image, fuzzy-matches filenames to Shopify products, lets a human review the suggestions, and uploads approved images through Shopify's Admin GraphQL API.

## What it does

- Reads ZIP archives safely (no path traversal, entry-count and expanded-size limits).
- Converts supported images to optimized progressive JPEG, applies EXIF orientation, flattens transparency onto white, and limits output to 5,000 px per side, 20 MP, and under 18 MB.
- Scores product title, handle, variant SKU, and barcode. Exact SKU/barcode matches get priority.
- Auto-selects only suggestions above a configurable confidence threshold; every choice remains reviewable.
- Uses Shopify staged uploads and `productUpdate`, with retry support for rate limiting.
- Keeps the Admin API token on the server.

## Shopify setup

Create a custom app in Shopify Admin and grant at least:

- `read_products`
- `write_products`

Install the app, copy its Admin API access token, then configure this application:

```powershell
Copy-Item .env.example .env
```

Edit `.env`. Use the permanent `*.myshopify.com` domain, not the storefront's custom domain. The default API version is `2026-07`; change it as Shopify versions evolve.

## Run with Docker

```powershell
docker compose up --build
```

Open <http://localhost:8000>.

## Run with Python

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

## Workflow

1. Upload a `.zip` in the browser.
2. The server fetches the current Shopify catalog and preprocesses the archive.
3. Review the five best suggestions for each image. Uncertain rows default to **Skip**.
4. Click **Upload approved images**. Failed rows remain retryable; successful rows are locked.

Job artifacts live under `data/` and are excluded from Git. Delete old job directories according to your retention policy. For public deployment, put the service behind HTTPS and add your organization's authentication layer.

## Tests

```powershell
pytest -q
```

The app does not need Shopify credentials for the unit tests.
