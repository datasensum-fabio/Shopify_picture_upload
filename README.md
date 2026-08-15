# Shopify Image Matcher

A local-first browser application for matching images from large ZIP archives to
Shopify products. ZIP extraction, fuzzy matching and image conversion happen on
the user's computer. Image bytes go directly from the browser to Shopify and
never pass through Vercel or the Flask service.

Before Shopify API credentials are available, set `DEMO_MODE=1`. The user then
selects a standard Shopify product export CSV in the browser. The app aggregates
the CSV by `Handle` and reads `Title`, `Variant SKU`, and `Variant Barcode` for
matching. The review table explicitly shows each picture name beside its matched
Shopify product handle. Demo-mode uploads are disabled.

## Architecture

1. Flask retrieves product metadata using the server-only Shopify Admin token.
2. The browser reads ZIP/ZIP64 archives incrementally using zip.js.
3. Product handles, titles, SKUs and barcodes are ranked locally.
4. Matches are classified as `auto approved`, `needs review`, or `no match`.
5. Approved images are decoded, oriented, resized and converted to JPEG locally.
6. Flask creates a temporary Shopify staged-upload target.
7. The browser uploads the JPEG directly to that target.
8. Flask attaches the staged resource URL to the selected product.

There is no server-side job directory, ZIP upload or image processing. A small
manifest in browser local storage records selections and completed uploads. To
resume after closing the page, select the same archives again.

### Structured product-code matching

When a picture name begins with letters followed by digits, the letters are the
product category and the digits are the product number. Both must match the
Shopify handle before a product can be suggested. Leading zeros inside the number
are ignored (`CLR0006` matches `CLR06`), but digit values are never truncated
(`CLR0006` does not match `CLR060`). Any remaining text is treated as an optional
extra code and is used to rank products that share the required category and number.

### Metal and variant matching

If a known metal code or description appears at the very end of the picture name,
the matcher selects the Shopify variants with that metal. A separator is optional,
so `SKS6667TPSIL.jpg` and `SKS6667TP SIL.jpg` both detect `SIL`. The CSV importer
reads all three Shopify option name/value pairs plus SKU and barcode. Codes are
matched longest-first so composite metals such as `GF R`, `RYW9`, `SILVER/ROSE`,
and `9CT/SILVER` are not reduced to a shorter code. If the picture specifies a
metal but the selected product has no matching variant, the row requires review.
When live Shopify access is enabled, the uploaded product media is associated with
every matching variant (for example, all sizes sharing the same metal). The UI
shows one representative variant in the product dropdown, but the uploader sends
all matching variant IDs to Shopify in batches of 100.

## Manual Shopify CSV import

The review screen can generate a Shopify-compatible product CSV for the rows set
to **Add** or **Replace**. Shopify product CSV files contain text only, so the ZIP
images must first be uploaded to a public image host such as Shopify Content >
Files or ImageKit. Export that image library as a CSV containing `Name` (or
`Filename`) and `URL` columns, then select it under **Manual Shopify CSV import**.

The generated CSV keeps only the fields required to identify the affected products
and variants and modify their images: `Handle`, `Title`, available option/SKU
columns, `Image Src`, `Image Position`, `Image Alt Text`, and `Variant Image`.
Price, inventory, weight, vendor and other unrelated catalogue fields are omitted.
It retains existing images for **Add** and outputs only the chosen image for
**Replace**. Before importing:

1. Export a fresh Shopify product backup.
2. Confirm every selected image has a unique filename and a public HTTPS URL.
3. Download the generated CSV.
4. In Shopify's product importer, select **Overwrite products with matching handles**.
5. Test one product before importing the full file, especially for **Replace**.

Shopify CSV supports only one featured `Variant Image` per variant. If multiple
new pictures target the same variant, all are retained as product images and the
first is used as that variant's featured image. Direct API upload does not have
this CSV limitation.

### Filename noise

Trailing copy counters separated from the product code are removed before matching,
including ` 1`, ` 2`, ` (1)`, `-1`, and `_1`. Descriptive words such as a product
type, colour, or stone name do not participate in the mandatory category/number
comparison. Optional extra codes are read only when attached directly to the product
number. Metal detection runs after copy-counter cleanup and still requires the metal
to be the final meaningful part of the name.

## Archive limits

- 10 GB per ZIP safety cap; multiple ZIPs can form one job.
- ZIP64 is supported.
- 10,000 total archive entries and 5,000 supported images per job.
- 50 GB maximum expanded content per job.
- 250 MB maximum expanded size for one source image.
- Compression ratios above 250:1 are rejected as a ZIP-bomb precaution.
- Processing and upload are sequential to keep memory bounded.

Archives above 2 GB should be processed in desktop Chrome or Edge. The selected
files remain on disk, but the browser must temporarily decode one full image at a
time. JPEG, PNG, WebP, GIF and BMP work in current Chromium browsers. HEIC and
TIFF depend on browser decoder support and are reported as failed when unsupported.

Processed images are limited to 5,000 px on either side, 25 megapixels, and less
than 20 MB for Shopify.

## Shopify setup

Create and install a Shopify custom app with:

- `read_products`
- `write_products`

Copy the example configuration and fill in the permanent `*.myshopify.com`
domain and Admin API token:

```powershell
Copy-Item .env.example .env
```

Set a long random `SECRET_KEY` and an `APP_PASSWORD`. Without `APP_PASSWORD`,
the app deliberately runs without login protection and must only be used locally.

## Run with Docker

Install and start Docker Desktop, then run:

```powershell
docker compose up --build
```

Open <http://localhost:8000>. To stop or run in the background:

```powershell
docker compose down
docker compose up -d --build
```

## Deploy to Vercel

Vercel container deployment uses `Dockerfile.vercel`, which starts Gunicorn on
Vercel's `$PORT`. Import the GitHub repository into Vercel and configure these
Production and Preview environment variables:

- `SHOPIFY_STORE`
- `SHOPIFY_ADMIN_ACCESS_TOKEN`
- `SHOPIFY_API_VERSION`
- `SECRET_KEY`
- `APP_PASSWORD`
- `DEMO_MODE` (`1` for CSV-only testing; change to `0` after adding credentials)
- `CRON_SECRET` (a second long random value used to protect scheduled cleanup)

Redeploy after saving the variables. Direct Shopify uploads do not require
persistent disk.

### Automatic temporary hosting for Shopify CSV imports

The app can host only the selected, browser-processed images and immediately
generate a Shopify import CSV with their public URLs. The ZIP itself is never
uploaded.

1. Open the Vercel project and select **Storage → Create Database → Blob**.
2. Create a **Public** Blob store and connect it to this project for Production
   and Preview. Vercel adds `BLOB_READ_WRITE_TOKEN` automatically.
3. Add `CRON_SECRET` to the same environments with a long random value.
4. Redeploy the project.

The browser reduces each temporary JPEG to at most 4 MB, then sends the selected
images one at a time to the authenticated Flask endpoint. The endpoint stores
them under `shopify-imports/<expiry>/...` in Vercel Blob and returns the public
URLs used by the generated CSV.

`vercel.json` runs `/api/cleanup-temporary-images` once daily. On the free Hobby
plan, files become eligible for deletion after 24 hours and are removed by the
next daily run, so practical retention is approximately 24–48 hours. Import the
CSV into Shopify within 24 hours. The existing public-image-URL CSV workflow
remains available as a fallback.

The frontend imports zip.js as an ES module from jsDelivr. If the deployment
must work without a third-party CDN, download and serve that module from
`static/vendor` instead.

## Run without Docker

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

## Tests

```powershell
pip install pytest
pytest -q
```

Shopify credentials are not required for unit tests.
