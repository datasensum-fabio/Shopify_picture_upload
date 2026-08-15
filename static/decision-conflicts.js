export function replacementConflictGroups(rows) {
  const byProduct = new Map();
  for (const row of rows) {
    if (!byProduct.has(row.selectedId)) byProduct.set(row.selectedId, []);
    byProduct.get(row.selectedId).push(row);
  }
  return [...byProduct.values()].filter((group) =>
    group.length > 1 && group.some((row) => row.decision === "replace"));
}

export function applyReplacementResolution(rows, selectedRowId) {
  for (const row of rows) {
    row.decision = selectedRowId === "all_add"
      ? "add"
      : row.id === selectedRowId ? "replace" : "do_not_upload";
  }
}
