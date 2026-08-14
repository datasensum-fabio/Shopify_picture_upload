export function normalize(value) {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

export function cleanFilename(value) {
  let stem = value.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").trim();
  let previous;
  do {
    previous = stem;
    stem = stem.replace(/(?:\s*\(\d+\)|[\s_-]+\d+)\s*$/i, "").trim();
  } while (stem !== previous);
  return stem;
}

export function filenameKeys(filename) {
  const stem = cleanFilename(filename);
  const withoutPhotoSuffix = stem.replace(/(?:[-_\s]+(?:front|back|side|detail|main|hero|image|img|photo|\d+|[a-z]))+$/i, "");
  return [...new Set([normalize(stem), normalize(withoutPhotoSuffix)].filter(Boolean))];
}

export function parseProductCode(value) {
  const stem = cleanFilename(value);
  const match = stem.match(/^([a-z]+)[\s_-]*0*(\d+)(.*)$/i);
  if (!match) return null;
  const metal = detectMetal(stem);
  let attached = match[3].match(/^([a-z0-9]+)/i)?.[1] || "";
  if (metal) {
    const normalizedAttached = normalize(attached);
    if (normalizedAttached.endsWith(metal.matchedKey)) {
      attached = normalizedAttached.slice(0, -metal.matchedKey.length);
    }
  }
  const extra = normalize(attached.match(/^([a-z]+)/i)?.[1] || "");
  return {
    category: match[1].toUpperCase(),
    number: match[2].replace(/^0+(?=\d)/, ""),
    extra: normalize(extra),
  };
}

export function productCodeKey(code) {
  return code ? `${code.category}|${code.number}` : "";
}

export const METALS = [
  ["SILVER/OXIDISED", "SILVER-OXIDISED"],
  ["SILVER/YELLOW", "SILVER-YELLOW"],
  ["SILVER/ROSE", "SILVER-ROSE COLOURED"],
  ["9CT/SILVER", "9CT/SILVER"],
  ["GPS R", "GOLD PLATED SILVER - ROSE COLOUR"],
  ["HGP Y9", "HGP Y9"],
  ["RYW9", "9CT RED YELLOW AND WHITE GOLD"],
  ["WY14", "14CT WHITE AND YELLOW GOLD"],
  ["YW14", "14CT YELLOW AND WHITE GOLD"],
  ["GF R", "GOLD FILLED ROSE"],
  ["STEEL", "STEEL"],
  ["W18", "18CT White Gold"],
  ["Y18", "18CT Yellow Gold"],
  ["WY9", "9CT WHITE AND YELLOW GOLD"],
  ["YW9", "9CT YELLOW AND WHITE GOLD"],
  ["W14", "14CT White Gold"],
  ["Y14", "14CT Yellow Gold"],
  ["Y10", "10CT Yellow Gold"],
  ["R9", "9CT Rose Gold"],
  ["W9", "9CT White Gold"],
  ["Y9", "9CT Yellow Gold"],
  ["GF", "GOLD FILLED"],
  ["SIL", "SILVER"],
];

const METAL_ALIASES = METALS.flatMap(([code, description]) => [
  { code, description, key: normalize(code) },
  { code, description, key: normalize(description) },
]).sort((a, b) => b.key.length - a.key.length);

const METAL_CODE_TOKENS = METALS.map(([code, description]) => ({
  code,
  description,
  key: normalize(code),
  pattern: new RegExp(`(?:^|[\\s_-])${code.split("").map((char) => {
    if (/\s/.test(char)) return "[\\s_-]+";
    return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("")}(?=$|[\\s_-])`, "i"),
})).sort((a, b) => b.key.length - a.key.length);

export function detectMetal(value) {
  let cleaned = value.replace(/\.[^.]+$/, "").trim();
  let previous;
  do {
    previous = cleaned;
    cleaned = cleaned.replace(/(?:\s*\(\d+\)|[\s_-]+\d+)\s*$/i, "").trim();
  } while (cleaned !== previous);
  const normalized = normalize(cleaned);
  for (const metal of METAL_ALIASES) {
    if (normalized.endsWith(metal.key)) return { code: metal.code, description: metal.description, matchedKey: metal.key };
  }
  for (const metal of METAL_CODE_TOKENS) {
    if (metal.pattern.test(cleaned)) return { code: metal.code, description: metal.description, matchedKey: metal.key };
  }
  return null;
}

export function detectMetalInValues(values) {
  for (const value of values) {
    const metal = detectMetal(String(value || ""));
    if (metal) return metal;
  }
  return null;
}

export async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function visualFingerprintsMatch(left, right, maxPixelDelta = 6, maxHashDistance = 2) {
  if (!left?.pixels?.length || left.pixels.length !== right?.pixels?.length || left.hash?.length !== right?.hash?.length) return false;
  let pixelDelta = 0;
  for (let index = 0; index < left.pixels.length; index++) pixelDelta += Math.abs(left.pixels[index] - right.pixels[index]);
  let hashDistance = 0;
  for (let index = 0; index < left.hash.length; index++) hashDistance += left.hash[index] === right.hash[index] ? 0 : 1;
  return pixelDelta / left.pixels.length <= maxPixelDelta && hashDistance <= maxHashDistance;
}

export function levenshtein(a, b) {
  if (a.length > b.length) [a, b] = [b, a];
  let previous = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    const current = [j];
    for (let i = 1; i <= a.length; i++) {
      current[i] = Math.min(current[i - 1] + 1, previous[i] + 1, previous[i - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[a.length];
}

export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;
  const edit = 100 * (1 - levenshtein(a, b) / Math.max(a.length, b.length));
  const contained = (a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 5
    ? 88 + 8 * Math.min(a.length, b.length) / Math.max(a.length, b.length)
    : 0;
  return Math.max(edit, contained);
}
