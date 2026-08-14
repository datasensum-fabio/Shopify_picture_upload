from __future__ import annotations

import hmac
import os
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
if os.getenv("VERCEL") and not DEMO_MODE and (not APP_PASSWORD or app.secret_key == "development-only-change-me"):
    raise RuntimeError("Vercel deployments require APP_PASSWORD and a secure SECRET_KEY.")


def api_error(message: str, status: int = 400):
    return jsonify({"error": message}), status


def authenticated() -> bool:
    return not APP_PASSWORD or session.get("authenticated") is True


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
    if not product_id.startswith("gid://shopify/Product/"):
        return api_error("Invalid product ID.")
    if not isinstance(variant_ids, list) or len(variant_ids) > 100 or any(
        not isinstance(variant_id, str) or not variant_id.startswith("gid://shopify/ProductVariant/")
        for variant_id in variant_ids
    ):
        return api_error("Invalid product variant selection.")
    if not resource_url.startswith("https://"):
        return api_error("Invalid staged resource URL.")
    try:
        ShopifyClient().attach_product_image(product_id, resource_url, alt, variant_ids)
    except ShopifyError as exc:
        return api_error(str(exc), 502)
    return jsonify({"ok": True})


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "shopify_configured": ShopifyClient().configured, "demo_mode": DEMO_MODE})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8000")), debug=os.getenv("FLASK_DEBUG") == "1")
