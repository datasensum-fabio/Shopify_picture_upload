import assert from "node:assert/strict";
import { applyReplacementResolution, replacementConflictGroups } from "../static/decision-conflicts.js";

const rows = [
  { id: "one", selectedId: "product-a", decision: "replace" },
  { id: "two", selectedId: "product-a", decision: "add" },
  { id: "three", selectedId: "product-b", decision: "add" },
];

const conflicts = replacementConflictGroups(rows);
assert.equal(conflicts.length, 1);
assert.deepEqual(conflicts[0].map((row) => row.id), ["one", "two"]);

applyReplacementResolution(conflicts[0], "two");
assert.equal(rows[0].decision, "do_not_upload");
assert.equal(rows[1].decision, "replace");

rows[0].decision = "replace";
rows[1].decision = "add";
applyReplacementResolution(conflicts[0], "all_add");
assert.equal(rows[0].decision, "add");
assert.equal(rows[1].decision, "add");

console.log("Replacement conflict decision tests passed.");
