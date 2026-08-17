export const SHOPIFY_IMAGE_CSV_COLUMNS = [
  "Handle",
  "Title",
  "Option1 Name",
  "Option1 Value",
  "Option2 Name",
  "Option2 Value",
  "Option3 Name",
  "Option3 Value",
  "Variant SKU",
  "Image Src",
  "Image Position",
  "Image Alt Text",
  "Variant Image",
];

const VARIANT_IDENTITY_COLUMNS = [
  "Variant ID",
  "Variant SKU",
  "Variant Barcode",
  "Option1 Value",
  "Option2 Value",
  "Option3 Value",
];

export function isShopifyVariantRow(headers, row) {
  return VARIANT_IDENTITY_COLUMNS.some((name) => {
    const index = headers.indexOf(name);
    return index >= 0 && String(row[index] || "").trim();
  });
}

export function projectShopifyImageCsv(headers, rows) {
  const columns = SHOPIFY_IMAGE_CSV_COLUMNS
    .map((name) => ({ name, index: headers.indexOf(name) }))
    .filter(({ index }) => index >= 0);
  const outputHeaders = columns.map(({ name }) => name);
  const variantImageIndex = outputHeaders.indexOf("Variant Image");
  return [
    outputHeaders,
    ...rows.map((row) => {
      const projected = columns.map(({ index }) => row[index] || "");
      // Shopify treats any row containing Variant Image as a variant row. Image-only
      // rows have no option values, so retaining a Variant Image there makes the
      // whole product fail with "exactly one option value" validation errors.
      if (variantImageIndex >= 0 && !isShopifyVariantRow(headers, row)) projected[variantImageIndex] = "";
      return projected;
    }),
  ];
}
