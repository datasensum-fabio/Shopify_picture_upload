from __future__ import annotations

import os
import shutil
import uuid
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, flash, redirect, render_template, request, url_for
from werkzeug.utils import secure_filename

from processing import load_json, preprocess_image, rank_products, safe_extract_images, save_json
from shopify import ShopifyClient, ShopifyError

load_dotenv()
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "development-only-change-me")
app.config["MAX_CONTENT_LENGTH"] = int(os.getenv("MAX_ZIP_MB", "500")) * 1024 * 1024
MATCH_THRESHOLD = float(os.getenv("MATCH_THRESHOLD", "72"))


@app.get("/")
def index():
    return render_template("index.html", configured=ShopifyClient().configured)


@app.post("/jobs")
def create_job():
    upload = request.files.get("archive")
    if not upload or not upload.filename or Path(upload.filename).suffix.casefold() != ".zip":
        flash("Choose a ZIP archive.", "error")
        return redirect(url_for("index"))
    client = ShopifyClient()
    if not client.configured:
        flash("Configure the Shopify store and access token first.", "error")
        return redirect(url_for("index"))
    job_id = uuid.uuid4().hex
    job_dir = DATA_DIR / job_id
    originals, processed = job_dir / "originals", job_dir / "processed"
    job_dir.mkdir()
    zip_path = job_dir / secure_filename(upload.filename)
    upload.save(zip_path)
    try:
        products = client.get_products()
        images = safe_extract_images(zip_path, originals)
        rows = []
        for index, source in enumerate(images):
            output = processed / f"{index:04d}_{Path(source.name).stem}.jpg"
            try:
                details = preprocess_image(source, output)
                suggestions = rank_products(source.name.split("_", 1)[-1], products)
                top = suggestions[0] if suggestions else None
                rows.append({
                    "id": index, "filename": source.name.split("_", 1)[-1], "path": output.name,
                    "status": "ready", "error": "", "details": details, "suggestions": suggestions,
                    "selected_product_id": top["id"] if top and top["score"] >= MATCH_THRESHOLD else "",
                })
            except ValueError as exc:
                rows.append({"id": index, "filename": source.name, "status": "invalid", "error": str(exc),
                             "details": {}, "suggestions": [], "selected_product_id": ""})
        save_json(job_dir / "job.json", {"id": job_id, "rows": rows})
    except (ValueError, ShopifyError) as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        flash(str(exc), "error")
        return redirect(url_for("index"))
    finally:
        zip_path.unlink(missing_ok=True)
    return redirect(url_for("review_job", job_id=job_id))


@app.get("/jobs/<job_id>")
def review_job(job_id: str):
    job_path = DATA_DIR / job_id / "job.json"
    if not job_path.exists():
        return "Job not found", 404
    return render_template("review.html", job=load_json(job_path))


@app.post("/jobs/<job_id>/upload")
def upload_job(job_id: str):
    job_dir = DATA_DIR / job_id
    job_path = job_dir / "job.json"
    if not job_path.exists():
        return "Job not found", 404
    job = load_json(job_path)
    client = ShopifyClient()
    uploaded = failed = 0
    for row in job["rows"]:
        product_id = request.form.get(f"product_{row['id']}", "").strip()
        row["selected_product_id"] = product_id
        if row["status"] not in {"ready", "failed"} or not product_id:
            continue
        try:
            client.upload_product_image(product_id, job_dir / "processed" / row["path"], Path(row["filename"]).stem)
            row["status"], row["error"] = "uploaded", ""
            uploaded += 1
        except (ShopifyError, OSError) as exc:
            row["status"], row["error"] = "failed", str(exc)
            failed += 1
    save_json(job_path, job)
    flash(f"Uploaded {uploaded} image(s); {failed} failed.", "success" if not failed else "error")
    return redirect(url_for("review_job", job_id=job_id))


@app.errorhandler(413)
def too_large(_error):
    return render_template("index.html", configured=ShopifyClient().configured,
                           upload_error="The ZIP exceeds the configured upload limit."), 413


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)

