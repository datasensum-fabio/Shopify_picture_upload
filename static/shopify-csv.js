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

export function projectShopifyImageCsv(headers, rows) {
  const columns = SHOPIFY_IMAGE_CSV_COLUMNS
    .map((name) => ({ name, index: headers.indexOf(name) }))
    .filter(({ index }) => index >= 0);
  return [
    columns.map(({ name }) => name),
    ...rows.map((row) => columns.map(({ index }) => row[index] || "")),
  ];
}
