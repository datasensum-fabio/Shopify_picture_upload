from pathlib import Path

from PIL import Image

from processing import normalize, preprocess_image, rank_products


def test_normalize_product_code():
    assert normalize("SCBR028 B.jpg") == "scbr028bjpg"


def test_exact_sku_wins():
    products = [
        {"id": "1", "title": "Unrelated", "handle": "unrelated", "variants": {"nodes": [{"sku": "CP115", "barcode": ""}]}},
        {"id": "2", "title": "CP 115 lookalike", "handle": "cp-115-lookalike", "variants": {"nodes": []}},
    ]
    result = rank_products("Cp115.jpg", products)
    assert result[0]["id"] == "1"
    assert result[0]["score"] == 100
    assert result[0]["matched_on"] == "sku"


def test_preprocess_resizes_and_converts(tmp_path: Path):
    source = tmp_path / "large.png"
    output = tmp_path / "out.jpg"
    Image.new("RGBA", (6000, 4000), (255, 0, 0, 128)).save(source)
    details = preprocess_image(source, output)
    assert output.exists()
    assert details["width"] * details["height"] <= 20_000_000
    with Image.open(output) as image:
        assert image.format == "JPEG"
        assert image.mode == "RGB"

