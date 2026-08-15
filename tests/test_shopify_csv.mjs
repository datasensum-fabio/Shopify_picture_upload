import assert from "node:assert/strict";
import { projectShopifyImageCsv, SHOPIFY_IMAGE_CSV_COLUMNS } from "../static/shopify-csv.js";

const headers = [
  "Handle", "Title", "Vendor", "Option1 Name", "Option1 Value", "Variant SKU",
  "Variant Price", "Image Src", "Image Position", "Image Alt Text", "Variant Image", "Status",
];
const row = [
  "cc196", "CC196", "ComIreland", "Metal", "9CT YELLOW GOLD", "CC196 Y9",
  "489.10", "https://example.com/cc196.jpg", "1", "CC196", "https://example.com/cc196.jpg", "active",
];

const output = projectShopifyImageCsv(headers, [row]);
assert.deepEqual(output[0], SHOPIFY_IMAGE_CSV_COLUMNS.filter((column) => headers.includes(column)));
assert.equal(output[1][output[0].indexOf("Handle")], "cc196");
assert.equal(output[1][output[0].indexOf("Variant SKU")], "CC196 Y9");
assert.equal(output[1][output[0].indexOf("Image Src")], "https://example.com/cc196.jpg");
assert.equal(output[0].includes("Variant Price"), false);
assert.equal(output[0].includes("Vendor"), false);
assert.equal(output[0].includes("Status"), false);

console.log("Minimal Shopify image CSV tests passed.");
