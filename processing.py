from __future__ import annotations

import json
import math
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError
from rapidfuzz import fuzz

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".tif", ".tiff", ".bmp"}
MAX_ENTRIES = 2000
MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024
MAX_DIMENSION = 5000
MAX_MEGAPIXELS = 20
TARGET_BYTES = 18 * 1024 * 1024


def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def safe_extract_images(zip_path: Path, destination: Path) -> list[Path]:
    destination.mkdir(parents=True, exist_ok=True)
    extracted: list[Path] = []
    with zipfile.ZipFile(zip_path) as archive:
        entries = [e for e in archive.infolist() if not e.is_dir()]
        if len(entries) > MAX_ENTRIES:
            raise ValueError(f"ZIP contains more than {MAX_ENTRIES} files.")
        if sum(e.file_size for e in entries) > MAX_UNCOMPRESSED_BYTES:
            raise ValueError("ZIP expands beyond the 2 GB safety limit.")
        for index, entry in enumerate(entries):
            source_name = Path(entry.filename).name
            if not source_name or Path(source_name).suffix.casefold() not in ALLOWED_EXTENSIONS:
                continue
            output = destination / f"{index:04d}_{source_name}"
            with archive.open(entry) as source, output.open("wb") as target:
                shutil.copyfileobj(source, target)
            extracted.append(output)
    if not extracted:
        raise ValueError("The ZIP does not contain supported image files.")
    return extracted


def preprocess_image(source: Path, destination: Path) -> dict[str, Any]:
    try:
        with Image.open(source) as opened:
            image = ImageOps.exif_transpose(opened)
            if getattr(image, "is_animated", False):
                image.seek(0)
            image.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError(f"{source.name} is not a readable image.") from exc

    original_size = source.stat().st_size
    width, height = image.size
    scale = min(1.0, MAX_DIMENSION / width, MAX_DIMENSION / height,
                math.sqrt((MAX_MEGAPIXELS * 1_000_000) / (width * height)))
    if scale < 1:
        image = image.resize((max(1, int(width * scale)), max(1, int(height * scale))), Image.Resampling.LANCZOS)
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, "white")
        background.paste(rgba, mask=rgba.getchannel("A"))
        image = background
    else:
        image = image.convert("RGB")

    destination.parent.mkdir(parents=True, exist_ok=True)
    quality = 90
    while True:
        image.save(destination, "JPEG", quality=quality, optimize=True, progressive=True)
        if destination.stat().st_size <= TARGET_BYTES or quality <= 55:
            break
        quality -= 5
    if destination.stat().st_size > TARGET_BYTES:
        raise ValueError(f"{source.name} could not be reduced below the upload limit.")
    return {
        "width": image.width, "height": image.height,
        "original_bytes": original_size, "processed_bytes": destination.stat().st_size,
    }


def rank_products(filename: str, products: list[dict[str, Any]], limit: int = 5) -> list[dict[str, Any]]:
    stem = Path(filename).stem
    needle = normalize(stem)
    ranked = []
    for product in products:
        candidates: list[tuple[str, str]] = [("title", product.get("title", "")), ("handle", product.get("handle", ""))]
        for variant in product.get("variants", {}).get("nodes", []):
            candidates.extend([("sku", variant.get("sku") or ""), ("barcode", variant.get("barcode") or "")])
        best_score, best_field, best_value = 0.0, "", ""
        for field, value in candidates:
            candidate = normalize(value)
            if not candidate:
                continue
            if needle == candidate:
                score = 100.0
            elif field in {"sku", "barcode"} and (needle.startswith(candidate) or candidate.startswith(needle)):
                score = 96.0
            else:
                score = max(fuzz.WRatio(needle, candidate), fuzz.partial_ratio(needle, candidate))
                if field in {"sku", "barcode"}:
                    score = min(99.0, score + 8)
            if score > best_score:
                best_score, best_field, best_value = score, field, value
        ranked.append({"id": product["id"], "title": product["title"], "handle": product.get("handle", ""),
                       "score": round(best_score, 1), "matched_on": best_field, "matched_value": best_value})
    return sorted(ranked, key=lambda item: item["score"], reverse=True)[:limit]


def save_json(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))

