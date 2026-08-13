from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

import requests


class ShopifyError(RuntimeError):
    pass


class ShopifyClient:
    def __init__(self) -> None:
        store = os.getenv("SHOPIFY_STORE", "").strip().lower()
        store = store.removeprefix("https://").removeprefix("http://").rstrip("/")
        if store and not store.endswith(".myshopify.com"):
            store += ".myshopify.com"
        self.store = store
        self.token = os.getenv("SHOPIFY_ADMIN_ACCESS_TOKEN", "").strip()
        self.version = os.getenv("SHOPIFY_API_VERSION", "2026-07")
        self.session = requests.Session()

    @property
    def configured(self) -> bool:
        return bool(self.store and self.token)

    def graphql(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.configured:
            raise ShopifyError("Shopify is not configured. Add SHOPIFY_STORE and SHOPIFY_ADMIN_ACCESS_TOKEN.")
        url = f"https://{self.store}/admin/api/{self.version}/graphql.json"
        response = self.session.post(
            url,
            headers={"X-Shopify-Access-Token": self.token, "Content-Type": "application/json"},
            json={"query": query, "variables": variables or {}},
            timeout=60,
        )
        if response.status_code == 429:
            time.sleep(float(response.headers.get("Retry-After", "2")))
            return self.graphql(query, variables)
        try:
            payload = response.json()
        except ValueError as exc:
            raise ShopifyError(f"Shopify returned HTTP {response.status_code}.") from exc
        if not response.ok:
            raise ShopifyError(payload.get("errors", payload))
        if payload.get("errors"):
            raise ShopifyError(str(payload["errors"]))
        return payload["data"]

    def get_products(self) -> list[dict[str, Any]]:
        query = """
        query Products($cursor: String) {
          products(first: 100, after: $cursor) {
            nodes {
              id title handle status
              variants(first: 100) { nodes { id title sku barcode } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
        """
        products: list[dict[str, Any]] = []
        cursor = None
        while True:
            connection = self.graphql(query, {"cursor": cursor})["products"]
            products.extend(connection["nodes"])
            if not connection["pageInfo"]["hasNextPage"]:
                return products
            cursor = connection["pageInfo"]["endCursor"]

    def upload_product_image(self, product_id: str, image_path: Path, alt: str) -> None:
        staged_query = """
        mutation Stage($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets { url resourceUrl parameters { name value } }
            userErrors { field message }
          }
        }
        """
        staged = self.graphql(staged_query, {"input": [{
            "filename": image_path.name,
            "mimeType": "image/jpeg",
            "httpMethod": "POST",
            "resource": "PRODUCT_IMAGE",
        }]})["stagedUploadsCreate"]
        if staged["userErrors"]:
            raise ShopifyError(str(staged["userErrors"]))
        target = staged["stagedTargets"][0]
        fields = {item["name"]: item["value"] for item in target["parameters"]}
        with image_path.open("rb") as image_file:
            response = self.session.post(
                target["url"], data=fields,
                files={"file": (image_path.name, image_file, "image/jpeg")}, timeout=120,
            )
        response.raise_for_status()

        # productUpdate is the supported replacement for deprecated productCreateMedia.
        attach_query = """
        mutation Attach($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
          productUpdate(product: $product, media: $media) {
            product { id }
            mediaUserErrors { field message }
            userErrors { field message }
          }
        }
        """
        result = self.graphql(attach_query, {
            "product": {"id": product_id},
            "media": [{"alt": alt, "mediaContentType": "IMAGE", "originalSource": target["resourceUrl"]}],
        })["productUpdate"]
        errors = result.get("mediaUserErrors", []) + result.get("userErrors", [])
        if errors:
            raise ShopifyError(str(errors))

