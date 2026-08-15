import assert from "node:assert/strict";
import { cleanFilename, detectMetal, detectMetalInValues, parseProductCode, productCodeKey, sha256Hex, visualFingerprintsMatch } from "../static/matching.js";

const sclr = parseProductCode("Sclr068A.jpg");
const clr = parseProductCode("clr06");
assert.equal(sclr.category, "SCLR");
assert.equal(sclr.number, "68");
assert.notEqual(productCodeKey(sclr), productCodeKey(clr));

assert.equal(productCodeKey(parseProductCode("CLR0006.jpg")), productCodeKey(parseProductCode("CLR06")));
assert.notEqual(productCodeKey(parseProductCode("CLR0006.jpg")), productCodeKey(parseProductCode("CLR060")));

const styled = parseProductCode("SKS6667TP SIL");
assert.deepEqual(styled, { category: "SKS", number: "6667", extra: "tp" });

assert.equal(detectMetal("SKS6667TP SIL.jpg").code, "SIL");
assert.equal(detectMetal("SKS6667TPSIL.jpg").code, "SIL");
assert.equal(detectMetal("ABC123 GF R.png").code, "GF R");
assert.equal(detectMetal("ABC123GFR.png").code, "GF R");
assert.equal(detectMetal("ABC123 SILVER/ROSE.jpg").code, "SILVER/ROSE");
assert.equal(detectMetal("ABC123 RYW9.jpg").code, "RYW9");
assert.equal(detectMetal("ABC123 YW9.jpg").code, "YW9");

assert.equal(cleanFilename("CLR0006 bracelet 1.jpg"), "CLR0006 bracelet");
assert.equal(cleanFilename("CLR0006 Blue (1).jpg"), "CLR0006 Blue");
assert.equal(cleanFilename("CLR0006 Ruby-2.jpg"), "CLR0006 Ruby");
assert.equal(cleanFilename("CLR0006_1.jpg"), "CLR0006");
assert.equal(productCodeKey(parseProductCode("CLR0006 bracelet (1).jpg")), productCodeKey(parseProductCode("CLR06")));
assert.equal(parseProductCode("SKS6667TP bracelet SIL 2.jpg").extra, "tp");
assert.equal(parseProductCode("SKS6667TPSIL-1.jpg").extra, "tp");
assert.equal(parseProductCode("CP004YW9.jpg").extra, "");
assert.equal(parseProductCode("CLR012R9.jpg").extra, "");
assert.equal(parseProductCode("KS6076Y9.jpg").extra, "");
assert.equal(detectMetal("SKS6667TP SIL (1).jpg").code, "SIL");
assert.equal(detectMetal("Dp001Dia W9 sub2.jpg").code, "W9");
assert.equal(parseProductCode("Dp001Dia W9 sub2.jpg").extra, "dia");
assert.equal(detectMetal("SILVER bracelet.jpg"), null);
assert.equal(detectMetalInValues(["J - 4.5 - 50", "9CT WHITE GOLD", "'3059"]).code, "W9");
assert.equal(await sha256Hex(new Blob(["same image bytes"])), await sha256Hex(new Blob(["same image bytes"])));
assert.notEqual(await sha256Hex(new Blob(["same image bytes"])), await sha256Hex(new Blob(["different image bytes"])));
assert.equal(visualFingerprintsMatch({ pixels: [10, 20, 30], hash: [0, 1] }, { pixels: [12, 22, 32], hash: [0, 1] }), true);
assert.equal(visualFingerprintsMatch({ pixels: [10, 20, 30], hash: [0, 1] }, { pixels: [40, 50, 60], hash: [1, 0] }), false);
assert.equal(visualFingerprintsMatch(
  { pixels: [10, 20, 30], hash: [0, 0, 0, 0, 0, 0, 0, 0] },
  { pixels: [10, 20, 30], hash: [1, 1, 1, 1, 0, 0, 0, 0] },
), true);
assert.equal(visualFingerprintsMatch(
  { pixels: [10, 20, 30], hash: [0, 0, 0, 0, 0, 0, 0, 0] },
  { pixels: [10, 20, 30], hash: [1, 1, 1, 1, 1, 0, 0, 0] },
), false);

console.log("Structured product-code tests passed.");
