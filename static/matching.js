export function normalize(value) {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}

export function filenameKeys(filename) {
  const stem = filename.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const withoutPhotoSuffix = stem.replace(/(?:[-_\s]+(?:front|back|side|detail|main|hero|image|img|photo|\d+|[a-z]))+$/i, "");
  return [...new Set([normalize(stem), normalize(withoutPhotoSuffix)].filter(Boolean))];
}

export function parseProductCode(value) {
  const stem = value.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").trim();
  const match = stem.match(/^([a-z]+)[\s_-]*0*(\d+)(.*)$/i);
  if (!match) return null;
  return {
    category: match[1].toUpperCase(),
    number: match[2].replace(/^0+(?=\d)/, ""),
    extra: normalize(match[3]),
  };
}

export function productCodeKey(code) {
  return code ? `${code.category}|${code.number}` : "";
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
