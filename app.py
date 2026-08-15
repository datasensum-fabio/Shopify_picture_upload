from __future__ import annotations

import hmac
import os
import re
import time
import uuid
from functools import wraps
from typing import Any, Callable

from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request, session, url_for

from shopify import ShopifyClient, ShopifyError

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "development-only-change-me")
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.getenv("VERCEL") == "1" or os.getenv("COOKIE_SECURE") == "1",
)
APP_PASSWORD = os.getenv("APP_PASSWORD", "").strip()
DEMO_MODE = os.getenv("DEMO_MODE") == "1" or not os.getenv("SHOPIFY_STORE", "").strip()
CRON_SECRET = os.getenv("CRON_SECRET", "").strip()
TEMP_BLOB_PREFIX = "shopify-imports/"
TEMP_BLOB_TTL_SECONDS = 24 * 60 * 60
TEMP_IMAGE_MAX_BYTES = 4 * 1024 * 1024
if os.getenv("VERCEL") and not DEMO_MODE and (not APP_PASSWORD or app.secret_key == "development-only-change-me"):
    raise RuntimeError("Vercel deployments require APP_PASSWORD and a secure SECRET_KEY.")


def api_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


def authenticated() -> bool:
    return not APP_PASSWORD or session.get("authenticated") is True


def temporary_hosting_configured() -> bool:
    return bool(os.getenv("BLOB_READ_WRITE_TOKEN", "").strip())


def blob_client():
    from vercel.blob import BlobClient

    return BlobClient()


def blob_list_objects(**options: Any):
    from vercel.blob import list_objects

    return list_objects(**options)


def blob_delete(urls: list[str]):
    from vercel.blob import delete

    return delete(urls)


def blob_value(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def require_auth(view: Callable[..., Any]):
    @wraps(view)
    def wrapped(*args: Any, **kwargs: Any):
        if not authenticated():
            return api_error("Authentication required.", 401)
        return view(*args, **kwargs)

    return wrapped


@app.get("/")
def index():
    if not authenticated():
        return render_template("login.html")
    return render_template(
        "index.html",
        configured=ShopifyClient().configured or DEMO_MODE,
        protected=bool(APP_PASSWORD),
        demo_mode=DEMO_MODE,
        temporary_hosting=temporary_hosting_configured(),
        temporary_upload_max_bytes=TEMP_IMAGE_MAX_BYTES,
    )


@app.post("/login")
def login():
    supplied = request.form.get("password", "")
    if APP_PASSWORD and hmac.compare_digest(supplied, APP_PASSWORD):
        session.clear()
        session["authenticated"] = True
        return redirect(url_for("index"))
    return render_template("login.html", error="Incorrect password."), 401


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))


@app.get("/api/products")
@require_auth
def products():
    if DEMO_MODE:
        return api_error("Demo mode uses a Shopify product CSV selected in the browser.", 503)
    client = ShopifyClient()
    cursor = request.args.get("cursor") or None
    try:
        page = client.get_products_page(cursor)
    except ShopifyError as exc:
        return api_error(str(exc), 502)
    return jsonify(page)


@app.get("/api/product-media")
@require_auth
def product_media():
    if DEMO_MODE:
        return api_error("Demo mode uses image URLs from the selected Shopify CSV.", 503)
    product_id = request.args.get("product_id", "")
    if not product_id.startswith("gid://shopify/Product/"):
        return api_error("Invalid product ID.")
    try:
        media = ShopifyClient().get_product_media(product_id)
    except ShopifyError as exc:
        return api_error(str(exc), 502)
    return jsonify({"media": media})


@app.post("/api/staged-uploads")
@require_auth
def staged_uploads():
    if DEMO_MODE:
        return api_error("Uploads are disabled in demo mode. Add Shopify credentials and set DEMO_MODE=0.", 503)
    payload = request.get_json(silent=True) or {}
    files = payload.get("files")
    if not isinstance(files, list) or not 1 <= len(files) <= 25:
        return api_error("Provide between 1 and 25 files.")
    cleaned = []
    for item in files:
        if not isinstance(item, dict):
            return api_error("Invalid file entry.")
        filename = str(item.get("filename", ""))[:180]
        size = item.get("size")
        if not filename or not isinstance(size, int) or size <= 0 or size >= 20 * 1024 * 1024:
            return api_error("Each file requires a valid filename and must be smaller than 20 MB.")
        cleaned.append({"filename": filename, "mime_type": "image/jpeg", "size": size})
    try:
        targets = ShopifyClient().create_staged_uploads(cleaned)
    except ShopifyError as exc:
        return api_error(str(exc), 502)
    return jsonify({"targets": targets})


@app.post("/api/attach-image")
@require_auth
def attach_image():
    if DEMO_MODE:
        return api_error("Uploads are disabled in demo mode.", 503)
    payload = request.get_json(silent=True) or {}
    product_id = str(payload.get("product_id", ""))
    variant_ids = payload.get("variant_ids") or []
    resource_url = str(payload.get("resource_url", ""))
    alt = str(payload.get("alt", ""))[:512]
    mode = str(payload.get("mode", "add"))
    if not product_id.startswith("gid://shopify/Product/"):
        return api_error("Invalid product ID.")
    if not isinstance(variant_ids, list) or len(variant_ids) > 2048 or any(
        not isinstance(variant_id, str) or not variant_id.startswith("gid://shopify/ProductVariant/")
        for variant_id in variant_ids
    ):
        return api_error("Invalid product variant selection.")
    if not resource_url.startswith("https://"):
        return api_error("Invalid staged resource URL.")
    if mode not in {"add", "replace"}:
        return api_error("Invalid upload decision.")
    try:
        client = ShopifyClient()
        if mode == "replace":
            client.replace_product_images(product_id, resource_url, alt, variant_ids)
        else:
            client.attach_product_image(product_id, resource_url, alt, variant_ids)
    except ShopifyError as exc:
        return api_error(str(exc), 502)
    return jsonify({"ok": True})


@app.post("/api/temporary-image")
@require_auth
def temporary_image():
    if not temporary_hosting_configured():
        return api_error("Temporary image hosting is not configured. Connect a public Vercel Blob store first.", 503)
    content_length = request.content_length or 0
    if content_length > TEMP_IMAGE_MAX_BYTES:
        return api_error("The processed image must be no larger than 4 MB.", 413)
    if request.mimetype != "image/jpeg":
        return api_error("Temporary Shopify images must be JPEG files.")
    image = request.stream.read(TEMP_IMAGE_MAX_BYTES + 1)
    if not image:
        return api_error("The image is empty.")
    if len(image) > TEMP_IMAGE_MAX_BYTES:
        return api_error("The processed image must be no larger than 4 MB.", 413)

    supplied_name = request.args.get("filename", "image.jpg")
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", supplied_name.rsplit(".", 1)[0]).strip("-")[:120] or "image"
    expires_at = int(time.time()) + TEMP_BLOB_TTL_SECONDS
    pathname = f"{TEMP_BLOB_PREFIX}{expires_at}/{uuid.uuid4().hex}-{stem}.jpg"
    try:
        blob = blob_client().put(
            pathname,
            image,
            access="public",
            content_type="image/jpeg",
            cache_control_max_age=TEMP_BLOB_TTL_SECONDS,
        )
    except Exception:
        app.logger.exception("Temporary image upload failed")
        return api_error("Temporary image hosting failed. Check the Vercel Blob configuration.", 502)
    url = blob_value(blob, "url", "")
    if not isinstance(url, str) or not url.startswith("https://"):
        return api_error("Temporary image hosting did not return a public URL.", 502)
    return jsonify({"url": url, "expires_at": expires_at})


@app.get("/api/cleanup-temporary-images")
def cleanup_temporary_images():
    supplied = request.headers.get("Authorization", "")
    expected = f"Bearer {CRON_SECRET}" if CRON_SECRET else ""
    if not expected or not hmac.compare_digest(supplied, expected):
        return api_error("Unauthorized.", 401)
    if not temporary_hosting_configured():
        return api_error("Temporary image hosting is not configured.", 503)

    now = int(time.time())
    cursor = None
    scanned = 0
    deleted = 0
    expired_urls = []
    for _ in range(20):
        page = blob_list_objects(prefix=TEMP_BLOB_PREFIX, cursor=cursor, limit=1000)
        blobs = blob_value(page, "blobs", []) or []
        scanned += len(blobs)
        for blob in blobs:
            pathname = str(blob_value(blob, "pathname", ""))
            relative = pathname.removeprefix(TEMP_BLOB_PREFIX)
            expiry_text = relative.split("/", 1)[0]
            if expiry_text.isdigit() and int(expiry_text) <= now:
                url = blob_value(blob, "url", "")
                if url:
                    expired_urls.append(url)
        if len(expired_urls) >= 100:
            deleted += len(expired_urls)
            blob_delete(expired_urls)
            expired_urls.clear()
        if not blob_value(page, "has_more", False):
            cursor = None
            break
        cursor = blob_value(page, "cursor")
        if not cursor:
            break
    if expired_urls:
        deleted += len(expired_urls)
        blob_delete(expired_urls)
    return jsonify({"ok": True, "scanned": scanned, "deleted": deleted, "has_more": bool(cursor)})


@app.get("/api/health")
def health():
    return jsonify({
        "ok": True,
        "shopify_configured": ShopifyClient().configured,
        "demo_mode": DEMO_MODE,
        "temporary_hosting_configured": temporary_hosting_configured(),
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8000")), debug=os.getenv("FLASK_DEBUG") == "1")
