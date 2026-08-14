from unittest.mock import patch

import app as application


def client():
    application.app.config.update(TESTING=True, SECRET_KEY="test")
    return application.app.test_client()


def test_health_does_not_require_login():
    response = client().get("/api/health")
    assert response.status_code == 200
    assert response.json["ok"] is True


def test_staged_upload_rejects_oversized_output():
    with patch.object(application, "APP_PASSWORD", ""):
        response = client().post("/api/staged-uploads", json={"files": [{
            "filename": "photo.jpg", "size": 20 * 1024 * 1024,
        }]})
    assert response.status_code == 400


def test_attach_rejects_non_shopify_product_id():
    with patch.object(application, "APP_PASSWORD", ""):
        response = client().post("/api/attach-image", json={
            "product_id": "123", "resource_url": "https://example.com/image.jpg",
        })
    assert response.status_code == 400


def test_catalog_returns_shopify_products():
    products = [{"id": "gid://shopify/Product/1", "title": "Example"}]
    with patch.object(application, "APP_PASSWORD", ""), patch.object(
        application.ShopifyClient, "get_products_page", return_value={
            "products": products, "has_next_page": False, "end_cursor": None,
        }
    ):
        response = client().get("/api/products")
    assert response.status_code == 200
    assert response.json["products"] == products
