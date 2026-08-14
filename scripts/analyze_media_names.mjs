import fs from "node:fs";
import { cleanFilename, detectMetal, normalize, parseProductCode } from "../static/matching.js";

const path = process.argv[2];
const productPath = process.argv[3];
if (!path) throw new Error("Pass a media-library CSV path.");

function parseCsv(text) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (char !== "\r") field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const table = parseCsv(fs.readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
const nameIndex = table[0].indexOf("Name");
if (nameIndex < 0) throw new Error('CSV does not contain a "Name" column.');
const names = table.slice(1).map((row) => row[nameIndex]).filter(Boolean);
const parsed = names.map((name) => ({ name, clean: cleanFilename(name), code: parseProductCode(name), metal: detectMetal(name) }));
const categories = new Map();
for (const item of parsed.filter((item) => item.code)) categories.set(item.code.category, (categories.get(item.code.category) || 0) + 1);
const topCategories = [...categories].sort((a, b) => b[1] - a[1]).slice(0, 30);
const sample = (items, limit = 30) => items.slice(0, limit).map((item) => item.name);

const output = {
  total: names.length,
  structured: parsed.filter((item) => item.code).length,
  unstructured: parsed.filter((item) => !item.code).length,
  cleanedCounters: parsed.filter((item) => item.clean !== item.name.replace(/\.[^.]+$/, "")).length,
  detectedMetals: parsed.filter((item) => item.metal).length,
  topCategories,
  unstructuredSamples: sample(parsed.filter((item) => !item.code), 60),
  counterSamples: sample(parsed.filter((item) => item.clean !== item.name.replace(/\.[^.]+$/, "")), 30),
  metalSamples: parsed.filter((item) => item.metal).slice(0, 30).map((item) => ({ name: item.name, metal: item.metal.code })),
  descriptiveSamples: parsed.filter((item) => item.code && /[\s_-][a-z]{3,}/i.test(item.clean.replace(/^[a-z]+[\s_-]*0*\d+/i, ""))).slice(0, 60).map((item) => ({ name: item.name, code: item.code })),
};

if (productPath) {
  const productTable = parseCsv(fs.readFileSync(productPath, "utf8").replace(/^\uFEFF/, ""));
  const productHeaders = productTable[0];
  const column = (name) => productHeaders.indexOf(name);
  const handleIndex = column("Handle");
  const titleIndex = column("Title");
  const optionColumns = [1, 2, 3].map((number) => ({
    name: column(`Option${number} Name`),
    value: column(`Option${number} Value`),
  }));
  const products = new Map();
  for (const row of productTable.slice(1)) {
    const handle = row[handleIndex];
    if (!handle) continue;
    if (!products.has(handle)) products.set(handle, { handle, title: row[titleIndex] || "", metals: new Set() });
    const product = products.get(handle);
    if (row[titleIndex]) product.title = row[titleIndex];
    for (const option of optionColumns) {
      if (/metal/i.test(row[option.name] || "") && row[option.value]) product.metals.add(normalize(row[option.value]));
    }
  }

  const codeIndex = new Map();
  for (const product of products.values()) {
    const code = parseProductCode(product.handle);
    if (!code) continue;
    const key = `${code.category}|${code.number}`;
    if (!codeIndex.has(key)) codeIndex.set(key, []);
    codeIndex.get(key).push({ ...product, code });
  }

  const evaluated = parsed.map((item) => {
    const key = item.code ? `${item.code.category}|${item.code.number}` : "";
    const candidates = codeIndex.get(key) || [];
    const extraExact = item.code?.extra
      ? candidates.filter((candidate) => candidate.code.extra === item.code.extra)
      : candidates;
    const selected = extraExact.length ? extraExact : candidates;
    const metalMatches = item.metal && selected.length
      ? selected.filter((candidate) => candidate.metals.has(normalize(item.metal.description)) || candidate.metals.has(normalize(item.metal.code)))
      : [];
    return { ...item, candidates, selected, metalMatches };
  });

  const compact = (item) => ({
    name: item.name,
    parsed: item.code,
    metal: item.metal?.code || null,
    handles: item.selected.map((candidate) => candidate.handle),
  });
  output.catalog = {
    productRows: productTable.length - 1,
    uniqueProducts: products.size,
    indexedProducts: [...codeIndex.values()].reduce((sum, values) => sum + values.length, 0),
    uniqueCodeKeys: codeIndex.size,
    matchedByCategoryNumber: evaluated.filter((item) => item.candidates.length).length,
    uniqueAfterExtra: evaluated.filter((item) => item.selected.length === 1).length,
    ambiguousAfterExtra: evaluated.filter((item) => item.selected.length > 1).length,
    noCatalogCodeMatch: evaluated.filter((item) => item.code && !item.candidates.length).length,
    unparsed: evaluated.filter((item) => !item.code).length,
    filenamesWithMetal: evaluated.filter((item) => item.metal).length,
    metalConfirmedOnCandidate: evaluated.filter((item) => item.metal && item.metalMatches.length).length,
    metalMissingOnCandidate: evaluated.filter((item) => item.metal && item.selected.length && !item.metalMatches.length).length,
    ambiguousSamples: evaluated.filter((item) => item.selected.length > 1).slice(0, 50).map(compact),
    noCatalogSamples: evaluated.filter((item) => item.code && !item.candidates.length).slice(0, 80).map(compact),
    unparsedSamples: evaluated.filter((item) => !item.code).slice(0, 80).map(compact),
    metalMissingSamples: evaluated.filter((item) => item.metal && item.selected.length && !item.metalMatches.length).slice(0, 50).map(compact),
  };
}

console.log(JSON.stringify(output, null, 2));
