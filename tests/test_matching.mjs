import assert from "node:assert/strict";
import { parseProductCode, productCodeKey } from "../static/matching.js";

const sclr = parseProductCode("Sclr068A.jpg");
const clr = parseProductCode("clr06");
assert.equal(sclr.category, "SCLR");
assert.equal(sclr.number, "68");
assert.notEqual(productCodeKey(sclr), productCodeKey(clr));

assert.equal(productCodeKey(parseProductCode("CLR0006.jpg")), productCodeKey(parseProductCode("CLR06")));
assert.notEqual(productCodeKey(parseProductCode("CLR0006.jpg")), productCodeKey(parseProductCode("CLR060")));

const styled = parseProductCode("SKS6667TP SIL");
assert.deepEqual(styled, { category: "SKS", number: "6667", extra: "tpsil" });

console.log("Structured product-code tests passed.");
