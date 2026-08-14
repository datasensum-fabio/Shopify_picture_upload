import assert from "node:assert/strict";
import { detectMetal, parseProductCode, productCodeKey } from "../static/matching.js";

const sclr = parseProductCode("Sclr068A.jpg");
const clr = parseProductCode("clr06");
assert.equal(sclr.category, "SCLR");
assert.equal(sclr.number, "68");
assert.notEqual(productCodeKey(sclr), productCodeKey(clr));

assert.equal(productCodeKey(parseProductCode("CLR0006.jpg")), productCodeKey(parseProductCode("CLR06")));
assert.notEqual(productCodeKey(parseProductCode("CLR0006.jpg")), productCodeKey(parseProductCode("CLR060")));

const styled = parseProductCode("SKS6667TP SIL");
assert.deepEqual(styled, { category: "SKS", number: "6667", extra: "tpsil" });

assert.equal(detectMetal("SKS6667TP SIL.jpg").code, "SIL");
assert.equal(detectMetal("SKS6667TPSIL.jpg").code, "SIL");
assert.equal(detectMetal("ABC123 GF R.png").code, "GF R");
assert.equal(detectMetal("ABC123GFR.png").code, "GF R");
assert.equal(detectMetal("ABC123 SILVER/ROSE.jpg").code, "SILVER/ROSE");
assert.equal(detectMetal("ABC123 RYW9.jpg").code, "RYW9");
assert.equal(detectMetal("ABC123 YW9.jpg").code, "YW9");

console.log("Structured product-code tests passed.");
