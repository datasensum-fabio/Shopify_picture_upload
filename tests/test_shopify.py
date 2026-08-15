from unittest.mock import patch

from shopify import ShopifyClient


def test_attach_product_image_associates_every_matching_variant():
    client = ShopifyClient()
    variant_ids = [f"gid://shopify/ProductVariant/{number}" for number in range(205)]
    responses = [
        {
            "productUpdate": {
                "product": {"media": {"nodes": [{"id": "gid://shopify/MediaImage/9", "alt": "HIRI6 sil"}]}},
                "mediaUserErrors": [],
                "userErrors": [],
            }
        },
        {"productVariantAppendMedia": {"userErrors": []}},
        {"productVariantAppendMedia": {"userErrors": []}},
        {"productVariantAppendMedia": {"userErrors": []}},
    ]

    with patch.object(client, "graphql", side_effect=responses) as graphql:
        client.attach_product_image(
            "gid://shopify/Product/1",
            "https://shopify-staged-uploads.example/image",
            "HIRI6 sil",
            variant_ids,
        )

    appended_variants = [
        item
        for call in graphql.call_args_list[1:]
        for item in call.args[1]["variantMedia"]
    ]
    assert appended_variants == [
        {"variantId": variant_id, "mediaIds": ["gid://shopify/MediaImage/9"]}
        for variant_id in variant_ids
    ]
    assert [len(call.args[1]["variantMedia"]) for call in graphql.call_args_list[1:]] == [100, 100, 5]
