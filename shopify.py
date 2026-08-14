from __future__ import annotations

import os
import time
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
        products: list[dict[str, Any]] = []
        cursor = None
        while True:
            page = self.get_products_page(cursor)
            products.extend(page["products"])
            if not page["has_next_page"]:
                return products
            cursor = page["end_cursor"]

    def get_products_page(self, cursor: str | None = None) -> dict[str, Any]:
        query = """
        query Products($cursor: String) {
          products(first: 50, after: $cursor) {
            nodes {
              id title handle status
              variants(first: 100) { nodes { id title sku barcode selectedOptions { name value } } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
        """
        connection = self.graphql(query, {"cursor": cursor})["products"]
        return {
            "products": connection["nodes"],
            "has_next_page": connection["pageInfo"]["hasNextPage"],
            "end_cursor": connection["pageInfo"]["endCursor"],
        }

    def create_staged_uploads(self, files: list[dict[str, Any]]) -> list[dict[str, Any]]:
        staged_query = """
        mutation Stage($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets { url resourceUrl parameters { name value } }
            userErrors { field message }
          }
        }
        """
        inputs = [{
            "filename": item["filename"],
            "mimeType": item["mime_type"],
            "httpMethod": "POST",
            "resource": "PRODUCT_IMAGE",
        } for item in files]
        staged = self.graphql(staged_query, {"input": inputs})["stagedUploadsCreate"]
        if staged["userErrors"]:
            raise ShopifyError(str(staged["userErrors"]))
        return staged["stagedTargets"]

    def attach_product_image(self, product_id: str, resource_url: str, alt: str, variant_ids: list[str] | None = None) -> None:
        attach_query = """
        mutation Attach($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
          productUpdate(product: $product, media: $media) {
            product { id media(first: 10, reverse: true) { nodes { id alt } } }
            mediaUserErrors { field message }
            userErrors { field message }
          }
        }
        """
        result = self.graphql(attach_query, {
            "product": {"id": product_id},
            "media": [{"alt": alt, "mediaContentType": "IMAGE", "originalSource": resource_url}],
        })["productUpdate"]
        errors = result.get("mediaUserErrors", []) + result.get("userErrors", [])
        if errors:
            raise ShopifyError(str(errors))
        if variant_ids:
            media_nodes = result.get("product", {}).get("media", {}).get("nodes", [])
            media = next((item for item in media_nodes if item.get("alt") == alt), None)
            if not media:
                raise ShopifyError("Shopify created the product image but did not return its media ID for variant association.")
            append_query = """
            mutation AppendVariantMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
              productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
                userErrors { field message }
              }
            }
            """
            appended = self.graphql(append_query, {
                "productId": product_id,
                "variantMedia": [{"variantId": variant_id, "mediaIds": [media["id"]]} for variant_id in variant_ids],
            })["productVariantAppendMedia"]
            if appended.get("userErrors"):
                raise ShopifyError(str(appended["userErrors"]))

