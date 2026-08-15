import { BlobReader, BlobWriter, ZipReader } from "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.8.2/+esm";
import { detectMetal, detectMetalInValues, filenameKeys, normalize, parseProductCode, productCodeKey, sha256Hex, similarity, visualFingerprintsMatch } from "./matching.js";

const MAX_ARCHIVE_BYTES = 10 * 1024 ** 3;
const MAX_ENTRIES = 10_000;
const MAX_IMAGES = 5_000;
const MAX_EXPANDED_BYTES = 50 * 1024 ** 3;
const MAX_ENTRY_BYTES = 250 * 1024 ** 2;
const MAX_RATIO = 250;
const MAX_OUTPUT_BYTES = 19 * 1024 ** 2;
const MAX_DIMENSION = 5000;
const MAX_PIXELS = 25_000_000;
const AUTO_SCORE = 90;
const REVIEW_SCORE = 60;
const MIN_GAP = 8;
const ALLOWED = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic)$/i;
const DEMO_MODE = Boolean(window.APP_CONFIG?.demoMode);

const IMAGE_MIME_TYPES = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", heic: "image/heic",
};
const FINGERPRINT_SIZE = 32;
const PERCEPTUAL_HASH_SIZE = 8;
const PERCEPTUAL_COSINES = Array.from({ length: PERCEPTUAL_HASH_SIZE }, (_, frequency) =>
  Array.from({ length: FINGERPRINT_SIZE }, (_, position) =>
    Math.cos((2 * position + 1) * frequency * Math.PI / (2 * FINGERPRINT_SIZE))));

const $ = (selector) => document.querySelector(selector);
const state = {
  files: [], catalogFile: null, catalogHeaders: [], catalogRecords: [], catalogColumns: {},
  publicImageUrls: new Map(), readers: [], products: [], exactIndex: new Map(), codeIndex: new Map(),
  mediaFingerprints: new Map(), rows: [], running: false, filter: "all",
};

function rankProducts(filename) {
  const needles = filenameKeys(filename);
  const pictureCode = parseProductCode(filename);
  if (pictureCode) {
    const structured = state.codeIndex.get(productCodeKey(pictureCode)) || [];
    return decorateSuggestions(structured.map((product) => {
      const productCode = parseProductCode(product.handle);
      const textScore = Math.max(...needles.map((needle) => similarity(needle, normalize(product.handle))));
      let score = Math.max(80, textScore);
      if (pictureCode.extra === productCode.extra) score = Math.max(score, pictureCode.extra ? 100 : 96);
      else if (!pictureCode.extra || !productCode.extra) score = Math.max(score, 92);
      return {
        id: product.id, title: product.title, handle: product.handle,
        score: Math.round(score * 10) / 10,
        matched_on: "category + product number",
        matched_value: `${pictureCode.category}${pictureCode.number}`,
      };
    }).sort((a, b) => b.score - a.score).slice(0, 5), filename);
  }
  const exact = new Map();
  for (const needle of needles) {
    for (const candidate of state.exactIndex.get(needle) || []) exact.set(candidate.id, candidate);
  }
  if (exact.size) return decorateSuggestions([...exact.values()].sort((a, b) => a.title.localeCompare(b.title)).slice(0, 5), filename);
  return decorateSuggestions(state.products.map((product) => {
    const candidates = [["handle", product.handle || ""], ["title", product.title || ""]];
    let best = { score: 0, matched_on: "", matched_value: "" };
    for (const [field, raw] of candidates) {
      const candidate = normalize(raw);
      for (const needle of needles) {
        let score = similarity(needle, candidate);
        if (needle === candidate) score = 100;
        if (score > best.score) best = { score, matched_on: field, matched_value: raw };
      }
    }
    return { id: product.id, title: product.title, handle: product.handle, ...best, score: Math.round(best.score * 10) / 10 };
  }).sort((a, b) => b.score - a.score).slice(0, 5), filename);
}

function variantMetal(variant) {
  if (variant.metal) return variant.metal;
  return detectMetalInValues([
    ...(variant.selectedOptions || []).map((option) => option.value),
    variant.title,
    variant.sku,
  ]);
}

function decorateSuggestions(suggestions, filename) {
  const pictureMetal = detectMetal(filename);
  return suggestions.map((suggestion) => {
    const product = state.products.find((item) => item.id === suggestion.id);
    const variants = product?.variants?.nodes || [];
    const metalVariants = pictureMetal ? variants.filter((variant) => variantMetal(variant)?.code === pictureMetal.code) : [];
    const availableMetals = [...new Set(variants.map((variant) => variantMetal(variant)?.code).filter(Boolean))];
    return {
      ...suggestion,
      picture_metal: pictureMetal,
      variant_ids: metalVariants.map((variant) => variant.id),
      variant_titles: metalVariants.map((variant) => variant.title || variant.sku || variant.id),
      available_metals: availableMetals,
    };
  });
}

function productChoiceLabel(suggestion, pictureMetal) {
  const product = state.products.find((item) => item.id === suggestion.id);
  const allVariants = product?.variants?.nodes || [];
  const matchingVariants = pictureMetal
    ? allVariants.filter((variant) => variantMetal(variant)?.code === pictureMetal.code)
    : allVariants;
  const representative = matchingVariants[0] || allVariants[0];
  return [
    suggestion.handle,
    variantMetal(representative || {})?.code || "Metal not specified",
    representative?.barcode || "No barcode",
    representative?.sku || "No SKU",
  ].join(" - ");
}

function productImages(product) {
  const csvImages = (product?.imageUrls || []).map((url) => ({ url, alt: "" }));
  const shopifyImages = (product?.media?.nodes || [])
    .filter((media) => media?.image?.url)
    .map((media) => ({ url: media.image.url, alt: media.alt || "" }));
  const unique = new Map([...csvImages, ...shopifyImages].map((image) => [image.url, image]));
  return [...unique.values()];
}

async function ensureProductImages(product) {
  if (!product || DEMO_MODE || product.mediaLoaded) return;
  if (!product.mediaPromise) {
    product.mediaPromise = api(`/api/product-media?product_id=${encodeURIComponent(product.id)}`)
      .then(({ media }) => { product.media = { nodes: media || [] }; product.mediaLoaded = true; })
      .finally(() => { product.mediaPromise = null; });
  }
  await product.mediaPromise;
}

function imageMimeType(filename) {
  return IMAGE_MIME_TYPES[filename.split(".").pop()?.toLowerCase()] || "application/octet-stream";
}

async function decodeImage(blob) {
  try {
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  } catch (bitmapError) {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    try {
      await image.decode();
      return {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => URL.revokeObjectURL(url),
      };
    } catch {
      URL.revokeObjectURL(url);
      throw bitmapError;
    }
  }
}

async function visualFingerprint(blob) {
  const decoded = await decodeImage(blob);
  const size = FINGERPRINT_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  context.fillStyle = "#fff"; context.fillRect(0, 0, size, size);
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
  context.drawImage(decoded.source, 0, 0, size, size);
  decoded.close();
  const rgba = context.getImageData(0, 0, size, size).data;
  canvas.width = canvas.height = 1;
  const pixels = new Uint8Array(size * size * 3);
  for (let source = 0, target = 0; source < rgba.length; source += 4) {
    pixels[target++] = rgba[source]; pixels[target++] = rgba[source + 1]; pixels[target++] = rgba[source + 2];
  }
  const grayAt = (x, y) => {
    const offset = (y * size + x) * 3;
    return 0.299 * pixels[offset] + 0.587 * pixels[offset + 1] + 0.114 * pixels[offset + 2];
  };
  const hash = new Uint8Array(64);
  for (let y = 0; y < 8; y++) {
    const sampleY = Math.round((y + 0.5) * (size - 1) / 8);
    for (let x = 0; x < 8; x++) {
      const left = Math.round(x * (size - 1) / 8);
      const right = Math.round((x + 1) * (size - 1) / 8);
      hash[y * 8 + x] = grayAt(left, sampleY) < grayAt(right, sampleY) ? 1 : 0;
    }
  }
  const grayscale = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) grayscale[y * size + x] = grayAt(x, y);
  const coefficients = new Float64Array(PERCEPTUAL_HASH_SIZE ** 2);
  for (let vertical = 0; vertical < PERCEPTUAL_HASH_SIZE; vertical++) {
    for (let horizontal = 0; horizontal < PERCEPTUAL_HASH_SIZE; horizontal++) {
      let coefficient = 0;
      for (let y = 0; y < size; y++) {
        const verticalCosine = PERCEPTUAL_COSINES[vertical][y];
        for (let x = 0; x < size; x++) {
          coefficient += grayscale[y * size + x] * PERCEPTUAL_COSINES[horizontal][x] * verticalCosine;
        }
      }
      coefficients[vertical * PERCEPTUAL_HASH_SIZE + horizontal] = coefficient;
    }
  }
  const median = [...coefficients.slice(1)].sort((left, right) => left - right)[Math.floor((coefficients.length - 1) / 2)];
  const perceptualHash = new Uint8Array(coefficients.length);
  for (let index = 1; index < coefficients.length; index++) perceptualHash[index] = coefficients[index] > median ? 1 : 0;
  return { pixels, hash, perceptualHash };
}

function shopifyPreviewUrl(url, width = 256) {
  try {
    const sized = new URL(url);
    if (sized.hostname.endsWith("shopify.com")) sized.searchParams.set("width", String(width));
    return sized.toString();
  } catch { return url; }
}

async function localThumbnailUrl(blob) {
  const decoded = await decodeImage(blob);
  const scale = Math.min(1, 140 / decoded.width, 140 / decoded.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(decoded.width * scale));
  canvas.height = Math.max(1, Math.round(decoded.height * scale));
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
  decoded.close();
  const thumbnail = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.75));
  canvas.width = canvas.height = 1;
  return thumbnail ? URL.createObjectURL(thumbnail) : "";
}

async function remoteImageFingerprint(url) {
  if (!state.mediaFingerprints.has(url)) {
    state.mediaFingerprints.set(url, fetch(shopifyPreviewUrl(url), { mode: "cors" })
      .then((response) => {
        if (!response.ok) throw new Error(`Shopify CDN returned ${response.status}`);
        return response.blob();
      })
      .then(visualFingerprint));
  }
  return state.mediaFingerprints.get(url);
}

async function findExistingImage(product, localFingerprint) {
  let compared = 0;
  let lastError = null;
  for (const image of productImages(product)) {
    try {
      const existingFingerprint = await remoteImageFingerprint(image.url);
      compared++;
      if (visualFingerprintsMatch(localFingerprint, existingFingerprint)) return image;
    } catch (error) { lastError = error; }
  }
  if (!compared && lastError) throw lastError;
  return null;
}

function buildCatalogIndex() {
  state.exactIndex = new Map();
  state.codeIndex = new Map();
  for (const product of state.products) {
    const code = parseProductCode(product.handle || "");
    if (code) {
      const codeKey = productCodeKey(code);
      if (!state.codeIndex.has(codeKey)) state.codeIndex.set(codeKey, []);
      state.codeIndex.get(codeKey).push(product);
    }
    const values = [["handle", product.handle || ""], ["title", product.title || ""]];
    for (const variant of product.variants?.nodes || []) values.push(["sku", variant.sku || ""], ["barcode", variant.barcode || ""]);
    for (const [field, value] of values) {
      const key = normalize(value);
      if (!key) continue;
      if (!state.exactIndex.has(key)) state.exactIndex.set(key, []);
      state.exactIndex.get(key).push({ id: product.id, title: product.title, handle: product.handle, score: 100, matched_on: field, matched_value: value });
    }
  }
}

function classify(suggestions, pictureMetal = null) {
  if (!suggestions.length || suggestions[0].score < REVIEW_SCORE) return "no_match";
  if (pictureMetal && !suggestions[0].variant_ids.length) return "needs_review";
  const gap = suggestions[0].score - (suggestions[1]?.score || 0);
  return suggestions[0].score >= AUTO_SCORE && gap >= MIN_GAP ? "auto_approved" : "needs_review";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

async function loadCatalog() {
  const products = [];
  let cursor = null, pageNumber = 0;
  do {
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = await api(`/api/products${suffix}`);
    products.push(...page.products);
    cursor = page.has_next_page ? page.end_cursor : null;
    pageNumber++;
    setWorking("Loading Shopify catalogue", `${products.length.toLocaleString()} products loaded (${pageNumber} page${pageNumber === 1 ? "" : "s"}).`, 2);
  } while (cursor);
  return products;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
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

function publicImageKeys(filename) {
  const basename = String(filename || "").replace(/^.*[\\/]/, "").trim();
  const stem = basename.replace(/\.[^.]+$/, "");
  return [...new Set([`file:${basename.toLowerCase()}`, `stem:${normalize(stem)}`].filter((key) => !key.endsWith(":")))];
}

async function loadPublicImageUrls(file) {
  const records = parseCsv((await file.text()).replace(/^\uFEFF/, ""));
  if (records.length < 2) throw new Error("The public image URL CSV is empty.");
  const headers = records[0].map((value) => value.trim().toLowerCase());
  const findColumn = (...names) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;
  const nameColumn = findColumn("name", "filename", "file name");
  const urlColumn = findColumn("url", "file url", "public url");
  if (nameColumn < 0 || urlColumn < 0) throw new Error('The public image CSV needs "Name" (or "Filename") and "URL" columns.');
  const urls = new Map();
  let validRows = 0;
  for (const values of records.slice(1)) {
    const name = (values[nameColumn] || "").trim();
    const url = (values[urlColumn] || "").trim();
    if (!name || !url.startsWith("https://")) continue;
    validRows++;
    for (const key of publicImageKeys(name)) {
      if (!urls.has(key)) urls.set(key, new Set());
      urls.get(key).add(url);
    }
  }
  if (!validRows) throw new Error("No public HTTPS image URLs were found in that CSV.");
  state.publicImageUrls = urls;
  return validRows;
}

function publicImageUrl(filename) {
  for (const key of publicImageKeys(filename)) {
    const matches = [...(state.publicImageUrls.get(key) || [])];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`${filename} matches multiple public image URLs. Use unique filenames in the image library.`);
  }
  return "";
}

function csvText(rows) {
  return rows.map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function loadCsvCatalog(file) {
  const records = parseCsv((await file.text()).replace(/^\uFEFF/, ""));
  if (records.length < 2) throw new Error("The Shopify CSV is empty.");
  const headers = records[0].map((value) => value.trim());
  const column = (name) => headers.indexOf(name);
  const handleColumn = column("Handle"), titleColumn = column("Title");
  const skuColumn = column("Variant SKU"), barcodeColumn = column("Variant Barcode");
  const variantIdColumn = column("Variant ID");
  const imageColumn = column("Image Src"), variantImageColumn = column("Variant Image");
  const optionColumns = [1, 2, 3].map((number) => ({ name: column(`Option${number} Name`), value: column(`Option${number} Value`) }));
  if (handleColumn < 0 || titleColumn < 0) throw new Error('The product CSV must contain the Shopify columns "Handle" and "Title".');
  state.catalogHeaders = headers;
  state.catalogRecords = records.slice(1).map((values) => {
    const row = [...values];
    while (row.length < headers.length) row.push("");
    return row.slice(0, headers.length);
  });
  state.catalogColumns = {
    handle: handleColumn, title: titleColumn, image: imageColumn,
    imagePosition: column("Image Position"), imageAlt: column("Image Alt Text"), variantImage: variantImageColumn,
  };
  const products = new Map();
  for (const [recordIndex, values] of state.catalogRecords.entries()) {
    const handle = (values[handleColumn] || "").trim();
    if (!handle) continue;
    if (!products.has(handle)) products.set(handle, {
      id: `csv://Product/${encodeURIComponent(handle)}`,
      title: (values[titleColumn] || handle).trim(), handle, status: "ACTIVE", variants: { nodes: [] }, imageUrls: [],
    });
    const product = products.get(handle);
    for (const imageIndex of [imageColumn, variantImageColumn]) {
      const imageUrl = imageIndex >= 0 ? (values[imageIndex] || "").trim() : "";
      if (imageUrl && !product.imageUrls.includes(imageUrl)) product.imageUrls.push(imageUrl);
    }
    const sku = skuColumn >= 0 ? (values[skuColumn] || "").trim() : "";
    const barcode = barcodeColumn >= 0 ? (values[barcodeColumn] || "").trim() : "";
    const selectedOptions = optionColumns.filter((item) => item.name >= 0 && item.value >= 0 && values[item.value]).map((item) => ({
      name: values[item.name] || "Option", value: values[item.value],
    }));
    const metal = detectMetalInValues([...selectedOptions.map((item) => item.value), sku]);
    const variantIndex = product.variants.nodes.length + 1;
    product.variants.nodes.push({
      id: variantIdColumn >= 0 && values[variantIdColumn] ? values[variantIdColumn] : `csv://Variant/${encodeURIComponent(handle)}/${variantIndex}`,
      title: selectedOptions.map((item) => item.value).join(" / ") || sku || `Variant ${variantIndex}`,
      sku, barcode, selectedOptions, metal, csvRecordIndex: recordIndex,
    });
  }
  if (!products.size) throw new Error("No products with handles were found in the Shopify CSV.");
  return [...products.values()];
}

function setWorking(title, detail, progress = 0) {
  $("#working").classList.remove("hidden");
  $("#working-title").textContent = title;
  $("#working-detail").textContent = detail;
  $("#progress").value = progress;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function selectFiles(files) {
  state.files = [...files].filter((file) => file.name.toLowerCase().endsWith(".zip"));
  if (!state.files.length) return;
  const tooLarge = state.files.find((file) => file.size > MAX_ARCHIVE_BYTES);
  if (tooLarge) {
    alert(`${tooLarge.name} exceeds the initial 10 GB safety limit. Split it into independent ZIP archives.`);
    state.files = [];
    return;
  }
  const total = state.files.reduce((sum, file) => sum + file.size, 0);
  $("#file-summary").innerHTML = `<strong>${state.files.length} archive(s)</strong><small>${formatBytes(total)} selected</small>`;
  $("#start-actions").classList.remove("hidden");
}

async function analyse() {
  if (!state.files.length || state.running) return;
  state.running = true;
  $("#analyse").disabled = true;
  try {
    setWorking("Loading Shopify catalogue", state.catalogFile ? "Reading the selected CSV locally." : "Only product metadata is being downloaded.", 2);
    if (DEMO_MODE && !state.catalogFile) throw new Error("Select a Shopify product CSV before analysing the ZIP.");
    state.catalogHeaders = []; state.catalogRecords = []; state.catalogColumns = {};
    state.products = state.catalogFile ? await loadCsvCatalog(state.catalogFile) : await loadCatalog();
    buildCatalogIndex();
    state.mediaFingerprints.clear();
    for (const row of state.rows) if (row.localPreviewUrl) URL.revokeObjectURL(row.localPreviewUrl);
    state.rows = [];
    const seenHashes = new Map();
    let expanded = 0, entryCount = 0;
    for (let fileIndex = 0; fileIndex < state.files.length; fileIndex++) {
      const file = state.files[fileIndex];
      setWorking("Reading archive index", `${file.name} (${formatBytes(file.size)})`, 5 + 35 * fileIndex / state.files.length);
      const reader = new ZipReader(new BlobReader(file), { useWebWorkers: true });
      state.readers.push(reader);
      const entries = await reader.getEntries();
      entryCount += entries.length;
      if (entryCount > MAX_ENTRIES) throw new Error(`The archives contain more than ${MAX_ENTRIES.toLocaleString()} entries.`);
      for (const entry of entries) {
        if (entry.directory || !ALLOWED.test(entry.filename)) continue;
        if (state.rows.length >= MAX_IMAGES) throw new Error(`The job contains more than ${MAX_IMAGES.toLocaleString()} images.`);
        if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`${entry.filename} expands beyond ${formatBytes(MAX_ENTRY_BYTES)}.`);
        expanded += entry.uncompressedSize;
        if (expanded > MAX_EXPANDED_BYTES) throw new Error(`The archives expand beyond ${formatBytes(MAX_EXPANDED_BYTES)}.`);
        if (entry.compressedSize && entry.uncompressedSize / entry.compressedSize > MAX_RATIO) throw new Error(`${entry.filename} has an unsafe compression ratio.`);
        setWorking("Checking image duplicates", `${file.name}: ${entry.filename}`, 40);
        const extractedBlob = await entry.getData(new BlobWriter(imageMimeType(entry.filename)));
        const sourceBlob = extractedBlob.type === imageMimeType(entry.filename)
          ? extractedBlob
          : extractedBlob.slice(0, extractedBlob.size, imageMimeType(entry.filename));
        const imageHash = await sha256Hex(sourceBlob);
        const duplicateOf = seenHashes.get(imageHash) || null;
        if (!duplicateOf) seenHashes.set(imageHash, { archive: file.name, filename: entry.filename.replace(/^.*[\\/]/, "") });
        const suggestions = rankProducts(entry.filename);
        const pictureMetal = detectMetal(entry.filename);
        const matchStatus = classify(suggestions, pictureMetal);
        let existingImage = null;
        let comparisonWarning = "";
        const matchedProduct = suggestions[0] ? state.products.find((product) => product.id === suggestions[0].id) : null;
        if (!duplicateOf && matchedProduct && matchStatus !== "no_match") {
          try {
            await ensureProductImages(matchedProduct);
            const existingProductImages = productImages(matchedProduct);
            if (matchStatus === "auto_approved" && existingProductImages.length) {
              setWorking("Comparing existing Shopify images", `${matchedProduct.handle}: ${entry.filename}`, 55);
              existingImage = await findExistingImage(matchedProduct, await visualFingerprint(sourceBlob));
            } else if (matchStatus === "auto_approved" && DEMO_MODE) {
              comparisonWarning = "No Shopify image URLs were found for this product in the selected CSV.";
            }
          } catch (error) {
            existingImage = null;
            comparisonWarning = `Could not compare this ZIP image with Shopify: ${error.message || "image decoding failed"}`;
          }
        }
        let localPreviewUrl = "";
        try { localPreviewUrl = await localThumbnailUrl(sourceBlob); }
        catch (error) {
          localPreviewUrl = "";
          comparisonWarning = [
            comparisonWarning,
            `Could not decode the ZIP image preview: ${error.message || "unsupported image data"}`,
          ].filter(Boolean).join(" ");
        }
        state.rows.push({
          id: `${fileIndex}:${entry.index ?? state.rows.length}`,
          fileIndex, entry, filename: entry.filename.replace(/^.*[\\/]/, ""),
          archive: file.name, suggestions, matchStatus, imageHash, duplicateOf, isDuplicate: Boolean(duplicateOf), existingImage, isAlreadyOnShopify: Boolean(existingImage), localPreviewUrl,
          selectedId: !duplicateOf && matchStatus === "auto_approved" ? suggestions[0].id : "",
          pictureMetal,
          selectedVariantIds: !duplicateOf && matchStatus === "auto_approved" ? suggestions[0].variant_ids : [],
          uploadStatus: duplicateOf ? "duplicate" : existingImage ? "already_on_shopify" : "pending",
          decision: !duplicateOf && !existingImage && matchStatus === "auto_approved" ? "add" : "do_not_upload",
          error: comparisonWarning,
        });
      }
    }
    if (!state.rows.length) throw new Error("No supported images were found in the selected archives.");
    restoreManifest();
    persistManifest();
    render();
    $("#start-card").classList.add("hidden");
    $("#working").classList.add("hidden");
    $("#review").classList.remove("hidden");
  } catch (error) {
    setWorking("Could not analyse archive", error.message, 0);
    $("#working").classList.add("error-card");
  } finally {
    state.running = false;
    $("#analyse").disabled = false;
  }
}

function render() {
  const tbody = $("#rows");
  tbody.replaceChildren();
  for (const row of state.rows) {
    const effectiveMatchStatus = row.isDuplicate ? "duplicate" : row.isAlreadyOnShopify ? "already_on_shopify" : row.matchStatus;
    if (state.filter !== "all" && effectiveMatchStatus !== state.filter && row.uploadStatus !== state.filter) continue;
    const fragment = $("#row-template").content.cloneNode(true);
    const tr = fragment.querySelector("tr");
    tr.dataset.id = row.id;
    fragment.querySelector(".filename").textContent = row.filename;
    fragment.querySelector(".archive-name").textContent = row.archive;
    if (row.localPreviewUrl) {
      fragment.querySelector(".local-preview").src = row.localPreviewUrl;
      fragment.querySelector(".local-preview-missing").classList.add("hidden");
    } else {
      fragment.querySelector(".local-preview").classList.add("hidden");
    }
    const selectedSuggestion = row.suggestions.find((item) => item.id === row.selectedId) || row.suggestions[0];
    const selectedProduct = state.products.find((product) => product.id === selectedSuggestion?.id);
    const showProductImages = !row.isDuplicate && ["auto_approved", "needs_review"].includes(row.matchStatus);
    if (showProductImages) {
      const images = productImages(selectedProduct);
      const gallery = fragment.querySelector(".shopify-product-gallery");
      if (images.length) {
        fragment.querySelector(".product-images-message").classList.add("hidden");
        for (const [index, image] of images.entries()) {
          const link = document.createElement("a");
          link.href = image.url; link.target = "_blank"; link.rel = "noopener noreferrer";
          const preview = document.createElement("img");
          preview.src = shopifyPreviewUrl(image.url, 180); preview.loading = "lazy";
          preview.alt = image.alt || `Shopify product image ${index + 1}`;
          link.append(preview); gallery.append(link);
        }
      } else if (DEMO_MODE) {
        fragment.querySelector(".product-images-message").textContent = "No image URL in the selected Shopify CSV";
      }
    } else {
      fragment.querySelector(".product-images-message").textContent = row.isDuplicate ? "Duplicate ZIP image" : "No matched product";
    }
    const handle = fragment.querySelector(".product-handle");
    handle.textContent = row.suggestions.find((item) => item.id === row.selectedId)?.handle || row.suggestions[0]?.handle || "—";
    const metalMatch = fragment.querySelector(".metal-match");
    const updateMetalMatch = () => {
      const suggestion = row.suggestions.find((item) => item.id === row.selectedId) || row.suggestions[0];
      row.selectedVariantIds = suggestion?.variant_ids || [];
      if (!row.pictureMetal) metalMatch.textContent = "Not specified in picture name";
      else if (row.selectedVariantIds.length) metalMatch.textContent = `${row.pictureMetal.code} — ${row.selectedVariantIds.length} matching variant${row.selectedVariantIds.length === 1 ? "" : "s"}`;
      else metalMatch.textContent = `${row.pictureMetal.code} — no matching variant`;
    };
    updateMetalMatch();
    const select = fragment.querySelector(".product-select");
    for (const product of row.suggestions) {
      const option = document.createElement("option");
      option.value = product.id;
      option.textContent = productChoiceLabel(product, row.pictureMetal);
      option.selected = product.id === row.selectedId;
      select.append(option);
    }
    select.disabled = row.isDuplicate || row.isAlreadyOnShopify || row.uploadStatus === "uploaded" || state.running;
    select.addEventListener("change", async () => {
      row.selectedId = select.value;
      if (!select.value) row.decision = "do_not_upload";
      if (select.value && row.matchStatus === "no_match") row.matchStatus = "needs_review";
      handle.textContent = row.suggestions.find((item) => item.id === select.value)?.handle || "—";
      updateMetalMatch();
      const product = state.products.find((item) => item.id === select.value);
      if (product) {
        select.disabled = true;
        try { await ensureProductImages(product); }
        catch { row.error = "Could not load this product's Shopify images."; }
      }
      persistManifest(); render();
    });
    const top = row.suggestions[0];
    const score = fragment.querySelector(".score");
    score.textContent = top ? `${top.score}%` : "—";
    score.className = `score ${row.matchStatus}`;
    fragment.querySelector(".matched-on").textContent = top ? `${top.matched_on}: ${top.matched_value}` : "No candidate";
    const badge = fragment.querySelector(".match-status");
    badge.textContent = effectiveMatchStatus.replaceAll("_", " ");
    badge.className = `match-status ${effectiveMatchStatus}`;
    if (["auto_approved", "needs_review"].includes(state.filter)) badge.classList.add("hidden");
    const decision = fragment.querySelector(".upload-decision");
    if (!row.isDuplicate && !row.isAlreadyOnShopify && ["auto_approved", "needs_review"].includes(row.matchStatus)) {
      decision.classList.remove("hidden");
      decision.value = row.selectedId ? row.decision : "do_not_upload";
      decision.querySelector('option[value="add"]').disabled = !row.selectedId;
      decision.querySelector('option[value="replace"]').disabled = !row.selectedId;
      decision.disabled = state.running || row.uploadStatus === "uploaded";
      decision.addEventListener("change", () => {
        row.decision = row.selectedId ? decision.value : "do_not_upload";
        persistManifest(); render();
      });
    }
    fragment.querySelector(".upload-status").textContent = row.isDuplicate
      ? `Same SHA-256 as ${row.duplicateOf.archive} / ${row.duplicateOf.filename}`
      : row.isAlreadyOnShopify
        ? `Visual match already attached${row.existingImage.alt ? `: ${row.existingImage.alt}` : ""}`
      : row.decision === "do_not_upload" ? "Upload stopped by user"
      : row.uploadStatus === "pending" ? "" : row.uploadStatus;
    fragment.querySelector(".row-error").textContent = row.error;
    tbody.append(fragment);
  }
  renderSummary();
}

function renderSummary() {
  const counts = { auto_approved: 0, needs_review: 0, no_match: 0, duplicate: 0, already_on_shopify: 0, uploaded: 0, failed: 0 };
  for (const row of state.rows) {
    if (row.isDuplicate) counts.duplicate++;
    else if (row.isAlreadyOnShopify) counts.already_on_shopify++;
    else counts[row.matchStatus]++;
    if (counts[row.uploadStatus] !== undefined && !["duplicate", "already_on_shopify"].includes(row.uploadStatus)) counts[row.uploadStatus]++;
  }
  $("#summary").innerHTML = `<div><strong>${counts.auto_approved}</strong><small>automatic</small></div><div><strong>${counts.needs_review}</strong><small>review</small></div><div><strong>${counts.no_match}</strong><small>unmatched</small></div><div><strong>${counts.duplicate}</strong><small>duplicates</small></div><div><strong>${counts.already_on_shopify}</strong><small>already on Shopify</small></div><div><strong>${counts.uploaded}</strong><small>uploaded</small></div>`;
  const selected = selectedUploadRows().length;
  $("#upload-count").textContent = `${selected} image${selected === 1 ? "" : "s"} selected`;
  $("#upload").disabled = DEMO_MODE || !selected || state.running;
  $("#download-shopify-csv").disabled = !selected || state.running || !state.catalogRecords.length || !state.publicImageUrls.size;
}

function refreshRow(row) {
  const tr = [...document.querySelectorAll("#rows tr")].find((item) => item.dataset.id === row.id);
  if (tr) {
    tr.querySelector(".upload-status").textContent = row.uploadStatus === "pending" ? "" : row.uploadStatus;
    tr.querySelector(".row-error").textContent = row.error;
  }
  renderSummary();
}

function selectedUploadRows() {
  return state.rows.filter((row) => !row.isDuplicate && !row.isAlreadyOnShopify
    && ["add", "replace"].includes(row.decision) && row.selectedId && row.uploadStatus !== "uploaded");
}

function conflictingReplacement(queue) {
  const byProduct = new Map();
  for (const row of queue) {
    if (!byProduct.has(row.selectedId)) byProduct.set(row.selectedId, []);
    byProduct.get(row.selectedId).push(row);
  }
  return [...byProduct.values()].find((rows) => rows.length > 1 && rows.some((row) => row.decision === "replace")) || null;
}

async function downloadShopifyCsv() {
  if (state.running) return;
  const queue = selectedUploadRows();
  if (!queue.length) return alert("Choose Add or Replace for at least one matched image.");
  if (!state.catalogHeaders.length || !state.catalogRecords.length) return alert("Analyse the ZIP using a fresh Shopify product export before creating an import CSV.");
  if (!state.publicImageUrls.size) return alert("Select a public image URL CSV first.");
  const conflict = conflictingReplacement(queue);
  if (conflict) {
    const handle = conflict[0].suggestions.find((item) => item.id === conflict[0].selectedId)?.handle || "the same product";
    return alert(`${handle} has multiple chosen images and at least one is Replace. Keep one Replace image, or set every image for this product to Add.`);
  }

  const mapped = [];
  const missing = [];
  for (const row of queue) {
    const url = publicImageUrl(row.filename);
    if (!url) missing.push(row.filename);
    mapped.push({ row, url, alt: row.filename.replace(/\.[^.]+$/, "") });
  }
  if (missing.length) {
    return alert(`No public URL was found for ${missing.length} selected image${missing.length === 1 ? "" : "s"}:\n${missing.slice(0, 12).join("\n")}${missing.length > 12 ? "\n…" : ""}\n\nUpload these images to the public image library, export its CSV again, and reselect it here.`);
  }

  const replacements = mapped.filter(({ row }) => row.decision === "replace").length;
  if (replacements && !confirm(`The CSV will contain only the replacement image for ${replacements} product${replacements === 1 ? "" : "s"}. Back up the current Shopify export and test one product before a bulk import. Continue?`)) return;

  const columns = state.catalogColumns;
  if ([columns.handle, columns.title, columns.image, columns.imagePosition, columns.imageAlt].some((index) => index < 0)) {
    return alert('The Shopify product export must contain Handle, Title, Image Src, Image Position, and Image Alt Text columns.');
  }
  const actionsByProduct = new Map();
  for (const action of mapped) {
    if (!actionsByProduct.has(action.row.selectedId)) actionsByProduct.set(action.row.selectedId, []);
    actionsByProduct.get(action.row.selectedId).push(action);
  }

  const output = [state.catalogHeaders];
  let variantImageConflicts = 0;
  for (const [productId, actions] of actionsByProduct) {
    const product = state.products.find((item) => item.id === productId);
    if (!product) continue;
    const sourceEntries = state.catalogRecords
      .map((values, recordIndex) => ({ values, recordIndex }))
      .filter(({ values }) => (values[columns.handle] || "").trim().toLowerCase() === product.handle.toLowerCase());
    if (!sourceEntries.length) throw new Error(`The source Shopify CSV rows for ${product.handle} could not be found.`);
    const productRows = sourceEntries.map(({ values }) => [...values]);
    const localRowByRecordIndex = new Map(sourceEntries.map(({ recordIndex }, index) => [recordIndex, index]));
    const existingImages = productRows.map((values, index) => ({
      url: (values[columns.image] || "").trim(),
      position: Number(values[columns.imagePosition]) || index + 1,
      alt: values[columns.imageAlt] || "",
    })).filter((image) => image.url).sort((left, right) => left.position - right.position);
    const replacing = actions.some(({ row }) => row.decision === "replace");
    const finalImages = replacing ? [] : [...existingImages];
    for (const action of actions) {
      if (!finalImages.some((image) => image.url === action.url)) finalImages.push({ url: action.url, alt: action.alt });
    }
    if (finalImages.length > 250) throw new Error(`${product.handle} would exceed Shopify's limit of 250 product images.`);

    for (const values of productRows) {
      values[columns.image] = ""; values[columns.imagePosition] = ""; values[columns.imageAlt] = "";
      if (replacing && columns.variantImage >= 0) values[columns.variantImage] = "";
    }
    while (productRows.length < finalImages.length) {
      const values = Array(state.catalogHeaders.length).fill("");
      values[columns.handle] = product.handle;
      productRows.push(values);
    }
    finalImages.forEach((image, index) => {
      productRows[index][columns.image] = image.url;
      productRows[index][columns.imagePosition] = String(index + 1);
      productRows[index][columns.imageAlt] = image.alt;
    });

    if (columns.variantImage >= 0) {
      const assigned = new Map();
      for (const action of actions) {
        for (const variantId of action.row.selectedVariantIds) {
          const variant = product.variants.nodes.find((item) => item.id === variantId);
          const localRow = variant ? localRowByRecordIndex.get(variant.csvRecordIndex) : undefined;
          if (localRow === undefined) continue;
          if (assigned.has(variantId) && assigned.get(variantId) !== action.url) variantImageConflicts++;
          if (!assigned.has(variantId)) {
            assigned.set(variantId, action.url);
            productRows[localRow][columns.variantImage] = action.url;
          }
        }
      }
    }
    output.push(...productRows);
  }

  if (variantImageConflicts && !confirm(`${variantImageConflicts} variant assignment${variantImageConflicts === 1 ? "" : "s"} matched more than one new image. Shopify CSV supports one Variant Image per variant, so the first image was used as its featured variant image; all chosen images remain product images. Download anyway?`)) return;
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(new Blob(["\uFEFF", csvText(output)], { type: "text/csv;charset=utf-8" }), `shopify-picture-changes-${stamp}.csv`);
}

async function decodeAndConvert(row) {
  const source = await row.entry.getData(new BlobWriter(imageMimeType(row.filename)));
  let decoded;
  try { decoded = await decodeImage(source); }
  catch { throw new Error("This image format cannot be decoded by this browser."); }
  const scale = Math.min(1, MAX_DIMENSION / decoded.width, MAX_DIMENSION / decoded.height, Math.sqrt(MAX_PIXELS / (decoded.width * decoded.height)));
  const width = Math.max(1, Math.floor(decoded.width * scale));
  const height = Math.max(1, Math.floor(decoded.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#fff"; context.fillRect(0, 0, width, height);
  context.drawImage(decoded.source, 0, 0, width, height);
  decoded.close();
  let quality = 0.9, output;
  do {
    output = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    quality -= 0.08;
  } while (output && output.size >= MAX_OUTPUT_BYTES && quality >= 0.5);
  canvas.width = canvas.height = 1;
  if (!output || output.size >= 20 * 1024 ** 2) throw new Error("Could not reduce this image below Shopify's 20 MB limit.");
  return output;
}

async function uploadTarget(target, blob, filename) {
  const form = new FormData();
  for (const parameter of target.parameters) form.append(parameter.name, parameter.value);
  form.append("file", blob, filename);
  const response = await fetch(target.url, { method: "POST", body: form });
  if (!response.ok) throw new Error(`Direct upload failed (${response.status}).`);
}

async function uploadAll() {
  if (state.running || DEMO_MODE) return;
  const queue = selectedUploadRows();
  if (!queue.length) return;
  const conflicting = conflictingReplacement(queue);
  if (conflicting) {
    const handle = conflicting[0].suggestions.find((item) => item.id === conflicting[0].selectedId)?.handle || "the same product";
    alert(`${handle} has multiple images selected and at least one is set to Replace. Use Add for all of them, or keep only one Replace row, to avoid deleting another image from this job.`);
    return;
  }
  const replacements = queue.filter((row) => row.decision === "replace").length;
  if (replacements && !confirm(`Replace will permanently delete all existing Shopify images from ${replacements} matched product${replacements === 1 ? "" : "s"} after each new image is attached. Continue?`)) return;
  state.running = true; render();
  $("#working").classList.remove("hidden", "error-card");
  try {
    for (let index = 0; index < queue.length; index++) {
      const row = queue[index];
      row.uploadStatus = "processing"; row.error = ""; refreshRow(row);
      setWorking("Processing and uploading", `${index + 1} of ${queue.length}: ${row.filename}`, 100 * index / queue.length);
      try {
        const blob = await decodeAndConvert(row);
        const safeName = row.filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 150) + ".jpg";
        const { targets } = await api("/api/staged-uploads", { method: "POST", body: JSON.stringify({ files: [{ filename: safeName, size: blob.size }] }) });
        await uploadTarget(targets[0], blob, safeName);
        await api("/api/attach-image", { method: "POST", body: JSON.stringify({ product_id: row.selectedId, variant_ids: row.selectedVariantIds, resource_url: targets[0].resourceUrl, alt: row.filename.replace(/\.[^.]+$/, ""), mode: row.decision }) });
        row.uploadStatus = "uploaded";
      } catch (error) {
        row.uploadStatus = "failed"; row.error = error.message;
      }
      persistManifest(); refreshRow(row);
    }
    setWorking("Upload complete", "Review any failed rows and retry when ready.", 100);
  } finally {
    state.running = false; render();
  }
}

function persistManifest() {
  const manifest = state.rows.map(({ archive, filename, matchStatus, selectedId, uploadStatus, decision, error }) => ({ archive, filename, matchStatus, selectedId, uploadStatus, decision, error }));
  localStorage.setItem("shopify-image-matcher:last-job", JSON.stringify({ updatedAt: new Date().toISOString(), manifest }));
}

function restoreManifest() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem("shopify-image-matcher:last-job")); }
  catch { return; }
  const previous = new Map((saved?.manifest || []).map((row) => [`${row.archive}\u0000${row.filename}`, row]));
  for (const row of state.rows) {
    if (row.isDuplicate || row.isAlreadyOnShopify) continue;
    const old = previous.get(`${row.archive}\u0000${row.filename}`);
    if (!old) continue;
    row.selectedId = typeof old.selectedId === "string" ? old.selectedId : row.selectedId;
    row.uploadStatus = old.uploadStatus || row.uploadStatus;
    row.decision = ["add", "replace", "do_not_upload"].includes(old.decision)
      ? old.decision
      : old.userExcluded ? "do_not_upload" : row.decision;
    if (!row.selectedId) row.decision = "do_not_upload";
    row.error = old.error || "";
  }
}

async function reset() {
  for (const reader of state.readers) await reader.close().catch(() => {});
  localStorage.removeItem("shopify-image-matcher:last-job");
  location.reload();
}

$("#archive").addEventListener("change", (event) => selectFiles(event.target.files));
$("#catalog").addEventListener("change", (event) => { state.catalogFile = event.target.files[0] || null; });
$("#public-image-csv").addEventListener("change", async (event) => {
  state.publicImageUrls = new Map();
  const file = event.target.files[0];
  if (!file) {
    $("#public-image-summary").textContent = "No public image URL CSV selected";
    renderSummary();
    return;
  }
  try {
    const count = await loadPublicImageUrls(file);
    $("#public-image-summary").textContent = `${count.toLocaleString()} public image URL${count === 1 ? "" : "s"} loaded`;
  } catch (error) {
    $("#public-image-summary").textContent = error.message;
  }
  renderSummary();
});
$("#dropzone").addEventListener("dragover", (event) => { event.preventDefault(); event.currentTarget.classList.add("dragging"); });
$("#dropzone").addEventListener("dragleave", (event) => event.currentTarget.classList.remove("dragging"));
$("#dropzone").addEventListener("drop", (event) => { event.preventDefault(); event.currentTarget.classList.remove("dragging"); selectFiles(event.dataTransfer.files); });
$("#analyse").addEventListener("click", analyse);
$("#upload").addEventListener("click", uploadAll);
$("#download-shopify-csv").addEventListener("click", () => downloadShopifyCsv().catch((error) => alert(error.message)));
$("#reset").addEventListener("click", reset);
document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
  button.classList.add("active"); state.filter = button.dataset.filter; render();
}));
