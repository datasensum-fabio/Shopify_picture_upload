import os
from types import SimpleNamespace
from unittest.mock import Mock, patch

import app as application


def client():
    application.app.config.update(TESTING=True, SECRET_KEY="test")
    return application.app.test_client()


def test_health_does_not_require_login():
    response = client().get("/api/health")
    assert response.status_code == 200
    assert response.json["ok"] is True


def test_index_enables_automatic_export_when_blob_is_connected():
    with patch.object(application, "APP_PASSWORD", ""), patch.dict(
        os.environ, {"BLOB_READ_WRITE_TOKEN": "test-token"}
    ):
        response = client().get("/")
    assert response.status_code == 200
    assert b'input type="radio" name="export-mode" value="automatic" checked' in response.data


def test_staged_upload_rejects_oversized_output():
    with patch.object(application, "APP_PASSWORD", ""), patch.object(application, "DEMO_MODE", False):
        response = client().post("/api/staged-uploads", json={"files": [{
            "filename": "photo.jpg", "size": 20 * 1024 * 1024,
        }]})
    assert response.status_code == 400


def test_attach_rejects_non_shopify_product_id():
    with patch.object(application, "APP_PASSWORD", ""), patch.object(application, "DEMO_MODE", False):
        response = client().post("/api/attach-image", json={
            "product_id": "123", "resource_url": "https://example.com/image.jpg",
        })
    assert response.status_code == 400


def test_catalog_returns_shopify_products():
    products = [{"id": "gid://shopify/Product/1", "title": "Example"}]
    with patch.object(application, "APP_PASSWORD", ""), patch.object(application, "DEMO_MODE", False), patch.object(
        application.ShopifyClient, "get_products_page", return_value={
            "products": products, "has_next_page": False, "end_cursor": None,
        }
    ):
        response = client().get("/api/products")
    assert response.status_code == 200
    assert response.json["products"] == products


def test_temporary_image_upload_returns_public_blob_url():
    blob_client = Mock()
    blob_client.put.return_value = SimpleNamespace(url="https://example.public.blob.vercel-storage.com/image.jpg")
    with patch.object(application, "APP_PASSWORD", ""), patch.object(
        application, "blob_client", return_value=blob_client
    ), patch.dict(os.environ, {"BLOB_READ_WRITE_TOKEN": "test-token"}):
        response = client().post(
            "/api/temporary-image?filename=Example%20Photo.png",
            data=b"jpeg-data",
            content_type="image/jpeg",
        )
    assert response.status_code == 200
    assert response.json["url"].startswith("https://")
    pathname = blob_client.put.call_args.args[0]
    assert pathname.startswith("shopify-imports/")
    assert pathname.endswith("-Example-Photo.jpg")


def test_temporary_image_upload_rejects_files_over_relay_limit():
    with patch.object(application, "APP_PASSWORD", ""), patch.object(
        application, "blob_client", return_value=Mock()
    ), patch.dict(os.environ, {"BLOB_READ_WRITE_TOKEN": "test-token"}):
        response = client().post(
            "/api/temporary-image?filename=large.jpg",
            data=b"x" * (application.TEMP_IMAGE_MAX_BYTES + 1),
            content_type="image/jpeg",
        )
    assert response.status_code == 413


def test_cleanup_deletes_only_expired_temporary_images():
    expired = "https://example.public.blob.vercel-storage.com/expired.jpg"
    future = "https://example.public.blob.vercel-storage.com/future.jpg"
    listing = {
        "blobs": [
            {"pathname": "shopify-imports/999/expired.jpg", "url": expired},
            {"pathname": "shopify-imports/2001/future.jpg", "url": future},
        ],
        "has_more": False,
        "cursor": None,
    }
    delete = Mock()
    with patch.object(application, "CRON_SECRET", "cron-secret"), patch.object(
        application, "blob_list_objects", return_value=listing
    ), patch.object(
        application, "blob_delete", delete
    ), patch.object(application.time, "time", return_value=1000), patch.dict(
        os.environ, {"BLOB_READ_WRITE_TOKEN": "test-token"}
    ):
        response = client().get(
            "/api/cleanup-temporary-images",
            headers={"Authorization": "Bearer cron-secret"},
        )
    assert response.status_code == 200
    assert response.json["deleted"] == 1
    delete.assert_called_once_with([expired])
