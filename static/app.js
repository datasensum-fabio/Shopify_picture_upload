import { BlobReader, BlobWriter, ZipReader } from "https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.8.2/+esm";
import { detectMetal, detectMetalInValues, filenameKeys, normalize, parseProductCode, productCodeKey, sha256Hex, similarity } from "./matching.js";

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

const $ = (selector) => document.querySelector(selector);
const state = { files: [], catalogFile: null, readers: [], products: [], exactIndex: new Map(), codeIndex: new Map(), rows: [], running: false, filter: "all" };

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

async function loadCsvCatalog(file) {
  const records = parseCsv((await file.text()).replace(/^\uFEFF/, ""));
  if (records.length < 2) throw new Error("The Shopify CSV is empty.");
  const headers = records[0].map((value) => value.trim());
  const column = (name) => headers.indexOf(name);
  const handleColumn = column("Handle"), titleColumn = column("Title");
  const skuColumn = column("Variant SKU"), barcodeColumn = column("Variant Barcode");
  const variantIdColumn = column("Variant ID");
  const optionColumns = [1, 2, 3].map((number) => ({ name: column(`Option${number} Name`), value: column(`Option${number} Value`) }));
  if (handleColumn < 0 || titleColumn < 0) throw new Error('The product CSV must contain the Shopify columns "Handle" and "Title".');
  const products = new Map();
  for (const values of records.slice(1)) {
    const handle = (values[handleColumn] || "").trim();
    if (!handle) continue;
    if (!products.has(handle)) products.set(handle, {
      id: `csv://Product/${encodeURIComponent(handle)}`,
      title: (values[titleColumn] || handle).trim(), handle, status: "ACTIVE", variants: { nodes: [] },
    });
    const sku = skuColumn >= 0 ? (values[skuColumn] || "").trim() : "";
    const barcode = barcodeColumn >= 0 ? (values[barcodeColumn] || "").trim() : "";
    const selectedOptions = optionColumns.filter((item) => item.name >= 0 && item.value >= 0 && values[item.value]).map((item) => ({
      name: values[item.name] || "Option", value: values[item.value],
    }));
    const metal = detectMetalInValues([...selectedOptions.map((item) => item.value), sku]);
    const variantIndex = products.get(handle).variants.nodes.length + 1;
    products.get(handle).variants.nodes.push({
      id: variantIdColumn >= 0 && values[variantIdColumn] ? values[variantIdColumn] : `csv://Variant/${encodeURIComponent(handle)}/${variantIndex}`,
      title: selectedOptions.map((item) => item.value).join(" / ") || sku || `Variant ${variantIndex}`,
      sku, barcode, selectedOptions, metal,
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
    state.products = state.catalogFile ? await loadCsvCatalog(state.catalogFile) : await loadCatalog();
    buildCatalogIndex();
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
        const imageHash = await sha256Hex(await entry.getData(new BlobWriter()));
        const duplicateOf = seenHashes.get(imageHash) || null;
        if (!duplicateOf) seenHashes.set(imageHash, { archive: file.name, filename: entry.filename.replace(/^.*[\\/]/, "") });
        const suggestions = rankProducts(entry.filename);
        const pictureMetal = detectMetal(entry.filename);
        const matchStatus = classify(suggestions, pictureMetal);
        state.rows.push({
          id: `${fileIndex}:${entry.index ?? state.rows.length}`,
          fileIndex, entry, filename: entry.filename.replace(/^.*[\\/]/, ""),
          archive: file.name, suggestions, matchStatus, imageHash, duplicateOf, isDuplicate: Boolean(duplicateOf),
          selectedId: !duplicateOf && matchStatus === "auto_approved" ? suggestions[0].id : "",
          pictureMetal,
          selectedVariantIds: !duplicateOf && matchStatus === "auto_approved" ? suggestions[0].variant_ids : [],
          uploadStatus: duplicateOf ? "duplicate" : "pending", error: "",
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
    if (state.filter !== "all" && row.matchStatus !== state.filter && row.uploadStatus !== state.filter && !(state.filter === "duplicate" && row.isDuplicate)) continue;
    const fragment = $("#row-template").content.cloneNode(true);
    const tr = fragment.querySelector("tr");
    tr.dataset.id = row.id;
    fragment.querySelector(".filename").textContent = row.filename;
    fragment.querySelector(".archive-name").textContent = row.archive;
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
      option.textContent = `${product.title} — ${product.matched_on}: ${product.matched_value} (${product.score}%)`;
      option.selected = product.id === row.selectedId;
      select.append(option);
    }
    select.disabled = row.isDuplicate || row.uploadStatus === "uploaded" || state.running;
    select.addEventListener("change", () => {
      row.selectedId = select.value;
      if (select.value && row.matchStatus === "no_match") row.matchStatus = "needs_review";
      handle.textContent = row.suggestions.find((item) => item.id === select.value)?.handle || "—";
      updateMetalMatch();
      persistManifest(); renderSummary();
    });
    const top = row.suggestions[0];
    const score = fragment.querySelector(".score");
    score.textContent = top ? `${top.score}%` : "—";
    score.className = `score ${row.matchStatus}`;
    fragment.querySelector(".matched-on").textContent = top ? `${top.matched_on}: ${top.matched_value}` : "No candidate";
    const badge = fragment.querySelector(".match-status");
    badge.textContent = row.isDuplicate ? "duplicate" : row.matchStatus.replace("_", " ");
    badge.className = `match-status ${row.isDuplicate ? "duplicate" : row.matchStatus}`;
    fragment.querySelector(".upload-status").textContent = row.isDuplicate
      ? `Same SHA-256 as ${row.duplicateOf.archive} / ${row.duplicateOf.filename}`
      : row.uploadStatus === "pending" ? "" : row.uploadStatus;
    fragment.querySelector(".row-error").textContent = row.error;
    tbody.append(fragment);
  }
  renderSummary();
}

function renderSummary() {
  const counts = { auto_approved: 0, needs_review: 0, no_match: 0, duplicate: 0, uploaded: 0, failed: 0 };
  for (const row of state.rows) {
    if (row.isDuplicate) counts.duplicate++;
    else counts[row.matchStatus]++;
    if (counts[row.uploadStatus] !== undefined && row.uploadStatus !== "duplicate") counts[row.uploadStatus]++;
  }
  $("#summary").innerHTML = `<div><strong>${counts.auto_approved}</strong><small>automatic</small></div><div><strong>${counts.needs_review}</strong><small>review</small></div><div><strong>${counts.no_match}</strong><small>unmatched</small></div><div><strong>${counts.duplicate}</strong><small>duplicates</small></div><div><strong>${counts.uploaded}</strong><small>uploaded</small></div>`;
  const selected = state.rows.filter((row) => !row.isDuplicate && row.selectedId && row.uploadStatus !== "uploaded").length;
  $("#upload-count").textContent = `${selected} image${selected === 1 ? "" : "s"} selected`;
  $("#upload").disabled = DEMO_MODE || !selected || state.running;
}

function refreshRow(row) {
  const tr = [...document.querySelectorAll("#rows tr")].find((item) => item.dataset.id === row.id);
  if (tr) {
    tr.querySelector(".upload-status").textContent = row.uploadStatus === "pending" ? "" : row.uploadStatus;
    tr.querySelector(".row-error").textContent = row.error;
  }
  renderSummary();
}

async function decodeAndConvert(row) {
  const source = await row.entry.getData(new BlobWriter());
  let bitmap;
  try { bitmap = await createImageBitmap(source, { imageOrientation: "from-image" }); }
  catch { throw new Error("This image format cannot be decoded by this browser."); }
  const scale = Math.min(1, MAX_DIMENSION / bitmap.width, MAX_DIMENSION / bitmap.height, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));
  const width = Math.max(1, Math.floor(bitmap.width * scale));
  const height = Math.max(1, Math.floor(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#fff"; context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
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
  const queue = state.rows.filter((row) => !row.isDuplicate && row.selectedId && row.uploadStatus !== "uploaded");
  if (!queue.length) return;
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
        await api("/api/attach-image", { method: "POST", body: JSON.stringify({ product_id: row.selectedId, variant_ids: row.selectedVariantIds, resource_url: targets[0].resourceUrl, alt: row.filename.replace(/\.[^.]+$/, "") }) });
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
  const manifest = state.rows.map(({ archive, filename, matchStatus, selectedId, uploadStatus, error }) => ({ archive, filename, matchStatus, selectedId, uploadStatus, error }));
  localStorage.setItem("shopify-image-matcher:last-job", JSON.stringify({ updatedAt: new Date().toISOString(), manifest }));
}

function restoreManifest() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem("shopify-image-matcher:last-job")); }
  catch { return; }
  const previous = new Map((saved?.manifest || []).map((row) => [`${row.archive}\u0000${row.filename}`, row]));
  for (const row of state.rows) {
    if (row.isDuplicate) continue;
    const old = previous.get(`${row.archive}\u0000${row.filename}`);
    if (!old) continue;
    row.selectedId = old.selectedId || row.selectedId;
    row.uploadStatus = old.uploadStatus || row.uploadStatus;
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
$("#dropzone").addEventListener("dragover", (event) => { event.preventDefault(); event.currentTarget.classList.add("dragging"); });
$("#dropzone").addEventListener("dragleave", (event) => event.currentTarget.classList.remove("dragging"));
$("#dropzone").addEventListener("drop", (event) => { event.preventDefault(); event.currentTarget.classList.remove("dragging"); selectFiles(event.dataTransfer.files); });
$("#analyse").addEventListener("click", analyse);
$("#upload").addEventListener("click", uploadAll);
$("#reset").addEventListener("click", reset);
document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
  button.classList.add("active"); state.filter = button.dataset.filter; render();
}));
